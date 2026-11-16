/**
 * Weather arithmetic shared by the server and the display: wind units,
 * air-quality and pollen bands, and the warnings derived from a forecast.
 * No DOM and no server APIs, so it can be tested on its own.
 */

// --------------------------------------------------------------------- wind

export type WindUnit = "kmh" | "ms" | "mph" | "kn" | "bft";

const PER_MS: Record<Exclude<WindUnit, "bft">, number> = { kmh: 3.6, ms: 1, mph: 2.236936, kn: 1.943844 };
export const WIND_LABELS: Record<WindUnit, string> = { kmh: "km/h", ms: "m/s", mph: "mph", kn: "kn", bft: "Bft" };

/** Reads a unit as the sources write it ("km/h", "m/s", "kt"…); null when unknown. */
export function windUnitOf(label: string): WindUnit | null {
	const unit = label.trim().toLowerCase().replace(/\s+/g, "");
	if (["km/h", "kmh", "kph"].includes(unit)) return "kmh";
	if (["m/s", "ms"].includes(unit)) return "ms";
	if (["mph", "mi/h"].includes(unit)) return "mph";
	if (["kn", "kt", "kts", "knots"].includes(unit)) return "kn";
	if (["bft", "beaufort"].includes(unit)) return "bft";
	return null;
}

/** Upper bounds, in m/s, of Beaufort forces 0 to 11. */
const BEAUFORT = [0.5, 1.5, 3.3, 5.5, 7.9, 10.7, 13.8, 17.1, 20.7, 24.4, 28.4, 32.6];
export const beaufort = (ms: number) => {
	const force = BEAUFORT.findIndex((limit) => ms < limit);
	return force < 0 ? 12 : force;
};

/**
 * A wind speed in another unit. Returns null when either unit is unknown or
 * the source is already in Beaufort, which cannot be turned back into a speed.
 */
export function convertWind(value: number, from: string, to: WindUnit): number | null {
	const source = windUnitOf(from);
	if (!source) return null;
	if (source === to) return value;
	if (source === "bft") return null;
	const ms = value / PER_MS[source];
	return to === "bft" ? beaufort(ms) : ms * PER_MS[to];
}

// -------------------------------------------------------------- air quality

export interface Band {
	/** 0 is the best band. */
	level: number;
	label: string;
	color: string;
}

type Scale = [upTo: number, label: string, color: string][];
/** European Air Quality Index, as the European Environment Agency bands it. */
const EUROPEAN: Scale = [
	[20, "Good", "#50f0e6"],
	[40, "Fair", "#50ccaa"],
	[60, "Moderate", "#f0e641"],
	[80, "Poor", "#ff5050"],
	[100, "Very poor", "#960032"],
	[Number.POSITIVE_INFINITY, "Extremely poor", "#7d2181"],
];
/** The United States EPA's index. */
const US: Scale = [
	[50, "Good", "#00c853"],
	[100, "Moderate", "#f0d800"],
	[150, "Unhealthy for sensitive groups", "#ff7e00"],
	[200, "Unhealthy", "#e53935"],
	[300, "Very unhealthy", "#8f3f97"],
	[Number.POSITIVE_INFINITY, "Hazardous", "#7e0023"],
];

export type AqiScale = "european" | "us";
/** Where each scale's meter ends; anything above fills it. */
export const AQI_FULL: Record<AqiScale, number> = { european: 100, us: 300 };

export function aqiBand(scale: AqiScale, value: number): Band {
	const bands = scale === "us" ? US : EUROPEAN;
	const level = Math.max(
		0,
		bands.findIndex(([upTo]) => value <= upTo),
	);
	const [, label, color] = bands[level]!;
	return { level, label, color };
}

export type PollenKind = "alder" | "birch" | "grass" | "mugwort" | "olive" | "ragweed";
export const POLLEN_KINDS: PollenKind[] = ["alder", "birch", "grass", "mugwort", "olive", "ragweed"];

/**
 * Grains per m³ where a pollen count becomes moderate, high and very high.
 * These are the bands of the US National Allergy Bureau, which differ for
 * trees, grasses and weeds.
 */
const POLLEN_LIMITS: Record<PollenKind, [number, number, number]> = {
	alder: [15, 90, 1500],
	birch: [15, 90, 1500],
	olive: [15, 90, 1500],
	grass: [5, 20, 200],
	mugwort: [10, 50, 500],
	ragweed: [10, 50, 500],
};
const POLLEN_BANDS: [label: string, color: string][] = [
	["None", "#9aa0a6"],
	["Low", "#50ccaa"],
	["Moderate", "#f0d800"],
	["High", "#ff7e00"],
	["Very high", "#e53935"],
];

