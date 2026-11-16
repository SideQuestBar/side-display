/**
 * Types shared by the server, the admin UI and the display renderer.
 */
import type { ElementType } from "./elements";

/** How a screen reproduces colour. Everything but `full` is a low-colour (ePaper) mode. */
export type ColorMode = "full" | "gray" | "mono" | "color6";

export const COLOR_MODES: { value: ColorMode; label: string; hint: string }[] = [
	{ value: "full", label: "Full colour", hint: "TVs, monitors and tablets" },
	{ value: "gray", label: "ePaper · greyscale", hint: "16-level grey panels" },
	{ value: "mono", label: "ePaper · black & white", hint: "1-bit panels, images are dithered" },
	{ value: "color6", label: "ePaper · 6 colours", hint: "Spectra-style panels, images are dithered" },
];

export type VerticalAlign = "top" | "center" | "bottom" | "spread";
export type BackgroundFit = "cover" | "contain" | "fill" | "repeat";
export type FontFamily = "sans" | "serif" | "mono" | "rounded" | "condensed";

export interface LayoutSettings {
	/** `auto` fills the screen; `W:H` locks the design ratio and letterboxes. */
	aspectRatio: string;
	/** Canvas padding, in stage px (the stage is 1080 px tall). */
	padding: number;
	/** Gap between stacked elements, in stage px. */
	spacing: number;
	verticalAlign: VerticalAlign;
	background: string;
	/** Second colour: when set, the background becomes a gradient. */
	backgroundTo: string;
	backgroundAngle: number;
	backgroundImage: string;
	backgroundFit: BackgroundFit;
	backgroundPosition: string;
	/** 0–90: darkens the background image so text stays readable. */
	backgroundDim: number;
	textColor: string;
	accentColor: string;
	/** Colour of the translucent panel behind boxed elements. */
	panelColor: string;
	fontFamily: FontFamily;
	/** Scales every text size, in percent. */
	textScale: number;
	/** Corner radius of panels and media, in stage px. */
	radius: number;
}

export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
	aspectRatio: "auto",
	padding: 40,
	spacing: 24,
	verticalAlign: "top",
	background: "#1d2b36",
	backgroundTo: "",
	backgroundAngle: 160,
	backgroundImage: "",
	backgroundFit: "cover",
	backgroundPosition: "center",
	backgroundDim: 0,
	textColor: "#ffffff",
	accentColor: "#ffd24a",
	panelColor: "#ffffff1f",
	fontFamily: "sans",
	textScale: 100,
	radius: 16,
};

/** Properties every element has, whatever its type. */
export interface ElementCommon {
	id: string;
	type: ElementType;
	/** Optional name shown in the editor's element list. */
	name: string;
	/** `flow` follows the layout; `free` is positioned by hand on top of it. */
	placement: "flow" | "free";
	/** Free placement frame, in percent of the stage. */
	x: number;
	y: number;
	w: number;
	h: number;
	rotate: number;
	/** Whether a flow element takes the leftover height. */
	grow: "auto" | "yes" | "no";
	/** Fixed height in percent of the screen height; 0 sizes to the content. */
	height: number;
	box: "none" | "panel" | "solid" | "outline";
	boxColor: string;
	boxPadding: number;
	textColor: string;
	opacity: number;
	/** Days the element is shown on (0 = Sunday); empty means every day. */
	showDays: number[];
	showFrom: string;
	showTo: string;
	/** Home Assistant entity that gates the element. */
	showEntity: string;
	/** Comma-separated states that show the element, e.g. `on,home`. */
	showState: string;
	/** Which colour modes the element appears in. */
	showMode: "always" | "color" | "epaper";
	/** Inside a carousel: seconds the element stays up; 0 uses the carousel's interval. */
	slideSeconds: number;
	/** Inside a grid: how many columns and rows the element takes. */
	spanCols: number;
	spanRows: number;
	/** Shown only between these two moments (`YYYY-MM-DDTHH:MM`, instance time zone); empty = no limit. */
	showSince: string;
	showUntil: string;
	/** Turns the entity condition around: shown when it is *not* met. */
	showNot: boolean;
	/** Numeric entity condition, used instead of the states when either is set. */
	showAbove: string;
	showBelow: string;
	/** Plays when the element appears. */
	enter: "none" | "fade" | "rise" | "drop" | "zoom" | "slide";
	/** A frame around the element, in stage px; 0 = none. */
	borderWidth: number;
	borderColor: string;
	boxShadow: "none" | "soft" | "strong";
	/** Corner radius in stage px; -1 uses the layout's. */
	radius: number;
	/** Empty uses the layout's font. */
	font: "" | FontFamily;
	/** Stacking order among freely placed elements; higher is in front. */
	layer: number;
}

export const ELEMENT_COMMON_DEFAULTS: Omit<ElementCommon, "id" | "type"> = {
	name: "",
	placement: "flow",
	x: 70,
	y: 6,
	w: 24,
	h: 24,
	rotate: 0,
	grow: "auto",
	height: 0,
	box: "none",
	boxColor: "",
	boxPadding: 24,
	textColor: "",
	opacity: 100,
	showDays: [],
	showFrom: "",
	showTo: "",
	showEntity: "",
	showState: "on",
	showMode: "always",
	slideSeconds: 0,
	spanCols: 1,
	spanRows: 1,
	showSince: "",
	showUntil: "",
	showNot: false,
	showAbove: "",
	showBelow: "",
	enter: "none",
	borderWidth: 0,
	borderColor: "",
	boxShadow: "none",
	radius: -1,
	font: "",
	layer: 0,
};

