/**
 * What every element renderer can ask its surroundings: the screen's colour
 * mode, instance settings, and how to reach the server. The display page and
 * the editor preview provide different implementations of the same contract.
 */
import {
	type Accessor,
	createContext,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	on,
	onCleanup,
	useContext,
} from "solid-js";
import { inkColor } from "../../shared/color";
import { definition } from "../../shared/elements";
import type { AnyEl, ColorMode, ElementData, GeneralSettings, LayoutSettings } from "../../shared/types";
import { ELEMENT_COMMON_DEFAULTS } from "../../shared/types";

export interface DisplayEnv {
	mode: Accessor<ColorMode>;
	invert: Accessor<boolean>;
	general: Accessor<GeneralSettings>;
	/** True in the editor preview: elements are selectable and never hidden. */
	editing: boolean;
	/** Editor only: lets an element change its own properties (a map moved by hand). */
	edit?: (id: string, key: string, value: unknown) => void;
	/** Fetches an element's server data. */
	loadData: (el: AnyEl, signal: AbortSignal) => Promise<ElementData>;
	/** URL of an element's Home Assistant picture (camera snapshot, artwork). */
	pictureUrl: (el: AnyEl) => Promise<string>;
	/** Subscribes to "these Home Assistant entities changed". */
	onEntities: (listener: (ids: string[]) => void) => () => void;
	/** Bumped when everything should refetch (reconnection, manual refresh). */
	refreshKey: Accessor<number>;
}

export interface LayoutEnv extends DisplayEnv {
	settings: Accessor<LayoutSettings>;
	lowColor: Accessor<boolean>;
	/** Maps a colour picked in the editor to one the screen can show. */
	ink: (color: string) => string;
}

const Context = createContext<LayoutEnv>();
export const DisplayProvider = Context.Provider;

export function useDisplay(): LayoutEnv {
	const env = useContext(Context);
	if (!env) throw new Error("element rendered outside a display");
	return env;
}

export function layoutEnv(env: DisplayEnv, settings: Accessor<LayoutSettings>): LayoutEnv {
	return {
		...env,
		settings,
		lowColor: () => env.mode() !== "full",
		ink: (color) => inkColor(color, env.mode(), env.invert()),
	};
}

/** What an element inside a carousel knows about its turn. */
export interface Slide {
	/** Whether this element is the one on screen right now. */
	active: Accessor<boolean>;
	/** True when the carousel moves on once this element has played to its end, instead of after a set time. */
	waits: Accessor<boolean>;
	/** Called by an element that plays to an end (a video) when it got there, or failed to play. */
	ended: () => void;
}
const SlideContext = createContext<Slide>();
export const SlideProvider = SlideContext.Provider;
/**
 * Inside a carousel only; undefined everywhere else. Elements that wait their
 * turn stay mounted, so anything that plays uses this to start when it is shown.
 */
export const useSlide = (): Slide | undefined => useContext(SlideContext);

// ---------------------------------------------------------------------- time

const [now, setNow] = createSignal(Date.now());
let ticking = false;
/** The current time, refreshed every second. */
export function useNow(): Accessor<number> {
	if (!ticking) {
		ticking = true;
		// Aligned to the second so several clocks tick together.
		const tick = () => {
			setNow(Date.now());
			setTimeout(tick, 1000 - (Date.now() % 1000));
		};
		tick();
	}
	return now;
}
const minute = createRoot(() => createMemo(() => Math.floor(useNow()() / 60_000) * 60_000));
/** The current time, changing once a minute: cheap to depend on. */
export const useMinute = (): Accessor<number> => minute;

/** `calc()` for a text size in stage pixels, following the layout's text scale. */
export const px = (size: number) => `calc(${size}px * var(--sd-text-scale, 1))`;

// ---------------------------------------------------------------------- data

export interface ElementDataState<T> {
	data: Accessor<T | null>;
	error: Accessor<string | undefined>;
	/** False when the element's Home Assistant condition hides it. */
	show: Accessor<boolean>;
	loaded: Accessor<boolean>;
}

const COMMON_KEYS = new Set(Object.keys(ELEMENT_COMMON_DEFAULTS));

/**
 * Loads an element's server data and keeps it fresh: on a timer, when its
 * configuration changes, and when a Home Assistant entity it uses changes.
 * A failed refresh keeps the last good data on screen.
 */
export function useElementData<T>(
	el: Accessor<AnyEl>,
	entities: Accessor<string[]>,
	enabled: Accessor<boolean>,
): ElementDataState<T> {
	const env = useDisplay();
	const [data, setData] = createSignal<T | null>(null);
	const [error, setError] = createSignal<string>();
	const [show, setShow] = createSignal(true);
	const [loaded, setLoaded] = createSignal(false);
	let controller: AbortController | undefined;

	const load = async () => {
		controller?.abort();
		if (!enabled()) {
			setShow(true);
			return;
		}
		controller = new AbortController();
		const { signal } = controller;
		try {
			const result = await env.loadData(el(), signal);
			if (signal.aborted) return;
			setShow(result.show);
			if (result.error) setError(result.error);
			else {
				setError(undefined);
				setData(() => result.data as T | null);
			}
			setLoaded(true);
		} catch (err) {
			if (signal.aborted) return;
			// Offline or server restarting: keep what is on screen.
			if (!loaded()) setError((err as Error).message);
		}
	};

	// Everything that should trigger a reload: the element's own properties
	// (not where it sits or how its box looks) and the refresh key.
	const signature = createMemo(() => {
		const e = el();
		const own = Object.keys(e).filter((k) => !COMMON_KEYS.has(k) && k !== "id");
		const condition = [e.showEntity, e.showState, e.showNot, e.showAbove, e.showBelow];
		return JSON.stringify([own.map((k) => e[k]), condition, env.refreshKey(), enabled()]);
	});
	let debounce: ReturnType<typeof setTimeout> | undefined;
	createEffect(
		on(signature, (_, previous) => {
			clearTimeout(debounce);
			// The first load is immediate; edits in the editor are debounced.
			if (previous === undefined) void load();
			else debounce = setTimeout(load, 500);
		}),
	);

	const period = createMemo(() => {
		const e = el();
		const custom = e.type === "ha-template" ? Number(e.refresh) : 0;
		return Math.max(5, custom || definition(e.type).data || 300);
	});
	createEffect(() => {
		const timer = setInterval(load, period() * 1000);
		onCleanup(() => clearInterval(timer));
	});

	const off = env.onEntities((ids) => {
		const mine = entities();
		if (mine.some((id) => ids.includes(id))) void load();
	});
	onCleanup(() => {
		off();
		controller?.abort();
		clearTimeout(debounce);
	});

	return { data, error, show, loaded };
}
