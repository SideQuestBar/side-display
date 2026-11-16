/**
 * The data behind the weather, air-quality and map elements: Home Assistant
 * weather entities and tracker histories, Open-Meteo's air-quality model and
 * the GeoJSON overlay of a map.
 */
import type { AirQualityData, MapData, WeatherData } from "../../shared/data";
import type { El } from "../../shared/elements";
import { zoned } from "../../shared/time";
import type { GeneralSettings } from "../../shared/types";
import { haAlerts, POLLEN_KINDS, thin } from "../../shared/weather";
import { entityState, haJson, haServiceResponse } from "../ha/client";
import { cached, haCondition, openMeteo } from "./sources";

const num = (v: unknown): number | null => {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : null;
};
const pad = (n: number) => String(n).padStart(2, "0");

/** The place an element is about: its own coordinates, or the ones from the settings. */
function locate(el: { latitude: number; longitude: number; place?: string }, general: GeneralSettings) {
	const own = el.latitude !== 0 || el.longitude !== 0;
	const latitude = own ? el.latitude : general.latitude;
	const longitude = own ? el.longitude : general.longitude;
	if (latitude === 0 && longitude === 0) throw new Error("set a location here or in the settings");
	return { latitude, longitude, place: el.place || (own ? "" : general.locationName) };
}

// ------------------------------------------------------------------ weather

type HaForecast = Record<string, unknown>[];
const haForecast = (entity: string, type: "daily" | "hourly") =>
	cached(`ha-forecast:${entity}:${type}`, 900, async () => {
		const response = await haServiceResponse<Record<string, { forecast?: HaForecast }>>("weather", "get_forecasts", {
			entity_id: entity,
			type,
		});
		return response[entity]?.forecast ?? [];
	}).catch((): HaForecast => []);

async function haWeather(el: El<"weather">, general: GeneralSettings): Promise<WeatherData> {
	const state = entityState(el.entity);
	if (!state) throw new Error(el.entity ? `${el.entity} was not found` : "choose a weather entity");
	const a = state.attributes;
	const [daily, hourly] = await Promise.all([
		haForecast(el.entity, "daily"),
		// Not every weather integration has an hourly forecast: ask only when it is shown.
		el.hours > 0 ? haForecast(el.entity, "hourly") : [],
	]);
	const now = Date.now();
	return {
		place: state.name,
		unit: String(a.temperature_unit ?? "°C"),
		windUnit: String(a.wind_speed_unit ?? "km/h"),
		current: {
			temperature: num(a.temperature) ?? 0,
			feelsLike: num(a.apparent_temperature),
			humidity: num(a.humidity),
			wind: num(a.wind_speed),
			condition: haCondition(state.state),
			uv: num(a.uv_index),
		},
		days: daily.map((day) => ({
			date: String(day.datetime ?? "").slice(0, 10),
			min: num(day.templow),
			max: num(day.temperature),
			condition: haCondition(String(day.condition ?? "")),
			rain: num(day.precipitation_probability),
		})),
		hours: hourly.flatMap((hour) => {
			const at = Date.parse(String(hour.datetime ?? ""));
			if (!Number.isFinite(at) || at <= now) return [];
			// Home Assistant sends instants; the display shows wall-clock times.
			const local = zoned(at, general.timezone);
			return [
				{
					time: `${local.date}T${pad(local.hour)}:${pad(local.minute)}`,
					temperature: num(hour.temperature),
					condition: haCondition(String(hour.condition ?? "")),
					rain: num(hour.precipitation_probability),
				},
			];
		}),
		alerts: [],
	};
}

export async function weather(el: El<"weather">, general: GeneralSettings): Promise<WeatherData> {
	let data: WeatherData;
	if (el.source === "ha") data = await haWeather(el, general);
	else {
		const { latitude, longitude, place } = locate(el, general);
		data = await openMeteo(latitude, longitude, general.temperatureUnit, place);
	}
	// Alerts a weather service issued come before the ones we worked out.
	const entity = el.alerts ? entityState(el.alertEntity) : null;
	const official = entity ? haAlerts(entity.state, entity.attributes) : [];
	return { ...data, alerts: [...official, ...(data.alerts ?? [])] };
}

// -------------------------------------------------------------- air quality

const POLLUTANTS = [
	["pm2_5", "pm2_5"],
	["pm10", "pm10"],
	["no2", "nitrogen_dioxide"],
	["o3", "ozone"],
] as const;