export function pollenBand(kind: PollenKind, grains: number): Band {
	const limits = POLLEN_LIMITS[kind];
	const level = grains < 1 ? 0 : 1 + limits.filter((limit) => grains >= limit).length;
	const [label, color] = POLLEN_BANDS[level]!;
	return { level, label, color };
}

// ------------------------------------------------------------------- alerts

export interface WeatherAlert {
	title: string;
	/** True when we worked it out from the forecast; false when a weather service issued it. */
	derived: boolean;
}

/** One day of a forecast, in metric units, as far as the warnings need it. */
export interface AlertDay {
	/** Highest gust, km/h. */
	gusts: number | null;
	/** Rain and melted snow, mm. */
	precipitation: number | null;
	/** Fresh snow, cm. */
	snowfall: number | null;
	/** Feels-like extremes, °C. */
	feelsMax: number | null;
	feelsMin: number | null;
	thunder: boolean;
}

/**
 * Plain warnings worked out from the forecast of today and tomorrow, for
 * sources that publish no official alerts. The thresholds are deliberately
 * high: a banner that is up every other day is not read.
 */
export function derivedAlerts(days: AlertDay[]): WeatherAlert[] {
	const out: WeatherAlert[] = [];
	const seen = new Set<string>();
	for (const [index, day] of days.slice(0, 2).entries()) {
		const when = index === 0 ? "today" : "tomorrow";
		const add = (kind: string, title: string) => {
			// Two days of the same thing make one line, about the first of them.
			if (seen.has(kind)) return;
			seen.add(kind);
			out.push({ title: `${title} ${when}`, derived: true });
		};
		const gusts = day.gusts ?? 0;
		if (gusts >= 103) add("wind", "Violent storm gusts");
		else if (gusts >= 89) add("wind", "Storm-force gusts");
		else if (gusts >= 75) add("wind", "Gale-force gusts");
		if (day.thunder) add("thunder", "Thunderstorms");
		if ((day.snowfall ?? 0) >= 10) add("snow", "Heavy snow");
		else if ((day.precipitation ?? 0) >= 30) add("rain", "Heavy rain");
		if ((day.feelsMax ?? 0) >= 38) add("heat", "Extreme heat");
		if ((day.feelsMin ?? 0) <= -15) add("frost", "Severe frost");
	}
	return out;
}

const first = (...values: unknown[]): string => {
	for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
	return "";
};

/**
 * Reads the alerts of a Home Assistant entity. There is no one shape: the
 * Meteoalarm integration is a binary sensor with `headline` and `event`, the
 * NWS alerts integration a sensor counting the alerts listed in its `Alerts`
 * attribute, and others simply put the warning in the state.
 */
export function haAlerts(state: string, attributes: Record<string, unknown>): WeatherAlert[] {
	const quiet = ["", "off", "0", "none", "unknown", "unavailable", "idle", "clear", "false"];
	if (quiet.includes(state.trim().toLowerCase())) return [];
	const list = attributes.Alerts ?? attributes.alerts;
	if (Array.isArray(list)) {
		const titles = list.flatMap((entry) => {
			if (typeof entry === "string") return entry.trim() ? [entry.trim()] : [];
			if (!entry || typeof entry !== "object") return [];
			const a = entry as Record<string, unknown>;
			const title = first(a.Headline, a.headline, a.Event, a.event, a.title);
			return title ? [title] : [];
		});
		if (titles.length) return titles.slice(0, 3).map((title) => ({ title, derived: false }));
	}
	const title = first(attributes.headline, attributes.event, attributes.title, attributes.description);
	if (title) return [{ title, derived: false }];
	// A sensor whose state is the warning itself; "on" or a bare count says nothing more.
	const bare = state.trim().toLowerCase() === "on" || /^\d+$/.test(state.trim());
	return [{ title: bare ? "Weather alert" : state.trim(), derived: false }];
}

// ------------------------------------------------------------------- tracks

/** Keeps at most `max` points of a path, always including both ends. */
export function thin<T>(points: T[], max: number): T[] {
	if (points.length <= max || max < 2) return points;
	const step = (points.length - 1) / (max - 1);
	return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}
