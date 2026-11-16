/**
 * The display page: what a screen opens (`/d/<display id>`), full screen and
 * unattended. It shows the display's layouts in turn, follows changes pushed
 * by the server, and keeps showing the last known content when the network
 * or the server goes away.
 *
 * `/p/<layout id>` previews a single layout for a signed-in admin.
 */
import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import { inSchedule, parseTime, zoned } from "../shared/time";
import {
	type AnyEl,
	type ColorMode,
	DEFAULT_DISPLAY_SETTINGS,
	DEFAULT_GENERAL_SETTINGS,
	type ElementData,
	type Layout,
	type ViewPayload,
} from "../shared/types";
import { Canvas } from "./display/Canvas";
import { type DisplayEnv, useMinute } from "./display/context";
import { api, url } from "./lib/api";

const segments = location.pathname.split("/").filter(Boolean);
const id = segments.at(-1) ?? "";
const preview = segments.at(-2) === "p";
const query = new URLSearchParams(location.search);
const CACHE_KEY = `sidedisplay:${id}`;
const RETRY_MIN = 3000;
const RETRY_MAX = 120_000;

function App() {
	const [view, setView] = createStore<{ payload: ViewPayload | null }>({ payload: null });
	const [status, setStatus] = createSignal<"loading" | "ready" | "missing" | "offline">("loading");
	const [connected, setConnected] = createSignal(true);
	const [identify, setIdentify] = createSignal(false);
	const [refreshKey, setRefreshKey] = createSignal(0);
	const minute = useMinute();

	const apply = (payload: ViewPayload) => {
		// Reconciling by id keeps elements mounted across updates: a clock does
		// not restart and a video keeps playing when something else is edited.
		setView("payload", reconcile(payload, { key: "id", merge: true }));
		setStatus("ready");
	};

	async function load(): Promise<boolean> {
		try {
			let payload: ViewPayload;
			if (preview) {
				const layout = await api<Layout>(`api/layouts/${id}`);
				payload = {
					display: { id, name: layout.name, settings: DEFAULT_DISPLAY_SETTINGS },
					entries: [{ seconds: 3600, days: [], from: "", to: "", layout }],
					general: (await api<{ general: ViewPayload["general"] }>("api/settings")).general,
					version: "",
				};
			} else {
				payload = await api<ViewPayload>(`api/view/${id}`);
				try {
					localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
				} catch {}
			}
			apply(payload);
			return true;
		} catch (err) {
			const code = (err as { status?: number }).status;
			if (code === 404 || code === 401) {
				// A definite "no such display" replaces whatever was cached.
				localStorage.removeItem(CACHE_KEY);
				setView("payload", null);
				setStatus("missing");
			} else if (!view.payload) {
				// Server unreachable at boot: fall back to the last content this screen showed.
				try {
					const cached = localStorage.getItem(CACHE_KEY);
					if (cached) apply(JSON.parse(cached) as ViewPayload);
					else setStatus("offline");
				} catch {
					setStatus("offline");
				}
			}
			return false;
		}
	}

	// ---------------------------------------------------------------- stream
	const entityListeners = new Set<(ids: string[]) => void>();
	let source: EventSource | undefined;
	let retry = RETRY_MIN;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let version: string | undefined;

	function connect() {
		clearTimeout(retryTimer);
		source?.close();
		if (preview) return;
		const stream = new EventSource(url(`api/view/${id}/stream`));
		source = stream;
		stream.addEventListener("connected", (event) => {
			retry = RETRY_MIN;
			setConnected(true);
			// A new server version means a new client: reload to get it.
			const next = (JSON.parse((event as MessageEvent).data) as { version?: string }).version;
			if (version && next && next !== version) return location.reload();
			version = next;
			// Anything may have changed while we were away.
			void load().then(() => setRefreshKey((k) => k + 1));
		});
		stream.addEventListener("update", () => void load());
		stream.addEventListener("reload", () => location.reload());
		stream.addEventListener("identify", () => {
			setIdentify(true);
			setTimeout(() => setIdentify(false), 8000);
		});
		stream.addEventListener("entities", (event) => {
			const ids = JSON.parse((event as MessageEvent).data) as string[];
			for (const listener of entityListeners) listener(ids);
		});
		stream.onerror = () => {
			stream.close();
			setConnected(false);
			retryTimer = setTimeout(connect, retry);
			retry = Math.min(retry * 2, RETRY_MAX);
			void load();
		};
	}

	onMount(() => {
		void load();
		connect();
		// Back online: do not wait out the current back-off.
		const online = () => {
			retry = RETRY_MIN;
			if (source?.readyState !== EventSource.OPEN) connect();
		};
		window.addEventListener("online", online);
		// Safety net for a stream that died without an error (a buffering proxy).
		const poll = setInterval(load, 5 * 60_000);
		// Keep tablets and phones from sleeping, where the browser allows it.
		const wake = () =>
			void (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<unknown> } }).wakeLock
				?.request("screen")
				.catch(() => {});
		wake();
		document.addEventListener("visibilitychange", wake);
		onCleanup(() => {
			window.removeEventListener("online", online);
			document.removeEventListener("visibilitychange", wake);
			clearInterval(poll);
			clearTimeout(retryTimer);
			source?.close();
		});
	});

	// -------------------------------------------------------------- settings
	const settings = () => view.payload?.display.settings ?? DEFAULT_DISPLAY_SETTINGS;
	const general = () => view.payload?.general ?? DEFAULT_GENERAL_SETTINGS;
	// `?mode=mono` forces a colour mode, handy to try ePaper rendering on a laptop.
	const forcedMode = query.get("mode") as ColorMode | null;
	const mode = (): ColorMode =>
		forcedMode && ["full", "gray", "mono", "color6"].includes(forcedMode) ? forcedMode : settings().colorMode;
	const lowColor = () => mode() !== "full";
	const now = createMemo(() => zoned(minute(), general().timezone));

	// -------------------------------------------------------------- playlist
	// Entries whose schedule matches now; if none does, show them all rather than a blank screen.
	const active = createMemo(() => {
		const entries = view.payload?.entries ?? [];
		const scheduled = entries.filter((e) => inSchedule(now(), e.days, e.from, e.to));
		return scheduled.length ? scheduled : entries;
	});
	const [index, setIndex] = createSignal(0);
	// Restart the rotation only when the set of layouts or their durations change,
	// not on every content update.
	const rotation = createMemo(() =>
		active()
			.map((e) => `${e.layout.id}:${e.seconds}`)
			.join("|"),
	);
	createEffect(
		on(rotation, () => {
			setIndex(0);
			let timer: ReturnType<typeof setTimeout>;
			const schedule = () => {
				const list = active();
				if (list.length <= 1) return;
				timer = setTimeout(
					() => {
						setIndex((i) => (i + 1) % list.length);
						schedule();
					},
					Math.max(3, list[index() % list.length]?.seconds ?? 30) * 1000,
				);
			};
			schedule();
			onCleanup(() => clearTimeout(timer));
		}),
	);
	const current = () => active()[index() % Math.max(1, active().length)];
	const currentId = createMemo(() => current()?.layout.id);

	// ------------------------------------------------------- screen care
	const dimmed = createMemo(() => {
		const s = settings();
		return parseTime(s.dimFrom) !== null && parseTime(s.dimTo) !== null && inSchedule(now(), [], s.dimFrom, s.dimTo);
	});
	const shift = createMemo(() => {
		if (!settings().pixelShift || lowColor()) return "none";
		const step = Math.floor(minute() / 60_000) % 8;
		const offsets = [
			[0, 0],
			[4, 0],
			[4, 4],
			[0, 4],
			[-4, 4],
			[-4, 0],
			[-4, -4],
			[0, -4],
		] as const;
		return `translate(${offsets[step]![0]}px, ${offsets[step]![1]}px)`;
	});
	createEffect(
		on(minute, () => {
			const at = parseTime(settings().reloadAt);
			if (at === null || now().minutes !== at) return;
			// Once per day, even if this effect runs twice within the minute.
			if (sessionStorage.getItem("sidedisplay:reloaded") === now().date) return;
			sessionStorage.setItem("sidedisplay:reloaded", now().date);
			location.reload();
		}),
	);

	const env: DisplayEnv = {
		mode,
		invert: () => (query.has("invert") ? query.get("invert") !== "0" : settings().invert),
		general,
		editing: false,
		refreshKey,
		loadData: (el: AnyEl, signal) =>
			preview
				? api<ElementData>("api/preview/data", { body: { element: el }, signal })
				: api<ElementData>(`api/view/${id}/data/${el.id}`, { signal }),
		pictureUrl: async (el) => {
			if (!preview) return url(`api/view/${id}/picture/${el.id}?t=${Date.now()}`);
			const response = await fetch(url("api/preview/picture"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ element: el }),
			});
			if (!response.ok) throw new Error("no picture");
			return URL.createObjectURL(await response.blob());
		},
		onEntities: (listener) => {
			entityListeners.add(listener);
			return () => entityListeners.delete(listener);
		},
	};

	createEffect(() => {
		document.title = view.payload ? `${view.payload.display.name} · SideDisplay` : "SideDisplay";
	});

	const message = () => {
		if (status() === "missing")
			return [
				"Display not found",
				preview
					? "Sign in to SideDisplay in this browser to preview layouts."
					: "Check the address, or create the display again in SideDisplay.",
			];
		if (status() === "offline") return ["Connecting…", "Waiting for the SideDisplay server."];
		if (status() === "ready" && !current())
			return [view.payload?.display.name ?? "", "No layout is assigned to this display yet."];
		return null;
	};

	return (
		<div class="kiosk" data-rotation={settings().rotation} style={{ transform: shift() }}>
			<Show when={currentId()} keyed>
				<div class="kiosk-layer" data-transition={lowColor() ? "none" : settings().transition}>
					<Show when={current()}>
						{(entry) => <Canvas settings={entry().layout.settings} elements={entry().layout.elements} env={env} />}
					</Show>
				</div>
			</Show>
			<Show when={message()}>
				{(text) => (
					<div class="kiosk-message" data-paper={lowColor() ? "" : undefined}>
						<strong>{text()[0]}</strong>
						<span>{text()[1]}</span>
					</div>
				)}
			</Show>
			<div class="kiosk-dim" style={{ opacity: dimmed() && !lowColor() ? String(settings().dimLevel / 100) : "0" }} />
			<Show when={!connected() && settings().offlineBadge && status() === "ready" && !lowColor()}>
				<div class="kiosk-offline">Offline</div>
			</Show>
			<Show when={identify()}>
				<div class="kiosk-identify">
					{view.payload?.display.name}
					<small>{location.host}</small>
				</div>
			</Show>
		</div>
	);
}

render(() => <App />, document.getElementById("root")!);
