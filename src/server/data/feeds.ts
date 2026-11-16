/**
 * Live information from other people's servers: public transport departures,
 * prices, sports scores, uptime checks, any JSON value, and chart data.
 *
 * Every provider has a small pure parser (tested with samples of the real
 * answers) and a fetcher that caches for at least the element's refresh
 * period, so a wall of screens costs each provider one request. Keys, tokens
 * and request headers typed into an element are only ever used here.
 */
import type {
	ChartData,
	JsonValueData,
	Quote,
	SportsData,
	SportsEvent,
	SportsSide,
	StocksData,
	TransitData,
	TransitDeparture,
	UptimeCheck,
	UptimeData,
} from "../../shared/data";
import type { El } from "../../shared/elements";
import type { HaEntityState } from "../../shared/types";
import { messageValue } from "../mqtt/client";
import { cached } from "./sources";

// biome-ignore lint/suspicious/noExplicitAny: other people's JSON, read defensively by the parsers below
type Json = Record<string, any>;

const MB = 1024 * 1024;
const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// ------------------------------------------------------------------ fetching

interface FetchOptions {
	accept?: string;
	headers?: Record<string, string>;
	maxBytes?: number;
	timeoutMs?: number;
}

/** Reads a body, giving up as soon as it is larger than allowed. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error(`the answer is larger than ${Math.round(maxBytes / MB)} MB`);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function checkedUrl(url: string): URL {
	let target: URL;
	try {
		target = new URL(url.trim());
	} catch {
		throw new Error("the address must start with http:// or https://");
	}
	if (target.protocol !== "http:" && target.protocol !== "https:")
		throw new Error("the address must start with http:// or https://");
	return target;
}

/** A GET with a timeout and a size limit; the body comes back whatever the status. */
async function request(
	url: string,
	options: FetchOptions = {},
): Promise<{ status: number; ok: boolean; body: string; host: string }> {
	const target = checkedUrl(url);
	const seconds = Math.round((options.timeoutMs ?? 15_000) / 1000);
	try {
		const response = await fetch(target, {
			headers: { accept: options.accept ?? "application/json, */*", "user-agent": "SideDisplay", ...options.headers },
			signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
		});
		return {
			status: response.status,
			ok: response.ok,
			body: await readCapped(response, options.maxBytes ?? 2 * MB),
			host: target.host,
		};
	} catch (err) {
		// Never the full address: it may carry a token.
		if ((err as Error).name === "TimeoutError") throw new Error(`${target.host} did not answer within ${seconds} s`);
		if ((err as Error).message.startsWith("the answer is larger")) throw err;
		throw new Error(`${target.host} could not be reached`);
	}
}

async function fetchBody(url: string, options: FetchOptions = {}): Promise<string> {
	const response = await request(url, options);
	if (!response.ok) throw new Error(`${response.host} answered ${response.status}`);
	return response.body;
}

function parseJson(body: string, host: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`${host} did not answer with JSON`);
	}
}

async function fetchJson(url: string, options: FetchOptions = {}): Promise<unknown> {
	return parseJson(await fetchBody(url, options), checkedUrl(url).host);
}

