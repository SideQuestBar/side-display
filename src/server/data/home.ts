/**
 * Server side of the Home Assistant elements that need more than one entity
 * state: history (graphs, trends, the day's range), the energy card, presence,
 * alerts, and the pictures and camera streams proxied for them.
 */
import type { AlertsData, EnergyData, EntityData, EntityStats, GraphData, PresenceData } from "../../shared/data";
import type { El } from "../../shared/elements";
import { zoned } from "../../shared/time";
import type { AnyEl, GeneralSettings, HaEntityState } from "../../shared/types";
import { allStates, connection, entityState, haFetch, haJson, haStream } from "../ha/client";
import { cached } from "./sources";

type Point = [number, number];

const num = (v: unknown): number | null => {
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v !== "string" || !v.trim()) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
};

// ------------------------------------------------------------------ history

/** The numeric history of an entity over the last hours, oldest first. Shared by graphs, trends and day ranges. */
export function entityHistory(entity: string, hours: number): Promise<Point[]> {
	const span = Math.min(168, Math.max(1, Math.ceil(hours)));
	return cached(`ha-history:${entity}:${span}`, 240, async () => {
		const start = new Date(Date.now() - span * 3600_000).toISOString();
		const history = await haJson<{ state: string; last_changed: string }[][]>(
			`/history/period/${start}?filter_entity_id=${encodeURIComponent(entity)}&minimal_response&no_attributes`,
		);
		const series: Point[] = [];
		for (const row of history[0] ?? []) {
			const value = Number.parseFloat(row.state);
			if (Number.isFinite(value)) series.push([Date.parse(row.last_changed), value]);
		}
		return series;
	});
}

/** Screens do not need more points than pixels: thin long histories out. */
export function thin(series: Point[], max = 400): Point[] {
	const step = Math.ceil(series.length / max);
	return step > 1 ? series.filter((_, i) => i % step === 0 || i === series.length - 1) : series;
}

export async function graphData(el: El<"ha-graph">): Promise<GraphData> {
	const state = entityState(el.entity);
	const hours = Math.min(168, Math.max(1, el.hours));
	const extra = el.entities.filter((row) => row?.entity).slice(0, 8);
	const [points, series] = await Promise.all([
		el.entity ? entityHistory(el.entity, hours).then((p) => thin(p)) : [],
		Promise.all(
			extra.map(async (row) => {
				const s = entityState(row.entity);
				return {
					label: row.label || s?.name || row.entity,
					color: row.color ?? "",
					unit: s?.unit ?? "",
					// One entity without history must not blank the others.
					points: await entityHistory(row.entity, hours).then(
						(p) => thin(p),
						() => [] as Point[],
					),
				};
			}),
		),
	]);
	return series.length ? { state, points, series } : { state, points };
}

/**
 * What a value did lately, from its history: what it was `trendMinutes` ago
 * (states hold until the next change, so that is the last point before then)
 * and its range since `dayStart`, the current value included.
 */
export function statsOf(
	points: Point[],
	now: number,
	dayStart: number,
	trendMinutes: number,
	current: number | null,
): EntityStats {
	let past: number | null = null;
	let min: number | null = current;
	let max: number | null = current;
	const before = now - trendMinutes * 60_000;
	for (const [at, value] of points) {
		if (trendMinutes > 0 && at <= before) past = value;
		if (at >= dayStart) {
			min = min === null ? value : Math.min(min, value);
			max = max === null ? value : Math.max(max, value);
		}
	}
	// The history starts with the state at its first instant: good enough when nothing is older.
	if (trendMinutes > 0 && past === null && points.length && points[0]![0] <= before + 5 * 60_000) past = points[0]![1];
	return { past, min, max };
}

/** An entity's state, with its recent history summed up when the element shows a trend or the day's range. */
export async function entityData(
	el: { entity: string; trend: number; dayRange: boolean },
	general: GeneralSettings,
): Promise<EntityData> {
	const state = entityState(el.entity);
	const trend = Math.min(1440, Math.max(0, el.trend));
	if (!state || (!trend && !el.dayRange)) return { state };
	const now = Date.now();
	const local = zoned(now, general.timezone);
	const dayStart = now - (local.minutes * 60 + local.second) * 1000;
	const hours = Math.max(el.dayRange ? (now - dayStart) / 3600_000 : 0, trend / 60) + 0.25;
	try {
		const points = await entityHistory(el.entity, hours);
		const stats = statsOf(points, now, el.dayRange ? dayStart : Number.POSITIVE_INFINITY, trend, num(state.state));
		return { state, stats: el.dayRange ? stats : { past: stats.past, min: null, max: null } };
	} catch {
		// No recorder, or the entity is excluded from it: the value alone is still worth showing.
		return { state };
	}
}

