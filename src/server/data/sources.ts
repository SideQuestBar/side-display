/**
 * Data from outside Home Assistant: Open-Meteo weather, iCal calendars and
 * RSS/Atom feeds. Each fetch is cached in memory for a few minutes so many
 * screens showing the same thing cost one request.
 */
import ICAL from "ical.js";
import type { CalendarEvent, Condition, FeedData, FeedItem, WeatherData } from "../../shared/data";
import { convertWind, derivedAlerts } from "../../shared/weather";

interface CacheEntry {
	expires: number;
	value: Promise<unknown>;
}
const cache = new Map<string, CacheEntry>();

/** Memoises an async lookup; failures are forgotten quickly so they are retried. */
export function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && hit.expires > now) return hit.value as Promise<T>;
	if (cache.size > 500) for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
	const value = load();
	const entry = { expires: now + ttlSeconds * 1000, value };
	cache.set(key, entry);
	value.catch(() => {
		entry.expires = Date.now() + 30_000;
	});
	return value;
}

export async function fetchText(url: string, accept: string): Promise<string> {
	const target = url.trim().replace(/^webcal:/i, "https:");
	if (!/^https?:\/\//i.test(target)) throw new Error("the address must start with http:// or https://");
	const response = await fetch(target, {
		headers: { accept, "user-agent": "SideDisplay" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`${new URL(target).host} answered ${response.status}`);
	return response.text();
}

// ------------------------------------------------------------------ weather

/** WMO weather interpretation codes, as used by Open-Meteo. */
function wmoCondition(code: number, isDay = true): Condition {
	if (code === 0 || code === 1) return isDay ? "clear" : "night";
	if (code === 2) return "partly";
	if (code === 3) return "cloudy";
	if (code === 45 || code === 48) return "fog";
	if (code >= 51 && code <= 57) return "drizzle";
	if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
	if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
	if (code >= 95) return "thunder";
	return "unknown";
}

/** Home Assistant's weather condition strings. */
export function haCondition(state: string): Condition {
	const map: Record<string, Condition> = {
		sunny: "clear",
		"clear-night": "night",
		partlycloudy: "partly",
		cloudy: "cloudy",
		fog: "fog",
		hail: "snow",
		lightning: "thunder",
		"lightning-rainy": "thunder",
		pouring: "rain",
		rainy: "rain",
		snowy: "snow",
		"snowy-rainy": "snow",
		windy: "wind",
		"windy-variant": "wind",
		exceptional: "unknown",
	};
	return map[state] ?? "unknown";
}

export function openMeteo(latitude: number, longitude: number, unit: "c" | "f", place: string): Promise<WeatherData> {
	const lat = latitude.toFixed(3);
	const lon = longitude.toFixed(3);
	return cached(`weather:${lat}:${lon}:${unit}`, 900, async () => {
		const url = new URL("https://api.open-meteo.com/v1/forecast");
		url.search = new URLSearchParams({
			latitude: lat,
			longitude: lon,
			current: "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,is_day,uv_index",
			hourly: "temperature_2m,weather_code,precipitation_probability,is_day",
			daily:
				"weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_gusts_10m_max,precipitation_sum,snowfall_sum,apparent_temperature_max,apparent_temperature_min",
			timezone: "auto",
			forecast_days: "7",
			// The first of them is the hour that is already running.
			forecast_hours: "49",
			temperature_unit: unit === "f" ? "fahrenheit" : "celsius",
			wind_speed_unit: unit === "f" ? "mph" : "kmh",
		}).toString();
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}`);
		const body = (await response.json()) as {
			current: Record<string, number>;
			daily: Record<string, (number | string | null)[]>;
			hourly?: Record<string, (number | string | null)[]>;
		};
		const daily = body.daily;
		const hourly = body.hourly ?? {};
		const value = (list: (number | string | null)[] | undefined, i: number) =>
			typeof list?.[i] === "number" ? (list[i] as number) : null;
		// The warnings have metric thresholds whatever unit the screen shows.
		const celsius = (v: number | null) => (v === null || unit !== "f" ? v : ((v - 32) * 5) / 9);
		const gusts = (v: number | null) => (v === null ? null : convertWind(v, unit === "f" ? "mph" : "km/h", "kmh"));
		return {
			place: "",
			unit: unit === "f" ? "°F" : "°C",
			windUnit: unit === "f" ? "mph" : "km/h",
			current: {
				temperature: body.current.temperature_2m ?? 0,
				feelsLike: body.current.apparent_temperature ?? null,
				humidity: body.current.relative_humidity_2m ?? null,
				wind: body.current.wind_speed_10m ?? null,
				condition: wmoCondition(body.current.weather_code ?? -1, body.current.is_day !== 0),
				uv: body.current.uv_index ?? null,
			},
			hours: (hourly.time ?? []).slice(1).map((time, n) => ({
				time: String(time),
				temperature: value(hourly.temperature_2m, n + 1),
				condition: wmoCondition(value(hourly.weather_code, n + 1) ?? -1, hourly.is_day?.[n + 1] !== 0),
				rain: value(hourly.precipitation_probability, n + 1),
			})),
			alerts: derivedAlerts(
				(daily.time ?? []).slice(0, 2).map((_, i) => ({
					gusts: gusts(value(daily.wind_gusts_10m_max, i)),
					precipitation: value(daily.precipitation_sum, i),
					snowfall: value(daily.snowfall_sum, i),
					feelsMax: celsius(value(daily.apparent_temperature_max, i)),
					feelsMin: celsius(value(daily.apparent_temperature_min, i)),
					thunder: Number(daily.weather_code?.[i] ?? 0) >= 95,
				})),
			),
			days: (daily.time ?? []).map((date, i) => ({
				date: String(date),
				min: (daily.temperature_2m_min?.[i] as number | null) ?? null,
				max: (daily.temperature_2m_max?.[i] as number | null) ?? null,
				condition: wmoCondition(Number(daily.weather_code?.[i] ?? -1)),
				rain: (daily.precipitation_probability_max?.[i] as number | null) ?? null,
			})),
		} satisfies WeatherData;
	}).then((data) => ({ ...data, place }));
}

// ----------------------------------------------------------------- calendar

const pad = (n: number) => String(n).padStart(2, "0");
const dateOnly = (t: ICAL.Time) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;

export interface IcalOptions {
	/** Leave out events marked `STATUS:CANCELLED`. */
	hideCancelled?: boolean;
	/** Leave out events this attendee (an email address) declined. */
	declinedBy?: string;
}

/** The text of an iCal feed, shared by everything that reads the same address. */
export const icalText = (url: string): Promise<string> =>
	cached(`ical:${url}`, 600, () => fetchText(url, "text/calendar, */*"));

/** Parses a feed and registers its time zones so local times convert correctly. */
export function icalRoot(text: string): ICAL.Component {
	const root = new ICAL.Component(ICAL.parse(text));
	for (const tz of root.getAllSubcomponents("vtimezone")) {
		const zone = new ICAL.Timezone(tz);
		if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
	}
	return root;
}

/** Is the event cancelled, or declined by the given attendee? */
function skipped(component: ICAL.Component, options: IcalOptions): boolean {
	if (options.hideCancelled && String(component.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED") {
		return true;
	}
	const email = options.declinedBy?.trim().toLowerCase();
	if (!email) return false;
	return component.getAllProperties("attendee").some((attendee) => {
		const address = String(attendee.getFirstValue() ?? "")
			.replace(/^mailto:/i, "")
			.trim()
			.toLowerCase();
		return address === email && String(attendee.getParameter("partstat") ?? "").toUpperCase() === "DECLINED";
	});
}

/**
 * Events of an iCal feed between two instants, recurring events expanded.
 * All-day events keep plain dates so no time zone can shift them.
 */
export function icalEvents(
	url: string,
	from: Date,
	to: Date,
	color: string,
	calendar: string,
	options: IcalOptions = {},
) {
	return icalText(url).then((text) => parseIcalEvents(text, from, to, color, calendar, options));
}

export function parseIcalEvents(
	text: string,
	from: Date,
	to: Date,
	color: string,
	calendar: string,
	options: IcalOptions = {},
): CalendarEvent[] {
	const root = icalRoot(text);
	const out: CalendarEvent[] = [];
	const add = (title: string, start: ICAL.Time, end: ICAL.Time, location: string) => {
		const allDay = start.isDate;
		const startMs = start.toJSDate().getTime();
		const endMs = end.toJSDate().getTime();
		if (endMs < from.getTime() || startMs > to.getTime()) return;
		out.push({
			title,
			start: allDay ? dateOnly(start) : new Date(startMs).toISOString(),
			end: allDay ? dateOnly(end) : new Date(endMs).toISOString(),
			allDay,
			location,
			color,
			calendar,
		});
	};
	for (const component of root.getAllSubcomponents("vevent")) {
		const event = new ICAL.Event(component);
		if (event.isRecurrenceException()) continue;
		const title = event.summary || "(untitled)";
		const location = event.location || "";
		if (!event.isRecurring()) {
			if (skipped(component, options)) continue;
			add(title, event.startDate, event.endDate ?? event.startDate, location);
			continue;
		}
		const iterator = event.iterator();
		// Bounded: a daily event since 2010 must not walk forever.
		for (let i = 0; i < 5000; i++) {
			const next = iterator.next();
			if (!next || next.toJSDate().getTime() > to.getTime()) break;
			const occurrence = event.getOccurrenceDetails(next);
			// One occurrence of a series can be cancelled or declined on its own.
			if (skipped(occurrence.item.component, options)) continue;
			add(
				occurrence.item.summary || title,
				occurrence.startDate,
				occurrence.endDate,
				occurrence.item.location || location,
			);
		}
	}
	return out;
}

// --------------------------------------------------------------------- feeds

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v: unknown): string => {
	if (typeof v === "string") return v;
	if (v && typeof v === "object") return textOf((v as Record<string, unknown>)["#text"]);
	return "";
};
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const plain = (html: string) =>
	html
		.replace(/<[^>]*>/g, " ")
		.replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code: string) => {
			if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? whole;
			const point = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
			return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
		})
		.replace(/\s+/g, " ")
		.trim();

type FeedNode = Record<string, unknown>;
const nodes = (v: unknown): FeedNode[] => asArray<FeedNode>(v as FeedNode).filter((n) => n && typeof n === "object");
const webUrl = (v: unknown): string => {
	const url = typeof v === "string" ? v.trim().replace(/^\/\//, "https://") : "";
	return /^https?:\/\//i.test(url) ? url : "";
};
const isImage = (node: FeedNode) => {
	const kind = String(node["@medium"] ?? node["@type"] ?? "");
	if (kind) return kind.startsWith("image");
	return /\.(jpe?g|png|webp|gif|avif)(\?|$)/i.test(String(node["@url"] ?? node["@href"] ?? ""));
};

/**
 * The picture of a feed item, wherever the feed keeps it: Media RSS
 * (`media:thumbnail`, `media:content`, possibly inside a `media:group`), an
 * image enclosure, or failing that the first `<img>` of its HTML.
 */
function itemImage(item: FeedNode, html: string): string {
	const media = [item, ...nodes(item["media:group"]), ...nodes(item["media:content"])];
	for (const node of media) {
		for (const thumbnail of nodes(node["media:thumbnail"])) {
			const url = webUrl(thumbnail["@url"]);
			if (url) return url;
		}
	}
	for (const node of media) {
		// Several sizes of one picture: even the widest is a thumbnail by a screen's standards.
		const pictures = nodes(node["media:content"])
			.filter((content) => isImage(content) && webUrl(content["@url"]))
			.sort((a, b) => Number(b["@width"] ?? 0) - Number(a["@width"] ?? 0));
		if (pictures[0]) return webUrl(pictures[0]["@url"]);
	}
	for (const enclosure of [...nodes(item.enclosure), ...nodes(item.link)]) {
		if (!isImage(enclosure)) continue;
		if (enclosure["@url"]) return webUrl(enclosure["@url"]);
		if (enclosure["@rel"] === "enclosure") return webUrl(enclosure["@href"]);
	}
	const img = /<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(html);
	return img ? webUrl(plain(img[1]!)) : "";
}
/** `image` is only set when there is one, so items without a picture keep their plain shape. */
const withImage = (item: FeedItem, image: string): FeedItem => (image ? { ...item, image } : item);

/** Reads RSS 2.0, RSS 1.0 (RDF) and Atom. */
export function parseFeed(xml: string): FeedData {
	const doc = Bun.XML.parse(xml) as Record<string, any>;
	const rss = doc.rss?.channel ?? doc["rdf:RDF"];
	if (rss) {
		const channel = doc.rss?.channel ?? rss.channel ?? {};
		return {
			title: plain(textOf(channel.title)),
			items: asArray<Record<string, unknown>>(rss.item).map((item) => {
				const html = textOf(item.description);
				return withImage(
					{
						title: plain(textOf(item.title)),
						link: textOf(item.link).trim(),
						date: textOf(item.pubDate ?? item["dc:date"]),
						summary: plain(html).slice(0, 400),
					},
					itemImage(item, `${html} ${textOf(item["content:encoded"])}`),
				);
			}),
		};
	}
	const feed = doc.feed;
	if (feed) {
		return {
			title: plain(textOf(feed.title)),
			items: asArray<Record<string, unknown>>(feed.entry).map((entry) => {
				const links = asArray<Record<string, string> | string>(entry.link as never);
				const link = links.find((l) => typeof l === "object" && (l["@rel"] ?? "alternate") === "alternate") ?? links[0];
				const html = textOf(entry.summary ?? entry.content);
				return withImage(
					{
						title: plain(textOf(entry.title)),
						link: typeof link === "object" ? (link["@href"] ?? "") : (link ?? ""),
						date: textOf(entry.updated ?? entry.published),
						summary: plain(html).slice(0, 400),
					},
					itemImage(entry, `${html} ${textOf(entry.content)}`),
				);
			}),
		};
	}
	throw new Error("this does not look like an RSS or Atom feed");
}

export const feed = (url: string): Promise<FeedData> =>
	cached(`feed:${url}`, 600, async () => {
		const data = parseFeed(
			await fetchText(url, "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"),
		);
		// Normalise dates to ISO so the display can format them in its locale.
		for (const item of data.items) {
			const time = Date.parse(item.date);
			item.date = Number.isNaN(time) ? "" : new Date(time).toISOString();
		}
		return data;
	});