/** `Name: value` lines, as typed into an element, to request headers. */
export function parseHeaderLines(lines: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of lines.split("\n")) {
		const at = line.indexOf(":");
		if (at < 1) continue;
		const name = line.slice(0, at).trim();
		const value = line.slice(at + 1).trim();
		if (!/^[\w!#$%&'*+.^`|~-]+$/.test(name)) throw new Error(`"${name}" is not a valid header name`);
		if (value) headers[name] = value;
	}
	return headers;
}

/** Runs `work` over `items`, a few at a time, keeping the order. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await work(items[index] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// ------------------------------------------------------------------- transit

const minutesLate = (when: number, planned: number) => Math.round((when - planned) / 60_000);

/** Departures of a transport.rest (HAFAS) server: `GET /stops/:id/departures`. */
export function parseHafasDepartures(body: unknown): TransitData {
	// v6 wraps the list in an object, v5 answered with the bare list.
	const list: Json[] = Array.isArray(body) ? body : ((body as Json | null)?.departures ?? []);
	if (!Array.isArray(list)) throw new Error("unexpected answer from the transport server");
	const departures: TransitDeparture[] = [];
	for (const row of list) {
		// A cancelled departure has no `when`, only the planned time.
		const planned = Date.parse(row.plannedWhen ?? row.when ?? "");
		const when = Date.parse(row.when ?? row.plannedWhen ?? "");
		if (Number.isNaN(when)) continue;
		departures.push({
			line: text(row.line?.name),
			destination: text(row.direction) || text(row.destination?.name),
			when,
			planned: Number.isNaN(planned) ? when : planned,
			delay: typeof row.delay === "number" ? Math.round(row.delay / 60) : null,
			platform: text(row.platform) || text(row.plannedPlatform),
			cancelled: row.cancelled === true,
			color: text(row.line?.color?.bg),
			textColor: text(row.line?.color?.fg),
		});
	}
	return { stop: text(list[0]?.stop?.name), departures };
}

// Buses and trams are known by their number alone; trains keep their category ("IC 5", "S5").
const SWISS_NUMBER_ONLY = new Set(["B", "BUS", "T", "NFB", "NFT", "NFO", "M", "TRAM"]);

/** The stationboard of transport.opendata.ch. */
export function parseSwissStationboard(body: unknown): TransitData {
	const board = body as Json | null;
	if (!board?.station) throw new Error("the stop was not found");
	const departures: TransitDeparture[] = [];
	for (const row of (board.stationboard ?? []) as Json[]) {
		const stop = row.stop ?? {};
		const planned = typeof stop.departureTimestamp === "number" ? stop.departureTimestamp * 1000 : Number.NaN;
		if (Number.isNaN(planned)) continue;
		// Offsets come as "+0100", which not every date parser reads.
		const prognosis = Date.parse(text(stop.prognosis?.departure).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
		const delay = typeof stop.delay === "number" ? stop.delay : null;
		const when = Number.isNaN(prognosis) ? planned + (delay ?? 0) * 60_000 : prognosis;
		const category = text(row.category);
		// Long-distance trains carry their train number here ("000195"), which is no line.
		const number = text(row.number) === text(row.name) || /^0\d+$/.test(text(row.number)) ? "" : text(row.number);
		const line = SWISS_NUMBER_ONLY.has(category)
			? number || category
			: category === "S"
				? `S${number}`
				: [category, number].filter(Boolean).join(" ");
		departures.push({
			line,
			destination: text(row.to),
			when,
			planned,
			delay: Number.isNaN(prognosis) ? delay : minutesLate(when, planned),
			platform: text(stop.prognosis?.platform) || text(stop.platform),
			cancelled: false,
			color: "",
			textColor: "",
		});
	}
	return { stop: text(board.station.name), departures };
}

/**
 * BKK FUTÁR (Budapest): `arrivals-and-departures-for-stop`. Times are epoch
 * seconds; the line and the destination of a trip are in `references`.
 */
export function parseBkkDepartures(body: unknown): TransitData {
	const answer = body as Json | null;
	if (!answer || typeof answer !== "object") throw new Error("unexpected answer from BKK");
	if (answer.status && answer.status !== "OK") throw new Error(`BKK: ${text(answer.text) || text(answer.status)}`);
	const entry = answer.data?.entry;
	if (!entry) throw new Error("BKK: the stop was not found");
	const references: Json = answer.data.references ?? {};
	const hex = (color: unknown) => (/^[0-9a-f]{6}$/i.test(text(color)) ? `#${text(color)}` : "");
	const departures: TransitDeparture[] = [];
	for (const row of (entry.stopTimes ?? []) as Json[]) {
		const plannedSeconds = finite(row.departureTime) ?? finite(row.arrivalTime);
		const predictedSeconds = finite(row.predictedDepartureTime) ?? finite(row.predictedArrivalTime);
		const seconds = predictedSeconds ?? plannedSeconds;
		if (seconds === null) continue;
		const trip: Json = references.trips?.[row.tripId] ?? {};
		const route: Json = references.routes?.[trip.routeId] ?? {};
		const stop: Json = references.stops?.[row.stopId] ?? {};
		const when = seconds * 1000;
		const planned = (plannedSeconds ?? seconds) * 1000;
		departures.push({
			line: text(route.shortName) || text(route.longName),
			destination: text(row.stopHeadsign) || text(trip.tripHeadsign),
			when,
			planned,
			delay: predictedSeconds === null ? null : minutesLate(when, planned),
			platform: text(stop.platformCode),
			cancelled: false,
			color: hex(route.style?.color ?? route.color),
			textColor: hex(route.style?.icon?.textColor ?? route.textColor),
		});
	}
	const stops = Object.values((references.stops ?? {}) as Record<string, Json>);
	const named = (references.stops?.[entry.stopId] ?? stops[0]) as Json | undefined;
	return { stop: text(named?.name), departures: departures.sort((a, b) => a.when - b.when) };
}

const wanted = (list: string) =>
	list
		.split(",")
		.map((part) => part.trim().toLowerCase())
		.filter(Boolean);

/** Keeps the lines asked for (exact names) and the destinations containing one of the given words. */
export function filterDepartures(departures: TransitDeparture[], lines: string, direction: string): TransitDeparture[] {
	const names = new Set(wanted(lines).map((name) => name.replace(/\s+/g, "")));
	const words = wanted(direction);
	return departures.filter((departure) => {
		if (names.size && !names.has(departure.line.toLowerCase().replace(/\s+/g, ""))) return false;
		const destination = departure.destination.toLowerCase();
		return !words.length || words.some((word) => destination.includes(word));
	});
}

async function loadDepartures(el: El<"transit">): Promise<TransitData> {
	const stop = el.stop.trim();
	if (el.provider === "swiss") {
		// A number is a station id, anything else is looked up by name.
		const query = /^\d+$/.test(stop) ? `id=${stop}` : `station=${encodeURIComponent(stop)}`;
		return parseSwissStationboard(await fetchJson(`https://transport.opendata.ch/v1/stationboard?${query}&limit=40`));
	}
	if (el.provider === "bkk") {
		const key = el.apiKey.trim();
		if (!key) throw new Error("BKK needs an API key (free, from opendata.bkk.hu)");
		const url = new URL("https://futar.bkk.hu/api/query/v1/ws/otp/api/where/arrivals-and-departures-for-stop");
		// Several stops (both sides of a street) can be asked for at once.
		for (const id of stop.split(/[\s,]+/).filter(Boolean))
			url.searchParams.append("stopId", id.includes("_") ? id : `BKK_${id}`);
		url.search += `&${new URLSearchParams({
			minutesBefore: "0",
			minutesAfter: "90",
			onlyDepartures: "true",
			limit: "60",
			includeReferences: "routes,trips,stops",
			version: "4",
			appVersion: "SideDisplay",
			key,
		})}`;
		const response = await request(url.href);
		// Refused keys are answered in plain text.
		if (response.status === 401 || response.status === 403)
			throw new Error("BKK did not accept the API key; get one at opendata.bkk.hu");
		if (!response.ok && !response.body.trim().startsWith("{")) throw new Error(`BKK answered ${response.status}`);
		return parseBkkDepartures(parseJson(response.body, "BKK"));
	}
	const base = (el.server.trim() || "https://v6.vbb.transport.rest").replace(/\/+$/, "");
	const response = await request(`${base}/stops/${encodeURIComponent(stop)}/departures?duration=120&results=40`);
	if (!response.ok) {
		// These servers explain themselves: { "message": "id must be an IBNR" }.
		let message = "";
		try {
			message = text(JSON.parse(response.body).message);
		} catch {}
		throw new Error(message ? `${response.host}: ${message}` : `${response.host} answered ${response.status}`);
	}
	return parseHafasDepartures(parseJson(response.body, response.host));
}

export async function transit(el: El<"transit">): Promise<TransitData> {
	if (!el.stop.trim()) throw new Error("enter a stop");
	const source = [el.provider, el.server.trim(), el.stop.trim(), Bun.hash(el.apiKey)].join("|");
	const data = await cached(`transit:${source}`, 55, () => loadDepartures(el));
	// The screen counts down and drops what has left, so it gets more than it shows.
	return { stop: data.stop, departures: filterDepartures(data.departures, el.lines, el.direction).slice(0, 30) };
}

// -------------------------------------------------------------------- stocks

type QuoteValues = Omit<Quote, "symbol" | "label">;

const percentOf = (price: number, previous: number) => (previous ? ((price - previous) / previous) * 100 : null);

/** Yahoo Finance's chart endpoint with daily candles: price, previous close and the closes as history. */
export function parseYahooChart(body: unknown): QuoteValues {
	const chart = (body as Json | null)?.chart;
	const result = chart?.result?.[0];
	if (!result) throw new Error(text(chart?.error?.description) || "no data for this symbol");
	const meta: Json = result.meta ?? {};
	const stamps: number[] = result.timestamp ?? [];
	const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
	const days = stamps.flatMap((stamp, i) => {
		const close = finite(closes[i]);
		return close === null ? [] : [{ stamp, close }];
	});
	const price = finite(meta.regularMarketPrice) ?? days.at(-1)?.close ?? null;
	if (price === null) throw new Error("no price for this symbol");
	// The last candle is the running day while the market is open, and the last
	// closed day otherwise; the previous close is the one before that day.
	const offset = finite(meta.gmtoffset) ?? 0;
	const dayOf = (stamp: number) => Math.floor((stamp + offset) / 86_400);
	const today = dayOf(finite(meta.regularMarketTime) ?? days.at(-1)?.stamp ?? 0);
	const previous = days.findLast((day) => dayOf(day.stamp) < today)?.close ?? null;
	const history = days.filter((day) => dayOf(day.stamp) < today).map((day) => day.close);
	return {
		price,
		change: previous === null ? null : price - previous,
		percent: previous === null ? null : percentOf(price, previous),
		currency: text(meta.currency).toUpperCase(),
		history: [...history, price],
	};
}

/** Finnhub's `/quote`: c = current, d = change, dp = percent, pc = previous close. */
export function parseFinnhubQuote(body: unknown): QuoteValues {
	const quote = body as Json | null;
	if (quote?.error) throw new Error(`Finnhub: ${text(quote.error)}`);
	const price = finite(quote?.c);
	// Unknown symbols are answered with zeroes.
	if (!price) throw new Error("no data for this symbol");
	return { price, change: finite(quote?.d), percent: finite(quote?.dp), currency: "", history: [] };
}

/** CoinGecko's `/coins/markets` with `sparkline=true`: one row per coin, by id. */
export function parseCoinGeckoMarkets(body: unknown, currency: string): Map<string, QuoteValues> {
	if (!Array.isArray(body))
		throw new Error(text((body as Json | null)?.status?.error_message) || "unexpected answer from CoinGecko");
	const coins = new Map<string, QuoteValues>();
	for (const coin of body as Json[]) {
		const hourly: number[] = (coin.sparkline_in_7d?.price ?? []).filter((v: unknown) => finite(v) !== null);
		// Seven days of hourly prices: every sixth is plenty for a sparkline.
		const history = hourly.filter((_, i) => i % 6 === 0 || i === hourly.length - 1);
		coins.set(text(coin.id), {
			price: finite(coin.current_price),
			change: finite(coin.price_change_24h),
			percent: finite(coin.price_change_percentage_24h),
			currency: currency.toUpperCase(),
			history,
		});
	}
	return coins;
}

/** Frankfurter's time series (`/v1/<from>..`): the last rate, against the working day before. */
export function parseFrankfurterSeries(body: unknown, quote: string): QuoteValues {
	const rates = ((body as Json | null)?.rates ?? {}) as Record<string, Record<string, number>>;
	const history = Object.keys(rates)
		.sort()
		.flatMap((date) => {
			const rate = finite(rates[date]?.[quote]);
			return rate === null ? [] : [rate];
		});
	const price = history.at(-1);
	if (price === undefined) throw new Error("no rate for this pair");
	const previous = history.at(-2);
	return {
		price,
		change: previous === undefined ? null : price - previous,
		percent: previous === undefined ? null : percentOf(price, previous),
		currency: quote,
		history,
	};
}

/** "EUR/HUF", "eurhuf" or "EUR-HUF" → ["EUR", "HUF"]. */
export function parsePair(symbol: string): [string, string] | null {
	const letters = symbol.toUpperCase().replace(/[^A-Z]/g, "");
	return letters.length === 6 ? [letters.slice(0, 3), letters.slice(3)] : null;
}

// Tickers people type, for the coins CoinGecko knows by a longer id.
const COIN_IDS: Record<string, string> = {
	btc: "bitcoin",
	eth: "ethereum",
	sol: "solana",
	xrp: "ripple",
	ada: "cardano",
	doge: "dogecoin",
	dot: "polkadot",
	ltc: "litecoin",
	bnb: "binancecoin",
	usdt: "tether",
	usdc: "usd-coin",
	xmr: "monero",
	link: "chainlink",
	avax: "avalanche-2",
	matic: "matic-network",
	trx: "tron",
};
export const coinId = (symbol: string) => COIN_IDS[symbol.trim().toLowerCase()] ?? symbol.trim().toLowerCase();

function stockQuote(symbol: string, key: string): Promise<QuoteValues> {
	if (key) {
		return cached(`finnhub:${symbol}:${Bun.hash(key)}`, 120, async () => {
			const response = await request(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`, {
				headers: { "x-finnhub-token": key },
			});
			if (response.status === 429) throw new Error("Finnhub: too many requests");
			return parseFinnhubQuote(parseJson(response.body, "Finnhub"));
		});
	}
	return cached(`yahoo:${symbol}`, 300, async () => {
		const response = await request(
			`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`,
		);
		if (response.status === 429) throw new Error("Yahoo Finance: too many requests");
		// An unknown symbol is a 404 that still explains itself in JSON.
		if (!response.ok && !response.body.trim().startsWith("{"))
			throw new Error(`Yahoo Finance answered ${response.status}`);
		return parseYahooChart(parseJson(response.body, "Yahoo Finance"));
	});
}

const coinQuotes = (ids: string[], currency: string): Promise<Map<string, QuoteValues>> =>
	cached(`coingecko:${currency}:${ids.join(",")}`, 120, async () => {
		const query = new URLSearchParams({
			vs_currency: currency,
			ids: ids.join(","),
			sparkline: "true",
			price_change_percentage: "24h",
		});
		const response = await request(`https://api.coingecko.com/api/v3/coins/markets?${query}`);
		if (response.status === 429) throw new Error("CoinGecko: too many requests, try again in a minute");
		if (!response.ok) throw new Error(`CoinGecko answered ${response.status}`);
		return parseCoinGeckoMarkets(parseJson(response.body, "CoinGecko"), currency);
	});

/** The European Central Bank publishes once a working day, so an hour of cache loses nothing. */
const rateSeries = (base: string, quotes: string[]): Promise<unknown> =>
	cached(`frankfurter:${base}:${quotes.join(",")}`, 3600, () => {
		const from = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
		return fetchJson(`https://api.frankfurter.dev/v1/${from}..?base=${base}&symbols=${quotes.join(",")}`);
	});

export async function stocks(el: El<"stocks">): Promise<StocksData> {
	const rows = el.symbols.filter((row) => row.symbol.trim());
	const currency = (el.currency.trim() || "usd").toLowerCase();
	const coins = [...new Set(rows.filter((row) => row.kind === "crypto").map((row) => coinId(row.symbol)))].sort();
	const bases = new Map<string, string[]>();
	for (const row of rows) {
		const pair = row.kind === "fx" ? parsePair(row.symbol) : null;
		if (pair) bases.set(pair[0], [...new Set([...(bases.get(pair[0]) ?? []), pair[1]])].sort());
	}

	// One request for all coins, one per base currency; started once, shared by the rows.
	const coinData = coins.length ? coinQuotes(coins, currency) : null;
	coinData?.catch(() => {});

	const quotes = await mapLimit(rows, 4, async (row): Promise<Quote> => {
		const symbol = row.symbol.trim();
		const label = row.label.trim() || symbol.toUpperCase();
		try {
			let values: QuoteValues | undefined;
			if (row.kind === "crypto") {
				values = (await coinData)?.get(coinId(symbol));
				if (!values) throw new Error("CoinGecko does not know this coin; use its id, such as bitcoin");
			} else if (row.kind === "fx") {
				const pair = parsePair(symbol);
				if (!pair) throw new Error("write a pair such as EUR/HUF");
				values = parseFrankfurterSeries(await rateSeries(pair[0], bases.get(pair[0]) ?? [pair[1]]), pair[1]);
			} else {
				values = await stockQuote(symbol.toUpperCase(), el.apiKey.trim());
			}
			return { symbol, label, ...values };
		} catch (err) {
			return {
				symbol,
				label,
				price: null,
				change: null,
				percent: null,
				currency: "",
				history: [],
				error: (err as Error).message,
			};
		}
	});
	// Nothing at all usually means the network, which is worth saying on the element.
	if (quotes.length && quotes.every((quote) => quote.error))
		throw new Error(`${quotes[0]?.label}: ${quotes[0]?.error}`);
	return { quotes };
}

// -------------------------------------------------------------------- sports

function sportsSide(competitor: Json): SportsSide {
	const team: Json = competitor.team ?? competitor.athlete ?? {};
	return {
		name: text(team.shortDisplayName) || text(team.displayName) || text(team.name),
		short: text(team.abbreviation) || text(team.shortDisplayName) || text(team.displayName),
		logo: text(team.logo) || text(team.logos?.[0]?.href),
		score: text(competitor.score),
		winner: competitor.winner === true,
	};
}

/** ESPN's public scoreboard: `site.api.espn.com/apis/site/v2/sports/<sport>/<league>/scoreboard`. */
export function parseScoreboard(body: unknown): SportsData {
	const board = body as Json | null;
	if (!board || !Array.isArray(board.events)) throw new Error(text(board?.message) || "unexpected answer from ESPN");
	const events: SportsEvent[] = [];
	for (const event of board.events as Json[]) {
		const competition: Json = event.competitions?.[0] ?? {};
		const competitors: Json[] = competition.competitors ?? [];
		const status: Json = event.status?.type ?? competition.status?.type ?? {};
		const state = status.state === "in" || status.state === "post" ? status.state : "pre";
		// Two sides make a match; a race or a tournament is shown by its name.
		const match = competitors.length === 2;
		const home = match ? (competitors.find((c) => c.homeAway === "home") ?? competitors[0]) : undefined;
		const away = match ? competitors.find((c) => c !== home) : undefined;
		// A match not played (yet, or postponed) has no score, though ESPN writes 0.
		const played = state === "in" || (state === "post" && status.completed !== false);
		const side = (competitor: Json) => ({ ...sportsSide(competitor), ...(played ? {} : { score: "", winner: false }) });
		events.push({
			id: text(event.id),
			date: Number.isNaN(Date.parse(event.date)) ? "" : new Date(event.date).toISOString(),
			state,
			status: text(status.shortDetail) || text(status.description),
			name: text(event.name) || text(event.shortName),
			home: home ? side(home) : null,
			away: away ? side(away) : null,
		});
	}
	return { league: text(board.leagues?.[0]?.abbreviation) || text(board.leagues?.[0]?.name), events };
}

/** `YYYYMM` of every month between two instants (UTC), as the scoreboard's `dates` takes them. */
export function monthsBetween(from: number, to: number): string[] {
	const months: string[] = [];
	const cursor = new Date(from);
	cursor.setUTCDate(1);
	cursor.setUTCHours(0, 0, 0, 0);
	while (cursor.getTime() <= to && months.length < 4) {
		months.push(`${cursor.getUTCFullYear()}${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`);
		cursor.setUTCMonth(cursor.getUTCMonth() + 1);
	}
	return months;
}

/** Merges scoreboards; later lists win, so the live one goes last. */
export function mergeEvents(lists: SportsEvent[][]): SportsEvent[] {
	const byId = new Map<string, SportsEvent>();
	for (const list of lists) for (const event of list) byId.set(event.id, event);
	return [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * What a screen needs of a league: everything live, the latest results and
 * the next fixtures. `team` matches a side's name or abbreviation.
 */
export function pickEvents(events: SportsEvent[], team: string, show: string, count: number): SportsEvent[] {
	const words = wanted(team);
	const mine = events.filter((event) => {
		if (!words.length) return true;
		const names = [event.name, event.home?.name, event.home?.short, event.away?.name, event.away?.short].map((name) =>
			(name ?? "").toLowerCase(),
		);
		// Three letters are an abbreviation and must be the whole of it: "ars" is not "Mars".
		return words.some((word) => names.some((name) => (word.length <= 3 ? name === word : name.includes(word))));
	});
	const live = show === "fixtures" ? [] : mine.filter((event) => event.state === "in");
	const results = show === "fixtures" ? [] : mine.filter((event) => event.state === "post");
	const fixtures = show === "results" ? [] : mine.filter((event) => event.state === "pre");
	const room = Math.max(0, count - live.length);
	// With both wanted, results get half the room, and whatever fixtures leave unused.
	const past = Math.min(results.length, show === "both" ? Math.max(Math.ceil(room / 2), room - fixtures.length) : room);
	const shown = past > 0 ? results.slice(-past) : [];
	return [...shown, ...live, ...fixtures.slice(0, room - shown.length)];
}

const DAY = 86_400_000;

export async function sports(el: El<"sports">): Promise<SportsData> {
	const code = (el.league === "custom" ? el.code : el.league)
		.trim()
		.replace(/^\/+|\/+$/g, "")
		.toLowerCase();
	if (!/^[a-z0-9-]+\/[a-z0-9._-]+$/.test(code))
		throw new Error("the league is written sport/league, such as soccer/eng.1");
	const base = `https://site.api.espn.com/apis/site/v2/sports/${code}/scoreboard`;
	const load = async (query: string) => {
		const response = await request(`${base}${query}`, { maxBytes: 24 * MB, timeoutMs: 20_000 });
		// ESPN answers 400 for a league it does not have.
		if (response.status === 400 || response.status === 404) throw new Error(`ESPN has no scoreboard for "${code}"`);
		if (!response.ok) throw new Error(`ESPN answered ${response.status}`);
		return parseScoreboard(parseJson(response.body, "ESPN"));
	};
	// The plain scoreboard is the current round and has the live scores; the
	// months around today add earlier results and later fixtures, and change slowly.
	const now = Date.now();
	const current = cached(`espn:${code}`, 55, () => load(""));
	const months = monthsBetween(
		el.show === "fixtures" ? now : now - 10 * DAY,
		el.show === "results" ? now : now + 21 * DAY,
	);
	const around = await Promise.all(
		months.map((month) =>
			cached(`espn:${code}:${month}`, 1800, () => load(`?dates=${month}&limit=400`)).catch(() => ({
				league: "",
				events: [],
			})),
		),
	);
	const board = await current;
	const events = mergeEvents([...around.map((month) => month.events), board.events]);
	return { league: board.league, events: pickEvents(events, el.team, el.show, el.count) };
}

// -------------------------------------------------------------------- uptime

/** Is this status what was asked for? `expected` is a list such as "200, 301-302"; empty accepts 200–399. */
export function statusExpected(status: number, expected: string): boolean {
	const parts = wanted(expected);
	if (!parts.length) return status >= 200 && status < 400;
	return parts.some((part) => {
		const [from, to] = part.split("-").map((n) => Number.parseInt(n, 10));
		if (from === undefined || Number.isNaN(from)) return false;
		return to === undefined || Number.isNaN(to) ? status === from : status >= from && status <= to;
	});
}

interface Probe {
	status: number;
	ms: number;
	error: string;
}

async function probe(url: string, timeoutMs: number): Promise<Probe> {
	let target: URL;
	try {
		target = checkedUrl(url);
	} catch (err) {
		return { status: 0, ms: 0, error: (err as Error).message };
	}
	const attempt = async (method: "HEAD" | "GET"): Promise<Probe> => {
		const started = performance.now();
		const response = await fetch(target, {
			method,
			redirect: "follow",
			headers: { "user-agent": "SideDisplay uptime check" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		const ms = Math.round(performance.now() - started);
		// Only the status matters: do not download the page.
		await response.body?.cancel().catch(() => {});
		return { status: response.status, ms, error: "" };
	};
	try {
		const head = await attempt("HEAD");
		// Plenty of servers refuse HEAD or answer it differently; GET is the truth.
		return head.status >= 400 ? await attempt("GET") : head;
	} catch (err) {
		const timedOut = (err as Error).name === "TimeoutError";
		return { status: 0, ms: 0, error: timedOut ? `no answer in ${Math.round(timeoutMs / 1000)} s` : "unreachable" };
	}
}

// Since when each check has been up or down. In memory: a restart starts counting again.
const uptimeSince = new Map<string, { up: boolean; since: number }>();

export async function uptime(el: El<"uptime">): Promise<UptimeData> {
	const sites = el.sites.filter((site) => site.url.trim());
	const timeoutMs = Math.min(60, Math.max(1, el.timeout)) * 1000;
	// A little under the period, so the screen's own timer always finds a fresh result.
	const ttl = Math.max(1, el.interval) * 60 - 5;
	const checks = await mapLimit(sites, 4, (site): Promise<UptimeCheck> => {
		const url = site.url.trim();
		const key = `uptime:${Bun.hash([url, el.expected, timeoutMs].join("|"))}`;
		return cached(key, ttl, async () => {
			const result = await probe(url, timeoutMs);
			const up = !result.error && statusExpected(result.status, el.expected);
			const known = uptimeSince.get(key);
			const since = known && known.up === up ? known.since : Date.now();
			uptimeSince.set(key, { up, since });
			return { ...result, up, since };
		}).then((result) => ({
			...result,
			label: site.label.trim() || checkedUrlHost(url),
			error: result.error || (result.up ? "" : `HTTP ${result.status}`),
		}));
	});
	return { checks };
}

function checkedUrlHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

// ---------------------------------------------------------------- json value

// When each value last changed, for "changed … ago". In memory, like the MQTT elements' last messages.
const jsonChanged = new Map<string, { value: string; at: number }>();

function jsonState(
	source: string,
	body: string,
	row: { path: string; label: string; unit: string },
	host: string,
): HaEntityState {
	let value: string;
	try {
		value = messageValue(body, row.path);
	} catch (err) {
		// The helper is the MQTT element's and speaks of messages.
		throw new Error((err as Error).message.replace(/\bmessage\b/g, "answer"));
	}
	const key = `${source}|${row.path}`;
	const known = jsonChanged.get(key);
	if (jsonChanged.size > 2000) jsonChanged.clear();
	const at = known && known.value === value ? known.at : Date.now();
	jsonChanged.set(key, { value, at });
	const lastKey = row.path
		.replace(/\[(\w+)\]/g, ".$1")
		.split(".")
		.filter(Boolean)
		.at(-1);
	return {
		entity_id: key,
		state: value,
		name: row.label || lastKey || host,
		unit: row.unit,
		icon: "",
		device_class: "",
		last_changed: new Date(at).toISOString(),
		attributes: {},
	};
}

export async function jsonValue(el: El<"json">): Promise<JsonValueData> {
	const url = el.url.trim();
	if (!url) throw new Error("enter an address");
	const headers = parseHeaderLines(el.headers);
	const source = `json:${Bun.hash(`${url}\n${el.headers}`)}`;
	const body = await cached(source, Math.max(1, el.interval) * 60 - 5, () =>
		fetchBody(url, { headers, accept: "application/json, text/plain, */*" }),
	);
	const host = checkedUrl(url).host;
	if (el.variant === "value") return { state: jsonState(source, body, el, host), states: [] };
	// One path that is not there must not blank the rows that are.
	return {
		state: null,
		states: el.values.map((row) => {
			try {
				return jsonState(source, body, row, host);
			} catch {
				return null;
			}
		}),
	};
}

// --------------------------------------------------------------------- chart

/** The separator of a CSV text: whichever of , ; tab | splits its first line most. */
export function detectDelimiter(csv: string): string {
	const line = csv.trimStart().split(/\r?\n/, 1)[0] ?? "";
	let best = ",";
	let most = 0;
	for (const candidate of [",", ";", "\t", "|"]) {
		const count = parseCsv(line, candidate)[0]?.length ?? 0;
		if (count > most) {
			most = count;
			best = candidate;
		}
	}
	return best;
}

/**
 * CSV to rows of cells. Quoted cells may hold the separator, line breaks and
 * doubled quotes (`"a ""b"" c"`); empty lines are skipped.
 */
export function parseCsv(csv: string, delimiter = detectDelimiter(csv)): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	// Whether the current cell was quoted at all, so `""` stays an (empty) cell.
	let wasQuoted = false;
	const endCell = () => {
		row.push(wasQuoted ? cell : cell.trim());
		cell = "";
		wasQuoted = false;
	};
	const endRow = () => {
		endCell();
		if (row.length > 1 || row[0] !== "") rows.push(row);
		row = [];
	};
	const input = csv.replace(/^﻿/, "");
	for (let i = 0; i < input.length; i++) {
		const char = input[i] as string;
		if (quoted) {
			if (char !== '"') cell += char;
			else if (input[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = false;
		} else if (char === '"' && cell.trim() === "") {
			quoted = true;
			wasQuoted = true;
			cell = "";
		} else if (char === delimiter) endCell();
		else if (char === "\n") endRow();
		else if (char !== "\r") cell += char;
	}
	if (cell !== "" || wasQuoted || row.length) endRow();
	return rows;
}

/** A cell as a number: "1 234,5", "1,234.5", "12 %" and "€ 3.20" all count. */
export function toNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	let cleaned = value.replace(/[\s '%€$£]|[A-Z]{3}$/g, "");
	if (cleaned === "") return null;
	if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(cleaned)) cleaned = cleaned.replace(/,/g, "");
	else if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) cleaned = cleaned.replace(/\./g, "").replace(",", ".");
	else if (/^-?\d*,\d+$/.test(cleaned)) cleaned = cleaned.replace(",", ".");
	const number = Number(cleaned);
	return Number.isFinite(number) ? number : null;
}

export interface Table {
	header: string[];
	rows: unknown[][];
}

/** A table out of the JSON shapes people have: rows as objects, rows as arrays, a name → number map, or plain numbers. */
export function tableFromJson(value: unknown): Table {
	if (Array.isArray(value)) {
		if (value.every((row) => Array.isArray(row))) {
			const [first, ...rest] = value as unknown[][];
			// A first row without numbers is the header.
			const titled = first?.every((cell) => typeof cell === "string" && toNumber(cell) === null);
			if (titled) return { header: (first as string[]).map(String), rows: rest };
			return { header: (first ?? []).map((_, i) => (i === 0 ? "Label" : `Series ${i}`)), rows: value as unknown[][] };
		}
		if (value.every((row) => row !== null && typeof row === "object")) {
			const header = [...new Set((value as Json[]).flatMap((row) => Object.keys(row)))];
			return { header, rows: (value as Json[]).map((row) => header.map((key) => row[key])) };
		}
		return { header: ["Label", "Value"], rows: value.map((item, i) => [String(i + 1), item]) };
	}
	if (value !== null && typeof value === "object")
		return { header: ["Label", "Value"], rows: Object.entries(value as Json).map(([key, item]) => [key, item]) };
	throw new Error("the data is not a list");
}

/** Finds a column by its title or by its position (1 = first); -1 when there is none. */
function columnIndex(header: string[], wantedColumn: string): number {
	const name = wantedColumn.trim().toLowerCase();
	const byName = header.findIndex((title) => title.trim().toLowerCase() === name);
	if (byName >= 0) return byName;
	const position = /^\d+$/.test(name) ? Number(name) - 1 : -1;
	return position < header.length ? position : -1;
}

/**
 * Picks the label column and the value columns out of a table. Without a
 * choice the first column labels and every other column with numbers is drawn.
 */
export function chartFromTable(table: Table, labelColumn: string, valueColumns: string): ChartData {
	const { header } = table;
	const rows = table.rows.slice(0, 500);
	const numeric = (index: number) => rows.some((row) => toNumber(row[index]) !== null);
	let label = labelColumn.trim() ? columnIndex(header, labelColumn) : -1;
	if (labelColumn.trim() && label < 0) throw new Error(`there is no column "${labelColumn.trim()}"`);
	const chosen = valueColumns
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	let values: number[];
	if (chosen.length) {
		values = chosen.map((name) => {
			const index = columnIndex(header, name);
			if (index < 0) throw new Error(`there is no column "${name}"`);
			return index;
		});
	} else {
		// A single column of numbers has no labels of its own.
		if (label < 0 && header.length > 1) label = 0;
		values = header.map((_, i) => i).filter((i) => i !== label && numeric(i));
	}
	if (!values.length) throw new Error("no column with numbers was found");
	return {
		labels: rows.map((row, i) => (label < 0 ? String(i + 1) : String(row[label] ?? ""))),
		series: values.slice(0, 8).map((index) => ({
			name: header[index] ?? `Series ${index + 1}`,
			values: rows.map((row) => toNumber(row[index])),
		})),
	};
}

/** Chart data out of pasted or fetched text: CSV with a header row, or JSON (with a path to the list inside it). */
export function parseChartData(
	content: string,
	options: { format: string; path: string; labelColumn: string; valueColumns: string },
): ChartData {
	const body = content.trim();
	if (!body) return { labels: [], series: [] };
	const json = options.format === "json" || (options.format !== "csv" && /^[[{]/.test(body));
	let table: Table;
	if (json) {
		let value: unknown;
		try {
			// The path syntax (and its error messages) of the MQTT and JSON elements.
			value = JSON.parse(options.path.trim() ? messageValue(body, options.path) : body);
		} catch (err) {
			if (err instanceof SyntaxError) throw new Error("the data is not valid JSON");
			throw new Error((err as Error).message.replace(/\bmessage\b/g, "data"));
		}
		table = tableFromJson(value);
	} else {
		const [header, ...rows] = parseCsv(body);
		table = { header: header ?? [], rows };
	}
	return chartFromTable(table, options.labelColumn, options.valueColumns);
}

export async function chart(el: El<"chart">): Promise<ChartData> {
	let content = el.content;
	if (el.source === "url") {
		const url = el.url.trim();
		if (!url) throw new Error("enter an address");
		content = await cached(`chart:${Bun.hash(url)}`, Math.max(1, el.interval) * 60 - 5, () =>
			fetchBody(url, { accept: "text/csv, application/json, text/plain, */*", maxBytes: 4 * MB }),
		);
	}
	return parseChartData(content, el);
}
