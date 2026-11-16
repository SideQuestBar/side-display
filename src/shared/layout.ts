/**
 * Layout helpers: building elements, cleaning up stored or imported layouts,
 * walking the element tree, and converting sidequest-bar's legacy format.
 */
import { definition, type ElementType, isElementType } from "./elements";
import { placeholderEntities } from "./placeholders";
import {
	type AnyEl,
	DEFAULT_DISPLAY_SETTINGS,
	DEFAULT_LAYOUT_SETTINGS,
	type DisplaySettings,
	ELEMENT_COMMON_DEFAULTS,
	type LayoutSettings,
	type PlaylistEntry,
} from "./types";

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);

/** A fresh element of the given type, with every default filled in. */
export function makeElement(type: ElementType, overrides: Record<string, unknown> = {}): AnyEl {
	const d = definition(type);
	return {
		...ELEMENT_COMMON_DEFAULTS,
		...d.common,
		...structuredClone(d.defaults),
		...overrides,
		id: newId(),
		type,
	} as AnyEl;
}

/** The property under which each container type keeps its children. */
const CHILD_KEY: Partial<Record<ElementType, string>> = {
	columns: "columns",
	grid: "cells",
	carousel: "elements",
	switch: "cases",
};

/**
 * The lists of elements a container holds: one per column for `columns`, a
 * single list for the others. Empty for anything that is not a container.
 */
export function childLists(el: AnyEl): AnyEl[][] {
	const key = CHILD_KEY[el.type];
	const value = key ? el[key] : null;
	if (!Array.isArray(value)) return [];
	return el.type === "columns" ? (value as AnyEl[][]) : [value as AnyEl[]];
}

/** How deep a type may hold others: 2 arranges (columns, grid), 1 picks one (carousel, switch), 0 holds nothing. */
const depth = (type: ElementType) => (type === "columns" || type === "grid" ? 2 : type in CHILD_KEY ? 1 : 0);

/**
 * Containers nest one way only: an arranging container holds a picking one,
 * which holds plain elements. `null` is the top level, which holds anything.
 */
export function canHold(parent: ElementType | null, child: ElementType): boolean {
	return parent === null || depth(child) < depth(parent);
}

/** Every element of a tree, depth first, containers included. */
export function walk(elements: AnyEl[], visit: (el: AnyEl, parent: AnyEl | null) => void, parent: AnyEl | null = null) {
	for (const el of elements) {
		visit(el, parent);
		for (const list of childLists(el)) walk(list, visit, el);
	}
}

export function findElement(elements: AnyEl[], id: string): AnyEl | null {
	let found: AnyEl | null = null;
	walk(elements, (el) => {
		if (el.id === id) found = el;
	});
	return found;
}

/** The array holding an element and its index there (to move or remove it). */
export function locate(elements: AnyEl[], id: string): { list: AnyEl[]; index: number } | null {
	const index = elements.findIndex((e) => e.id === id);
	if (index >= 0) return { list: elements, index };
	for (const el of elements) {
		for (const list of childLists(el)) {
			const hit = locate(list, id);
			if (hit) return hit;
		}
	}
	return null;
}

/** A deep copy with fresh ids, for duplicating. */
export function cloneElement(el: AnyEl): AnyEl {
	const copy = structuredClone(el);
	walk([copy], (e) => {
		e.id = newId();
	});
	return copy;
}

/**
 * How an MQTT topic is named among the "entities" a display is told about, so
 * topics and Home Assistant entities share one live-update channel.
 */
export const mqttKey = (topic: string) => `mqtt:${topic.trim()}`;

/**
 * What an element is told about live: its Home Assistant entities (its own and
 * its visibility condition) and its MQTT topics.
 */
export function entitiesOf(el: AnyEl): string[] {
	const out = new Set<string>();
	const add = (v: unknown) => {
		if (typeof v === "string" && v.includes(".")) out.add(v);
	};
	const addTopic = (v: unknown) => {
		if (typeof v === "string" && v.trim()) out.add(mqttKey(v));
	};
	add(el.showEntity);
	if (el.type.startsWith("ha-") || el.type === "weather") add(el.entity);
	if (el.type === "weather") add(el.alertEntity);
	// The energy card has one entity per role, all named `…Entity`.
	if (el.type === "ha-energy") for (const [key, value] of Object.entries(el)) if (key.endsWith("Entity")) add(value);
	if (el.type === "text") for (const id of placeholderEntities(el.text)) add(id);
	if (el.type === "mqtt") addTopic(el.topic);
	if (el.type === "mqtt-list" && Array.isArray(el.topics))
		for (const row of el.topics) addTopic((row as { topic?: unknown })?.topic);
	for (const key of ["entities", "trackers", "sources"] as const) {
		const rows = el[key];
		if (Array.isArray(rows)) for (const row of rows) add((row as { entity?: unknown })?.entity);
	}
	return [...out];
}

