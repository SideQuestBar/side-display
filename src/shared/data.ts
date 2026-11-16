/**
 * Shapes of the data the server resolves for elements (see `src/server/data`).
 */
import type { HaEntityState } from "./types";
import type { PollenKind, WeatherAlert } from "./weather";

export type Condition =
	| "clear"
	| "night"
	| "partly"
	| "cloudy"
	| "fog"
	| "drizzle"
	| "rain"
	| "snow"
	| "thunder"
	| "wind"
	| "unknown";

export interface WeatherData {
	place: string;
	unit: string;
	windUnit: string;
	current: {
		temperature: number;
		feelsLike: number | null;
		humidity: number | null;
		wind: number | null;
		condition: Condition;
		uv?: number | null;
	};
	days: { date: string; min: number | null; max: number | null; condition: Condition; rain: number | null }[];
	/**
	 * The coming hours. `time` is the wall-clock time at the place
	 * (`YYYY-MM-DDTHH:MM`, no zone), so it is shown as it is. Absent in data
	 * cached before hourly forecasts existed.
	 */
	hours?: { time: string; temperature: number | null; condition: Condition; rain: number | null }[];
	alerts?: WeatherAlert[];
}

export interface AirQualityData {
	place: string;
	/** The overall index on each scale; null where the model has no data. */
	european: number | null;
	us: number | null;
	/** Concentrations in µg/m³ with each pollutant's own index on both scales. */
	pollutants: {
		key: "pm2_5" | "pm10" | "no2" | "o3";
		value: number | null;
		european: number | null;
		us: number | null;
	}[];
	/** Grains per m³. Empty outside Europe, where there is no pollen forecast. */
	pollen: { kind: PollenKind; value: number }[];
}

export interface CalendarEvent {
	title: string;
	/** ISO instant, or `YYYY-MM-DD` for all-day events. */
	start: string;
	end: string;
	allDay: boolean;
	location: string;
	color: string;
	calendar: string;
}
/** Opening hours: the closed days of the holiday calendar. */
export interface HoursData {
	holidays: { date: string; name: string }[];
	/** Why the holiday calendar could not be read; empty when it could. */
	error: string;
}
/** Birthdays and anniversaries read from calendars. */
export interface BirthdaysData {
	/** `date` is `YYYY-MM-DD`, or `MM-DD` when the year is not known. */
	entries: { name: string; date: string; kind: string }[];
	errors: string[];
}
export interface CalendarData {
	events: CalendarEvent[];
	errors: string[];
}

export interface FeedItem {
	title: string;
	link: string;
	date: string;
	summary: string;
	/** The item's picture, when the feed has one. */
	image?: string;
	/** News feed element: the label of the feed the item came from. */
	source?: string;
}
export interface FeedData {
	title: string;
	items: FeedItem[];
}

/** What a numeric entity did lately; only resolved when an element asks for a trend or the day's range. */
export interface EntityStats {
	/** The value some minutes ago, to compare with the current one. */
	past: number | null;
	/** Lowest and highest value since midnight. */
	min: number | null;
	max: number | null;
}
export interface EntityData {
	state: HaEntityState | null;
	stats?: EntityStats;
}
export interface EntitiesData {
	states: (HaEntityState | null)[];
}
export interface GraphData {
	state: HaEntityState | null;
	/** `[timestamp ms, value]`, oldest first. */
	points: [number, number][];
	/** The extra entities drawn on the same graph, in the order they are configured. */
	series?: { label: string; color: string; unit: string; points: [number, number][] }[];
}
export interface EnergyData {
	/** Watts, null when not configured or not a number. Grid: positive = bought; battery: positive = discharging. */
	solar: number | null;
	grid: number | null;
	battery: number | null;
	home: number | null;
	/** Battery charge in percent. */
	level: number | null;
	totals: { key: "solar" | "import" | "export" | "home"; value: number; unit: string }[];
}
export interface PresenceData {
	people: { entity: string; name: string; state: string; home: boolean; picture: boolean }[];
}
export interface AlertsData {
	alerts: { entity: string; label: string; text: string; severity: "warning" | "critical" }[];
}
export interface TodoData {
	items: { summary: string; done: boolean; due: string }[];
}
export interface TemplateData {
	text: string;
}
export interface MapData {
	trackers: {
		entity: string;
		label: string;
		color: string;
		latitude: number;
		longitude: number;
		icon?: string;
		/** Where the tracker has been, oldest first, as `[longitude, latitude]`. */
		trail?: [number, number][];
	}[];
	/** The GeoJSON overlay, reduced to its geometries; null when it could not be read. */
	overlay?: { type: "FeatureCollection"; features: unknown[] } | null;
	overlayError?: string;
}
export interface TickerData {
	headlines: string[];
}