// ------------------------------------------------------------------- energy

/** A power reading in watts, whatever unit the sensor reports. */
export function watts(state: HaEntityState | null): number | null {
	const value = num(state?.state);
	if (value === null) return null;
	const unit = (state?.unit ?? "").trim().toLowerCase();
	// "mW" is milliwatt only in the exact spelling; installations report MW, never mW.
	if (unit === "kw") return value * 1000;
	if (unit === "mw") return value * 1_000_000;
	if (unit === "gw") return value * 1_000_000_000;
	return value;
}

export function energyData(el: El<"ha-energy">): EnergyData {
	const power = (entity: string, invert = false) => {
		const value = entity ? watts(entityState(entity)) : null;
		return value === null ? null : invert ? -value : value;
	};
	const solar = power(el.solarEntity);
	const grid = power(el.gridEntity, el.invertGrid);
	const battery = power(el.batteryEntity, el.invertBattery);
	let home = power(el.homeEntity);
	// What the house uses is what comes in from every side.
	if (home === null && (solar !== null || grid !== null || battery !== null))
		home = Math.max(0, (solar ?? 0) + (grid ?? 0) + (battery ?? 0));
	const totals: EnergyData["totals"] = [];
	for (const [key, entity] of [
		["solar", el.solarTodayEntity],
		["import", el.importTodayEntity],
		["export", el.exportTodayEntity],
		["home", el.homeTodayEntity],
	] as const) {
		const state = entity ? entityState(entity) : null;
		const value = num(state?.state);
		if (state && value !== null) totals.push({ key, value, unit: state.unit || "kWh" });
	}
	return { solar, grid, battery, home, level: el.levelEntity ? num(entityState(el.levelEntity)?.state) : null, totals };
}

// ----------------------------------------------------------------- presence

/** A person's picture as Home Assistant serves it: a path on its own server. */
function picturePath(state: HaEntityState | null): string | null {
	const picture = state?.attributes.entity_picture;
	return typeof picture === "string" && /^\/[^/\\]/.test(picture) ? picture : null;
}

export const presenceData = (el: El<"ha-presence">): PresenceData => ({
	people: el.entities.flatMap((row) => {
		const state = entityState(row?.entity);
		if (!state) return [];
		return [
			{
				entity: state.entity_id,
				name: row.label || state.name,
				state: state.state,
				home: state.state === "home",
				picture: picturePath(state) !== null,
			},
		];
	}),
});

/**
 * The picture of one of the people an element lists; `wanted` picks which,
 * and anything the element does not list is refused, so a display can never
 * be used to fetch other entities' pictures.
 */
export async function presencePicture(el: AnyEl, wanted?: string): Promise<Response | null> {
	const rows = Array.isArray(el.entities) ? (el.entities as { entity?: unknown }[]) : [];
	const listed = rows.map((row) => row?.entity).filter((e): e is string => typeof e === "string" && e !== "");
	const entity = wanted ?? listed[0];
	if (!entity || !listed.includes(entity)) return null;
	const path = picturePath(entityState(entity));
	const conn = connection();
	if (!path || !conn) return null;
	const upstream = await fetch(`${conn.url}${path}`, {
		headers: { authorization: `Bearer ${conn.token}` },
		signal: AbortSignal.timeout(15_000),
	});
	const type = upstream.headers.get("content-type") ?? "";
	if (!upstream.ok || !type.startsWith("image/")) {
		await upstream.body?.cancel();
		return null;
	}
	// Faces change rarely, and a wall of avatars should not refetch on every look.
	return new Response(upstream.body, { headers: { "content-type": type, "cache-control": "private, max-age=300" } });
}

// ------------------------------------------------------------------- alerts

/** Binary sensor classes where "on" means something is wrong, and how to say it. */
const PROBLEM_CLASSES: Record<string, string> = {
	door: "Open",
	window: "Open",
	opening: "Open",
	garage_door: "Open",
	lock: "Unlocked",
	moisture: "Wet",
	smoke: "Detected",
	gas: "Detected",
	carbon_monoxide: "Detected",
	problem: "Problem",
	safety: "Unsafe",
	tamper: "Tampered",
	battery: "Low",
	heat: "Hot",
	cold: "Cold",
};
/** Battery sensors without a threshold of their own alert below this. */
const BATTERY_DEFAULT = 20;