/** An element of any type; type-specific properties are read through `El<K>`. */
export type AnyEl = ElementCommon & Record<string, unknown>;

export interface Layout {
	id: string;
	name: string;
	settings: LayoutSettings;
	elements: AnyEl[];
	/** Folder the layout is filed under in the admin; empty = none. */
	folder: string;
	/** When it was archived: out of the admin's main lists, but kept and still shown where it is used. */
	archivedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

/** One entry of a display's playlist. */
export interface PlaylistEntry {
	layoutId: string;
	/** How long the layout stays up when the display cycles. */
	seconds: number;
	/** Optional schedule: days (0 = Sunday) and a time window, both empty = always. */
	days: number[];
	from: string;
	to: string;
}

export interface DisplaySettings {
	colorMode: ColorMode;
	/** White-on-black in the ePaper modes. */
	invert: boolean;
	transition: "fade" | "none";
	rotation: 0 | 90 | 180 | 270;
	/** Nudges the picture by a few pixels every minute to limit burn-in. */
	pixelShift: boolean;
	/** `HH:MM` at which the screen reloads itself every day; empty = never. */
	reloadAt: string;
	/** Dims the screen between two times (`HH:MM`). */
	dimFrom: string;
	dimTo: string;
	dimLevel: number;
	/** Shows a small badge when the screen has lost its connection. */
	offlineBadge: boolean;
}

export const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
	colorMode: "full",
	invert: false,
	transition: "fade",
	rotation: 0,
	pixelShift: false,
	reloadAt: "",
	dimFrom: "",
	dimTo: "",
	dimLevel: 60,
	offlineBadge: true,
};

export interface Display {
	id: string;
	name: string;
	/** Short name that opens the display as well as its id (`/d/<slug>`); empty = none. */
	slug: string;
	playlist: PlaylistEntry[];
	settings: DisplaySettings;
	/** When it was archived: out of the admin's main list, but its address keeps working. */
	archivedAt: number | null;
	createdAt: number;
	updatedAt: number;
	/** Screens currently connected to this display's live stream. */
	online?: number;
	lastSeenAt?: number | null;
}

export interface MediaItem {
	id: string;
	name: string;
	/** Stored file name; served from `media/<file>`. */
	file: string;
	kind: "image" | "video" | "document";
	mime: string;
	size: number;
	width: number | null;
	height: number | null;
	album: string;
	createdAt: number;
}

/** Instance-wide preferences, also sent to every display. */
export interface GeneralSettings {
	/** BCP 47 locale used to format dates and numbers on displays. */
	locale: string;
	/** IANA time zone; empty = the time zone of each screen. */
	timezone: string;
	hourCycle: "auto" | "12" | "24";
	temperatureUnit: "c" | "f";
	locationName: string;
	latitude: number;
	longitude: number;
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
	locale: "en-GB",
	timezone: "",
	hourCycle: "auto",
	temperatureUnit: "c",
	locationName: "",
	latitude: 0,
	longitude: 0,
};

/** What the first-run guide starts from. */
export interface SetupInfo {
	/** False once the guide was finished or skipped. */
	needed: boolean;
	general: GeneralSettings;
	/** Values read from the connected Home Assistant, if there is one. */
	suggested: Partial<GeneralSettings>;
}

/** A result of the place search. */
export interface Place {
	name: string;
	region: string;
	country: string;
	latitude: number;
	longitude: number;
	/** IANA time zone of the place; empty when unknown. */
	timezone: string;
}

export interface HaSettings {
	url: string;
	token: string;
}

export interface HaStatus {
	/** Where the connection settings come from. */
	source: "supervisor" | "settings" | "env" | "none";
	connected: boolean;
	version: string | null;
	error: string | null;
	entities: number;
}

export interface MqttSettings {
	/** `mqtt://host:1883` or `mqtts://host:8883`. */
	url: string;
	username: string;
	password: string;
}

export interface MqttStatus {
	/** Where the broker settings come from. */
	source: "supervisor" | "settings" | "env" | "none";
	connected: boolean;
	/** `host:port` of the broker in use. */
	broker: string | null;
	error: string | null;
	/** Topics being listened to. */
	topics: number;
}

/** What a display page receives. */
export interface ViewPayload {
	display: { id: string; name: string; settings: DisplaySettings };
	entries: { seconds: number; days: number[]; from: string; to: string; layout: Layout }[];
	general: GeneralSettings;
	version: string;
}

/** Envelope around an element's server-side data. */
export interface ElementData<T = unknown> {
	/** False when the element's Home Assistant condition hides it. */
	show: boolean;
	data: T | null;
	error?: string;
}

export interface HaEntityState {
	entity_id: string;
	state: string;
	name: string;
	unit: string;
	icon: string;
	device_class: string;
	last_changed: string;
	attributes: Record<string, unknown>;
}