export interface TransitDeparture {
	line: string;
	destination: string;
	/** When it really leaves and when it was planned to, in ms since the epoch. */
	when: number;
	planned: number;
	/** Minutes late (negative = early); null without real-time data. */
	delay: number | null;
	platform: string;
	cancelled: boolean;
	/** The line's own colours, where the provider knows them. */
	color: string;
	textColor: string;
}
export interface TransitData {
	stop: string;
	departures: TransitDeparture[];
}
export interface Quote {
	symbol: string;
	label: string;
	price: number | null;
	/** Against the previous close (stocks, exchange rates) or 24 hours ago (crypto). */
	change: number | null;
	percent: number | null;
	/** ISO 4217 code, empty when unknown. */
	currency: string;
	/** Recent prices, oldest first, for the sparkline. */
	history: number[];
	error?: string;
}
export interface StocksData {
	quotes: Quote[];
}
export interface SportsSide {
	name: string;
	short: string;
	logo: string;
	score: string;
	winner: boolean;
}
export interface SportsEvent {
	id: string;
	/** ISO instant of the start. */
	date: string;
	state: "pre" | "in" | "post";
	/** The source's own short status: "FT", "HT", "67'", "Postponed"… */
	status: string;
	name: string;
	/** Null for events that are not one side against another (a race, a tournament). */
	home: SportsSide | null;
	away: SportsSide | null;
}
export interface SportsData {
	league: string;
	events: SportsEvent[];
}
export interface UptimeCheck {
	label: string;
	up: boolean;
	/** HTTP status, 0 when there was no answer. */
	status: number;
	ms: number;
	/** Since when it has been in this state (ms); only as far back as the server remembers. */
	since: number;
	error: string;
}
export interface UptimeData {
	checks: UptimeCheck[];
}
export interface JsonValueData {
	state: HaEntityState | null;
	states: (HaEntityState | null)[];
}
export interface ChartData {
	labels: string[];
	series: { name: string; values: (number | null)[] }[];
}
export interface VideoData {
	/** The subtitles as WebVTT text. */
	subtitles: string;
}
export interface WebData {
	/** Screenshot mode: when the current picture of the page was taken. */
	shot: number;
}
export interface GalleryData {
	items: {
		src: string;
		name: string;
		/** When the photo was taken (EXIF), else uploaded: `YYYY-MM-DDTHH:MM:SS`, wall-clock time. */
		date: string;
		/** Pixel size as displayed (orientation applied); 0 when unknown (SVG, GIF…). */
		width: number;
		height: number;
	}[];
}
/** States of the entities a text element names in `{entity:…}` placeholders, by entity id. */
export interface TextData {
	states: Record<string, { state: string; unit: string }>;
}
export interface SocialPost {
	author: string;
	handle: string;
	avatar: string;
	text: string;
	/** ISO instant. */
	date: string;
	image: string;
	/** Who shared it, when it is a boost or repost. */
	boostedBy: string;
}
export interface SocialData {
	posts: SocialPost[];
}