export interface AlertRule {
	states?: string;
	below?: string | number;
	above?: string | number;
}

/**
 * Is the entity in a problem state? Returns how to say so, or null when all is
 * well. Without a rule the defaults apply: unavailable, "on" for the binary
 * sensors that report trouble, and a low level for battery sensors.
 */
export function alertText(state: HaEntityState | null, rule: AlertRule = {}): string | null {
	if (!state) return null;
	const raw = state.state;
	const value = num(raw);
	const reading = () => (state.unit ? `${raw} ${state.unit}` : raw);
	const below = num(rule.below);
	const above = num(rule.above);
	const wanted = (rule.states ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const pretty = () => raw.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
	const binary = state.entity_id.startsWith("binary_sensor.");
	const word = () => (binary && raw === "on" ? (PROBLEM_CLASSES[state.device_class] ?? "On") : pretty());

	if (value !== null && below !== null && value < below) return reading();
	if (value !== null && above !== null && value > above) return reading();
	if (wanted.length) return wanted.includes(raw.toLowerCase()) ? word() : null;
	if (raw === "unavailable") return "Unavailable";
	// Thresholds were given and not crossed: nothing else is assumed.
	if (below !== null || above !== null) return null;
	if (binary) return raw === "on" && state.device_class in PROBLEM_CLASSES ? word() : null;
	if (state.device_class === "battery" && value !== null && value < BATTERY_DEFAULT) return reading();
	return null;
}

export function alertsData(el: El<"ha-alerts">): AlertsData {
	const alerts: AlertsData["alerts"] = [];
	const seen = new Set<string>();
	for (const row of el.entities) {
		if (!row?.entity || seen.has(row.entity)) continue;
		seen.add(row.entity);
		const state = entityState(row.entity);
		const text = alertText(state, row);
		if (state && text !== null)
			alerts.push({
				entity: row.entity,
				label: row.label || state.name,
				text,
				severity: row.severity === "critical" ? "critical" : "warning",
			});
	}
	if (el.batteryBelow > 0) {
		const low = allStates()
			.filter((state) => state.device_class === "battery" && !seen.has(state.entity_id))
			.flatMap((state) => {
				const text = alertText(state, { below: el.batteryBelow });
				// An unavailable battery sensor is usually a device that was put away, not a flat battery.
				return text === null || state.state === "unavailable" ? [] : [{ state, text }];
			})
			.sort((a, b) => (num(a.state.state) ?? -1) - (num(b.state.state) ?? -1));
		for (const { state, text } of low)
			alerts.push({ entity: state.entity_id, label: state.name, text, severity: "warning" });
	}
	// The worst first; rows keep their configured order otherwise.
	alerts.sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical"));
	return { alerts };
}

// ------------------------------------------------------------------ cameras

/** A camera snapshot, for the stream element's fallback and its ePaper form. */
export async function cameraSnapshot(entity: string): Promise<Response | null> {
	if (!entity.startsWith("camera.")) return null;
	const upstream = await haFetch(`/camera_proxy/${entity}`, { headers: { "content-type": "" } });
	return new Response(upstream.body, {
		headers: { "content-type": upstream.headers.get("content-type") ?? "image/jpeg", "cache-control": "no-store" },
	});
}

/**
 * A camera's MJPEG stream, passed through as it comes. Null when the camera
 * has none to offer, which tells the display to fall back to snapshots. The
 * upstream request ends when `signal` aborts (the viewer went away).
 */
export async function cameraStream(entity: string, signal: AbortSignal): Promise<Response | null> {
	if (!/^camera\.[a-z0-9_]+$/.test(entity)) return null;
	const controller = new AbortController();
	signal.addEventListener("abort", () => controller.abort(), { once: true });
	if (signal.aborted) return null;
	let upstream: Response;
	try {
		upstream = await haStream(`/api/camera_proxy_stream/${entity}`, controller.signal);
	} catch {
		return null;
	}
	const type = upstream.headers.get("content-type") ?? "";
	if (!type.toLowerCase().startsWith("multipart/x-mixed-replace") || !upstream.body) {
		controller.abort();
		return null;
	}
	return new Response(upstream.body, {
		headers: {
			// The boundary is part of the type: pass it through untouched.
			"content-type": type,
			"cache-control": "no-store",
			// Reverse proxies (nginx, Home Assistant ingress) must not buffer a stream.
			"x-accel-buffering": "no",
		},
	});
}