/** Does the element need the server (data resolver or visibility condition)? */
export const needsData = (el: AnyEl) =>
	// A text only has server data when it names an entity in a placeholder.
	(el.type === "text" ? placeholderEntities(el.text).length > 0 : Boolean(definition(el.type).data)) ||
	Boolean(el.showEntity);

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
	const v = typeof n === "number" ? n : Number(n);
	return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

/**
 * Coerces a value to the shape of its default: a stored or imported property
 * of the wrong type falls back to the default instead of breaking a renderer.
 */
function coerce(value: unknown, fallback: unknown): unknown {
	if (value === undefined || value === null) return structuredClone(fallback);
	if (Array.isArray(fallback)) return Array.isArray(value) ? value : structuredClone(fallback);
	switch (typeof fallback) {
		case "number": {
			const n = Number(value);
			return Number.isFinite(n) ? n : fallback;
		}
		case "boolean":
			return Boolean(value);
		case "string":
			return typeof value === "string" ? value : String(value);
		default:
			return value;
	}
}

function normalizeElement(raw: unknown, parent: ElementType | null, seen: Set<string>): AnyEl | null {
	if (!raw || typeof raw !== "object") return null;
	const input = raw as Record<string, unknown>;
	if (!isElementType(input.type)) return null;
	const d = definition(input.type);
	const defaults: Record<string, unknown> = { ...ELEMENT_COMMON_DEFAULTS, ...d.common, ...d.defaults };
	const out: Record<string, unknown> = { type: input.type };
	for (const [key, fallback] of Object.entries(defaults)) out[key] = coerce(input[key], fallback);
	let id = typeof input.id === "string" && input.id ? input.id : newId();
	if (seen.has(id)) id = newId();
	seen.add(id);
	out.id = id;
	// Free placement only exists at the top level: inside a container everything flows.
	if (parent || (out.placement !== "free" && out.placement !== "flow")) out.placement = "flow";
	out.showDays = (out.showDays as unknown[]).map(Number).filter((n) => n >= 0 && n <= 6);
	out.slideSeconds = clamp(out.slideSeconds, 0, 86400, 0);
	out.spanCols = clamp(out.spanCols, 1, 12, 1);
	out.spanRows = clamp(out.spanRows, 1, 12, 1);
	const children = (list: unknown, holder: ElementType) =>
		(Array.isArray(list) ? list : [])
			.map((child) => normalizeElement(child, holder, seen))
			.filter((c): c is AnyEl => c !== null && canHold(holder, c.type));
	if (input.type === "carousel") out.elements = children(input.elements, "carousel");
	if (input.type === "switch") out.cases = children(input.cases, "switch");
	if (input.type === "grid") out.cells = children(input.cells, "grid");
	if (input.type === "columns") {
		const cols = Array.isArray(input.columns) ? (input.columns as unknown[]) : [[], []];
		out.columns = cols.slice(0, 6).map((col) => children(col, "columns"));
		if (!(out.columns as unknown[]).length) out.columns = [[], []];
	}
	return out as AnyEl;
}

export function normalizeElements(raw: unknown): AnyEl[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	return raw.map((el) => normalizeElement(el, null, seen)).filter((el): el is AnyEl => el !== null);
}

export function normalizeLayoutSettings(raw: unknown): LayoutSettings {
	const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, fallback] of Object.entries(DEFAULT_LAYOUT_SETTINGS)) out[key] = coerce(input[key], fallback);
	const s = out as unknown as LayoutSettings;
	s.padding = clamp(s.padding, 0, 400, 40);
	s.spacing = clamp(s.spacing, 0, 400, 24);
	s.textScale = clamp(s.textScale, 30, 300, 100);
	s.backgroundDim = clamp(s.backgroundDim, 0, 90, 0);
	if (s.aspectRatio !== "auto" && !/^\d+(\.\d+)?:\d+(\.\d+)?$/.test(s.aspectRatio)) s.aspectRatio = "auto";
	return s;
}

/** What a display's short address is stored as: lower-case letters, digits and hyphens. */
export function normalizeSlug(raw: unknown): string {
	return String(typeof raw === "string" ? raw : "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, 48)
		.replace(/^-+|-+$/g, "");
}

export function normalizeDisplaySettings(raw: unknown): DisplaySettings {
	const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const [key, fallback] of Object.entries(DEFAULT_DISPLAY_SETTINGS)) out[key] = coerce(input[key], fallback);
	const s = out as unknown as DisplaySettings;
	if (!["full", "gray", "mono", "color6"].includes(s.colorMode)) s.colorMode = "full";
	if (![0, 90, 180, 270].includes(s.rotation)) s.rotation = 0;
	if (s.transition !== "none") s.transition = "fade";
	s.dimLevel = clamp(s.dimLevel, 0, 95, 60);
	return s;
}

