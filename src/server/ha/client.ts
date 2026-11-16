/**
 * Home Assistant connection.
 *
 * A WebSocket keeps a live copy of every entity state (so displays update the
 * moment something changes); REST covers the rest: history, calendars,
 * templates, camera snapshots and services that return data.
 *
 * Connection settings come from, in order: the settings page, the
 * `SIDEDISPLAY_HA_*` variables, then the Supervisor when running as a Home
 * Assistant app (no token to configure there).
 */
import type { HaEntityState, HaStatus } from "../../shared/types";
import { config } from "../config";
import { getSetting } from "../settings";

interface Connection {
	source: HaStatus["source"];
	/** Base URL of the REST API, without the trailing `/api`. */
	url: string;
	wsUrl: string;
	token: string;
}

export function connection(): Connection | null {
	const saved = getSetting("ha");
	const direct = (source: Connection["source"], rawUrl: string, token: string): Connection => {
		const url = rawUrl
			.trim()
			.replace(/\/+$/, "")
			.replace(/\/api$/, "");
		return { source, url, wsUrl: `${url.replace(/^http/, "ws")}/api/websocket`, token: token.trim() };
	};
	if (saved.url && saved.token) return direct("settings", saved.url, saved.token);
	if (config.ha.url && config.ha.token) return direct("env", config.ha.url, config.ha.token);
	if (config.ha.supervisorToken) {
		return {
			source: "supervisor",
			url: "http://supervisor/core",
			wsUrl: "ws://supervisor/core/websocket",
			token: config.ha.supervisorToken,
		};
	}
	return null;
}

interface RawState {
	entity_id: string;
	state: string;
	attributes: Record<string, unknown>;
	last_changed: string;
}

const states = new Map<string, RawState>();
let socket: WebSocket | null = null;
let connected = false;
let version: string | null = null;
let lastError: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 2000;
let generation = 0;

let onChange: (entityIds: string[]) => void = () => {};
/** Registers the listener told which entities changed (batched). */
export const onEntitiesChanged = (listener: typeof onChange) => {
	onChange = listener;
};

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function queueChange(entityId: string) {
	pending.add(entityId);
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		const ids = [...pending];
		pending.clear();
		onChange(ids);
	}, 300);
}

function connect() {
	const conn = connection();
	const mine = ++generation;
	if (!conn) return;
	let ws: WebSocket;
	try {
		ws = new WebSocket(conn.wsUrl);
	} catch (err) {
		lastError = (err as Error).message;
		scheduleRetry();
		return;
	}
	socket = ws;
	ws.onmessage = (message) => {
		if (mine !== generation) return;
		let msg: {
			type: string;
			id?: number;
			ha_version?: string;
			message?: string;
			result?: unknown;
			event?: { data?: { entity_id: string; new_state: RawState | null } };
		};
		try {
			msg = JSON.parse(String(message.data));
		} catch {
			return;
		}
		switch (msg.type) {
			case "auth_required":
				ws.send(JSON.stringify({ type: "auth", access_token: conn.token }));
				break;
			case "auth_invalid":
				lastError = msg.message ?? "access token refused";
				ws.close();
				break;
			case "auth_ok":
				connected = true;
				lastError = null;
				retryMs = 2000;
				version = msg.ha_version ?? null;
				ws.send(JSON.stringify({ id: 1, type: "get_states" }));
				ws.send(JSON.stringify({ id: 2, type: "subscribe_events", event_type: "state_changed" }));
				break;
			case "result":
				if (msg.id === 1 && Array.isArray(msg.result)) {
					states.clear();
					for (const s of msg.result as RawState[]) states.set(s.entity_id, s);
					onChange([...states.keys()]);
				}
				break;
			case "event": {
				const data = msg.event?.data;
				if (!data?.entity_id) break;
				if (data.new_state) states.set(data.entity_id, data.new_state);
				else states.delete(data.entity_id);
				queueChange(data.entity_id);
				break;
			}
		}
	};
	ws.onerror = () => {
		if (mine === generation) lastError ??= "could not reach Home Assistant";
	};
	ws.onclose = () => {
		if (mine !== generation) return;
		connected = false;
		socket = null;
		lastError ??= "connection closed";
		scheduleRetry();
	};
}

function scheduleRetry() {
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = setTimeout(connect, retryMs);
	retryMs = Math.min(retryMs * 2, 60_000);
}