export function airQuality(el: El<"air-quality">, general: GeneralSettings): Promise<AirQualityData> {
	const { latitude, longitude, place } = locate(el, general);
	const lat = latitude.toFixed(2);
	const lon = longitude.toFixed(2);
	// The model is hourly and about 10 km wide: nothing is gained by asking more often or more exactly.
	return cached(`air-quality:${lat}:${lon}`, 1800, async () => {
		const names = POLLUTANTS.map(([, name]) => name);
		const url = new URL("https://air-quality-api.open-meteo.com/v1/air-quality");
		url.search = new URLSearchParams({
			latitude: lat,
			longitude: lon,
			current: [
				"european_aqi",
				"us_aqi",
				...names,
				...names.map((name) => `european_aqi_${name}`),
				...names.map((name) => `us_aqi_${name}`),
				...POLLEN_KINDS.map((kind) => `${kind}_pollen`),
			].join(","),
			timezone: "auto",
		}).toString();
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}`);
		const { current = {} } = (await response.json()) as { current?: Record<string, unknown> };
		const value = (key: string) => (typeof current[key] === "number" ? (current[key] as number) : null);
		return {
			place: "",
			european: value("european_aqi"),
			us: value("us_aqi"),
			pollutants: POLLUTANTS.map(([key, name]) => ({
				key,
				value: value(name),
				european: value(`european_aqi_${name}`),
				us: value(`us_aqi_${name}`),
			})),
			// Outside Europe every pollen value is null.
			pollen: POLLEN_KINDS.flatMap((kind) => {
				const grains = value(`${kind}_pollen`);
				return grains === null ? [] : [{ kind, value: grains }];
			}),
		} satisfies AirQualityData;
	}).then((data) => ({ ...data, place }));
}

// ---------------------------------------------------------------------- map

const TRAIL_POINTS = 200;

/** Where a tracker has been, from the positions Home Assistant recorded with its states. */
function trail(entity: string, hours: number): Promise<[number, number][]> {
	return cached(`ha-trail:${entity}:${hours}`, 300, async () => {
		const start = new Date(Date.now() - hours * 3600_000).toISOString();
		// The position is in the attributes, and a person walking around stays
		// "not_home": ask for every recorded state, with its attributes.
		const history = await haJson<{ attributes?: Record<string, unknown> }[][]>(
			`/history/period/${start}?filter_entity_id=${encodeURIComponent(entity)}&significant_changes_only=0`,
		);
		const path: [number, number][] = [];
		for (const row of history[0] ?? []) {
			const latitude = num(row.attributes?.latitude);
			const longitude = num(row.attributes?.longitude);
			if (latitude === null || longitude === null) continue;
			const last = path.at(-1);
			if (last && last[0] === longitude && last[1] === latitude) continue;
			path.push([longitude, latitude]);
		}
		return thin(path, TRAIL_POINTS);
	});
}

const OVERLAY_BYTES = 2_000_000;
const OVERLAY_FEATURES = 5000;
const GEOMETRIES = [
	"Point",
	"MultiPoint",
	"LineString",
	"MultiLineString",
	"Polygon",
	"MultiPolygon",
	"GeometryCollection",
];

/** Rounds coordinates to about a metre, which is where most of a GeoJSON file's size goes. */
function tidy(value: unknown): unknown {
	if (typeof value === "number") return Math.round(value * 1e5) / 1e5;
	return Array.isArray(value) ? value.map(tidy) : null;
}
function geometry(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") return null;
	const g = value as Record<string, unknown>;
	if (typeof g.type !== "string" || !GEOMETRIES.includes(g.type)) return null;
	if (g.type === "GeometryCollection") {
		const parts = Array.isArray(g.geometries) ? g.geometries.map(geometry).filter(Boolean) : [];
		return { type: g.type, geometries: parts };
	}
	return { type: g.type, coordinates: tidy(g.coordinates) };
}

/**
 * Reduces any GeoJSON document to a list of bare geometries. Properties are
 * dropped: the overlay is drawn in one colour, and whatever else the file
 * says has no business on a public screen.
 */
export function overlayFeatures(document: unknown): NonNullable<MapData["overlay"]> {
	const root = (document ?? {}) as Record<string, unknown>;
	const sources =
		root.type === "FeatureCollection" && Array.isArray(root.features)
			? root.features.map((feature) => (feature as Record<string, unknown> | null)?.geometry)
			: root.type === "Feature"
				? [root.geometry]
				: [root];
	const features = sources.flatMap((source) => {
		const shape = geometry(source);
		return shape ? [{ type: "Feature", properties: {}, geometry: shape }] : [];
	});
	if (!features.length) throw new Error("this does not look like GeoJSON");
	return { type: "FeatureCollection", features: features.slice(0, OVERLAY_FEATURES) };
}

const overlay = (address: string) =>
	// Borders and routes rarely change; an hour also keeps us polite to whoever hosts the file.
	cached(`geojson:${address}`, 3600, async () => {
		const target = address.trim();
		if (!/^https?:\/\//i.test(target)) throw new Error("the address must start with http:// or https://");
		const response = await fetch(target, {
			headers: { accept: "application/geo+json, application/json, */*", "user-agent": "SideDisplay" },
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) throw new Error(`${new URL(target).host} answered ${response.status}`);
		// Read with a ceiling, so a wrong address cannot fill the memory.
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of response.body ?? []) {
			size += chunk.byteLength;
			if (size > OVERLAY_BYTES) throw new Error("the GeoJSON file is larger than 2 MB");
			chunks.push(chunk);
		}
		let document: unknown;
		try {
			document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		} catch {
			throw new Error("the GeoJSON address did not return JSON");
		}
		return overlayFeatures(document);
	});

export async function map(el: El<"map">): Promise<MapData> {
	const hours = Math.min(72, Math.max(0, el.trailHours));
	const trackers = await Promise.all(
		el.trackers.map(async (tracker) => {
			const state = entityState(tracker.entity);
			const latitude = num(state?.attributes.latitude);
			const longitude = num(state?.attributes.longitude);
			if (!state || latitude === null || longitude === null) return [];
			// A zone does not move. A trail that cannot be read must not hide the tracker.
			const moves = hours > 0 && !tracker.entity.startsWith("zone.");
			const path = moves ? await trail(tracker.entity, hours).catch(() => []) : [];
			return [
				{
					entity: tracker.entity,
					label: tracker.label || state.name,
					color: tracker.color,
					latitude,
					longitude,
					icon: tracker.icon || undefined,
					// The trail ends where the marker is, even when the last state is older.
					trail: path.length ? [...path, [longitude, latitude] as [number, number]] : undefined,
				},
			];
		}),
	);
	const data: MapData = { trackers: trackers.flat() };
	if (el.geojsonUrl.trim()) {
		try {
			data.overlay = await overlay(el.geojsonUrl);
		} catch (err) {
			data.overlay = null;
			data.overlayError = (err as Error).message;
		}
	}
	return data;
}