export function normalizePlaylist(raw: unknown): PlaylistEntry[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter(
			(e): e is Record<string, unknown> =>
				Boolean(e) && typeof e === "object" && typeof (e as { layoutId?: unknown }).layoutId === "string",
		)
		.map((e) => ({
			layoutId: e.layoutId as string,
			seconds: clamp(e.seconds, 3, 86400, 30),
			days: Array.isArray(e.days) ? e.days.map(Number).filter((n) => n >= 0 && n <= 6) : [],
			from: typeof e.from === "string" ? e.from : "",
			to: typeof e.to === "string" ? e.to : "",
		}));
}

// --------------------------------------------------------------------------
// Import from sidequest-bar (the website this tool was extracted from)
// --------------------------------------------------------------------------

type Legacy = Record<string, unknown>;
/** Legacy text was `{ en: "…", hu: "…" }`. */
const loc = (v: unknown): string => {
	if (typeof v === "string") return v;
	if (v && typeof v === "object") {
		const map = v as Record<string, string>;
		return map.en ?? Object.values(map)[0] ?? "";
	}
	return "";
};

/** Tells a sidequest-bar layout export from a SideDisplay one. */
export function isLegacyLayout(raw: unknown): boolean {
	const layout = raw as { elements?: Legacy[]; settings?: Legacy } | null;
	if (!layout || !Array.isArray(layout.elements)) return false;
	const flat = layout.elements.flatMap((el) =>
		el.type === "columns" && Array.isArray(el.columns) ? [el, ...(el.columns as Legacy[][]).flat()] : [el],
	);
	return flat.some(
		(el) =>
			el.type === "message" ||
			el.type === "events" ||
			"shortUrl" in el ||
			(typeof el.text === "object" && el.text !== null),
	);
}

function legacyElement(el: Legacy, assetBase: string): AnyEl | null {
	const asset = (v: unknown) => (typeof v === "string" && v ? (v.startsWith("/") ? assetBase + v : v) : "");
	switch (el.type) {
		case "message":
			return makeElement("text", {
				text: loc(el.text),
				size: el.textSize ?? 48,
				box: el.background === false ? "none" : "panel",
			});
		case "image":
			return makeElement("image", {
				src: asset(el.image),
				caption: loc(el.text),
				width: el.size ?? 100,
				captionPosition: el.textPosition ?? "right",
				captionSize: el.textSize ?? 32,
				boxPadding: el.padding ?? 0,
			});
		case "slideshow":
			return makeElement("slideshow", {
				interval: el.intervalSeconds ?? 10,
				slides: (Array.isArray(el.slides) ? (el.slides as Legacy[]) : []).map((s) => ({
					title: loc(s.title),
					subtitle: loc(s.subtitle),
					image: asset(s.image),
				})),
			});
		case "qr":
			return makeElement("qr", {
				url: (el.shortUrl as string) || (el.url as string) || "",
				caption: loc(el.text),
				codeSize: el.size ?? 22,
				captionPosition: el.textPosition ?? "below",
				captionSize: el.textSize ?? 32,
			});
		case "hours":
			return makeElement("hours", { variant: el.variant === "long" ? "week" : "status", size: el.textSize ?? 32 });
		case "events":
			return makeElement("calendar", { title: "Upcoming events", max: el.count ?? 5, days: el.daysLimit ?? 30 });
		case "columns": {
			const cols = (Array.isArray(el.columns) ? (el.columns as Legacy[][]) : []).map((col) =>
				(col ?? []).map((child) => legacyElement(child, assetBase)).filter((c): c is AnyEl => c !== null),
			);
			return makeElement("columns", { columns: cols, gap: el.spacing ?? -1 });
		}
		default:
			return null;
	}
}

/**
 * Converts a layout exported from sidequest-bar. `assetBase` is prefixed to
 * its site-relative image paths (e.g. `https://sidequest.example`).
 */
export function convertLegacyLayout(
	raw: unknown,
	assetBase = "",
): { name: string; settings: LayoutSettings; elements: AnyEl[] } {
	const layout = raw as { name?: string; settings?: Legacy; elements?: Legacy[] };
	const s = layout.settings ?? {};
	const base = assetBase.replace(/\/$/, "");
	const image = typeof s.backgroundImage === "string" && s.backgroundImage ? s.backgroundImage : "";
	return {
		name: layout.name ?? "Imported layout",
		settings: normalizeLayoutSettings({
			aspectRatio: s.aspectRatio,
			padding: s.padding,
			spacing: s.spacing,
			verticalAlign: s.verticalAlign,
			background: s.background,
			backgroundImage: image.startsWith("/") ? base + image : image,
			backgroundFit: s.backgroundFit,
			backgroundPosition: s.backgroundPosition,
		}),
		elements: normalizeElements((layout.elements ?? []).map((el) => legacyElement(el, base)).filter(Boolean)),
	};
}