/** (Re)starts the connection: at boot, and whenever the settings change. */
export function startHa() {
	stopHa();
	lastError = null;
	retryMs = 2000;
	connect();
}

export function stopHa() {
	generation++;
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	socket?.close();
	socket = null;
	connected = false;
	states.clear();
}

export function haStatus(): HaStatus {
	const conn = connection();
	return {
		source: conn?.source ?? "none",
		connected,
		version,
		error: conn ? (connected ? null : lastError) : null,
		entities: states.size,
	};
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

function present(raw: RawState): HaEntityState {
	const a = raw.attributes ?? {};
	return {
		entity_id: raw.entity_id,
		state: raw.state,
		name: str(a.friendly_name) || raw.entity_id,
		unit: str(a.unit_of_measurement),
		icon: str(a.icon),
		device_class: str(a.device_class),
		last_changed: raw.last_changed,
		attributes: a,
	};
}

export function entityState(entityId: string | undefined | null): HaEntityState | null {
	const raw = entityId ? states.get(entityId.trim()) : undefined;
	return raw ? present(raw) : null;
}

/** Every entity in full, for elements that scan the whole house (all batteries below a level). */
export const allStates = (): HaEntityState[] => [...states.values()].map(present);

/** Every entity, lightly described, for the editor's pickers. */
export function listEntities(): { entity_id: string; name: string; state: string; unit: string }[] {
	return [...states.values()]
		.map((s) => ({
			entity_id: s.entity_id,
			name: str(s.attributes?.friendly_name) || s.entity_id,
			state: s.state,
			unit: str(s.attributes?.unit_of_measurement),
		}))
		.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
}

export class HaError extends Error {}

/** Calls the REST API. `path` starts after `/api`, e.g. `/states`. */
export async function haFetch(path: string, init: RequestInit = {}, conn = connection()): Promise<Response> {
	if (!conn) throw new HaError("Home Assistant is not configured");
	const response = await fetch(`${conn.url}/api${path}`, {
		...init,
		headers: { authorization: `Bearer ${conn.token}`, "content-type": "application/json", ...init.headers },
		signal: init.signal ?? AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new HaError(`Home Assistant answered ${response.status} for ${path.split("?")[0]}`);
	return response;
}

/**
 * Opens a response that never ends (a camera's MJPEG stream). Only connecting
 * is timed; after that the stream lives until `signal` aborts it.
 */
export async function haStream(path: string, signal: AbortSignal, conn = connection()): Promise<Response> {
	if (!conn) throw new HaError("Home Assistant is not configured");
	const controller = new AbortController();
	const abort = () => controller.abort();
	if (signal.aborted) abort();
	signal.addEventListener("abort", abort, { once: true });
	const connecting = setTimeout(abort, 10_000);
	try {
		const response = await fetch(`${conn.url}${path}`, {
			headers: { authorization: `Bearer ${conn.token}` },
			signal: controller.signal,
		});
		if (!response.ok) {
			abort();
			throw new HaError(`Home Assistant answered ${response.status} for ${path.split("?")[0]}`);
		}
		return response;
	} finally {
		clearTimeout(connecting);
	}
}

export const haJson = async <T>(path: string, init?: RequestInit): Promise<T> =>
	(await haFetch(path, init)).json() as Promise<T>;

/** Calls a service that returns data (forecasts, to-do items…). */
export async function haServiceResponse<T>(domain: string, service: string, data: Record<string, unknown>): Promise<T> {
	const result = await haJson<{ service_response: T }>(`/services/${domain}/${service}?return_response`, {
		method: "POST",
		body: JSON.stringify(data),
	});
	return result.service_response;
}

/** Checks a URL and token without touching the live connection. */
export async function testConnection(url: string, token: string): Promise<{ ok: boolean; message: string }> {
	const base = url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/api$/, "");
	try {
		const response = await fetch(`${base}/api/config`, {
			headers: { authorization: `Bearer ${token.trim()}` },
			signal: AbortSignal.timeout(8000),
		});
		if (response.status === 401) return { ok: false, message: "The access token was refused." };
		if (!response.ok) return { ok: false, message: `Home Assistant answered ${response.status}.` };
		const info = (await response.json()) as { version?: string; location_name?: string };
		return { ok: true, message: `Connected to ${info.location_name ?? "Home Assistant"} (${info.version ?? "?"}).` };
	} catch (err) {
		return { ok: false, message: `Could not reach ${base}: ${(err as Error).message}` };
	}
}
