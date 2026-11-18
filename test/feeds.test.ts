/**
 * The parsers behind the live-feed elements, fed with trimmed samples of what
 * the providers really answer. Nothing here touches the network.
 */
import { describe, expect, test } from "bun:test";
import {
	chartFromTable,
	coinId,
	detectDelimiter,
	filterDepartures,
	mergeEvents,
	monthsBetween,
	parseBkkDepartures,
	parseChartData,
	parseCoinGeckoMarkets,
	parseCsv,
	parseFinnhubQuote,
	parseFrankfurterSeries,
	parseHafasDepartures,
	parseHeaderLines,
	parsePair,
	parseScoreboard,
	parseSwissStationboard,
	parseYahooChart,
	pickEvents,
	statusExpected,
	tableFromJson,
	toNumber,
} from "../src/server/data/feeds";
import { pickVariant } from "../src/server/data/streams";
import type { SportsEvent } from "../src/shared/data";

describe("departures", () => {
	// v6.vbb.transport.rest/stops/900100003/departures
	const hafas = {
		departures: [
			{
				stop: { name: "S+U Alexanderplatz Bhf/Gontardstr. (Berlin)" },
				when: "2026-11-16T14:24:00+01:00",
				plannedWhen: "2026-11-16T14:21:00+01:00",
				delay: 180,
				platform: "Pos. 16",
				plannedPlatform: "Pos. 16",
				direction: "Hohenschönhausen, Zingster Str.",
				line: { name: "M5", product: "tram", color: { fg: "#fff", bg: "#C8893B" } },
				destination: { name: "Zingster Str. (Berlin)" },
			},
			{
				stop: { name: "S+U Alexanderplatz Bhf (Berlin)" },
				when: null,
				plannedWhen: "2026-11-16T14:30:00+01:00",
				delay: null,
				platform: null,
				plannedPlatform: "3",
				cancelled: true,
				direction: "S Erkner Bhf",
				line: { name: "S3" },
			},
		],
		realtimeDataUpdatedAt: 1794835400,
	};

	test("transport.rest: delay in minutes, colours, cancelled trips keep their planned time", () => {
		const data = parseHafasDepartures(hafas);
		expect(data.stop).toBe("S+U Alexanderplatz Bhf/Gontardstr. (Berlin)");
		expect(data.departures[0]).toEqual({
			line: "M5",
			destination: "Hohenschönhausen, Zingster Str.",
			when: Date.parse("2026-11-16T13:24:00Z"),
			planned: Date.parse("2026-11-16T13:21:00Z"),
			delay: 3,
			platform: "Pos. 16",
			cancelled: false,
			color: "#C8893B",
			textColor: "#fff",
		});
		expect(data.departures[1]).toMatchObject({
			line: "S3",
			cancelled: true,
			delay: null,
			platform: "3",
			when: Date.parse("2026-11-16T13:30:00Z"),
		});
		// v5 servers answer with the bare list.
		expect(parseHafasDepartures(hafas.departures).departures).toHaveLength(2);
		expect(parseHafasDepartures({ departures: [] })).toEqual({ stop: "", departures: [] });
	});

	test("Switzerland: prognosis, line names by category, unknown stop", () => {
		// transport.opendata.ch/v1/stationboard?id=8503000 and ?id=8591122
		const data = parseSwissStationboard({
			station: { id: "8503000", name: "Zürich HB" },
			stationboard: [
				{
					stop: {
						departure: "2026-11-16T14:26:00+0100",
						departureTimestamp: 1794835560,
						delay: 2,
						platform: "41/42",
						prognosis: { platform: null, departure: "2026-11-16T14:28:00+0100" },
					},
					name: "018352",
					category: "S",
					number: "3",
					to: "Zürich Hardbrücke",
				},
				{
					stop: {
						departure: "2026-11-16T14:29:00+0100",
						departureTimestamp: 1794835740,
						delay: 0,
						platform: "17",
						prognosis: { platform: "18", departure: "2026-11-16T14:29:00+0100" },
					},
					category: "IR",
					number: "55",
					to: "Biel/Bienne",
				},
				{
					stop: {
						departure: "2026-11-16T14:30:00+0100",
						departureTimestamp: 1794835800,
						delay: null,
						platform: null,
						prognosis: { platform: null, departure: null },
					},
					category: "B",
					number: "69",
					to: "Zürich, Milchbuck",
				},
			],
		});
		expect(data.stop).toBe("Zürich HB");
		expect(data.departures.map((d) => [d.line, d.delay, d.platform, (d.when - d.planned) / 60_000])).toEqual([
			["S3", 2, "41/42", 2],
			["IR 55", 0, "18", 0],
			["69", null, "", 0],
		]);
		expect(() => parseSwissStationboard({ station: null, stationboard: [] })).toThrow("not found");
	});

	test("BKK: epoch seconds, line and headsign through the references", () => {
		// Shape of arrivals-and-departures-for-stop as documented by BKK (not seen live: it needs a key).
		const data = parseBkkDepartures({
			currentTime: 1794835400000,
			version: 4,
			status: "OK",
			code: 200,
			text: "OK",
			data: {
				limitExceeded: false,
				entry: {
					stopId: "BKK_F01227",
					routeIds: ["BKK_3040"],
					stopTimes: [
						{
							stopId: "BKK_F01227",
							stopHeadsign: "Széll Kálmán tér M",
							departureTime: 1794835800,
							predictedDepartureTime: 1794835920,
							tripId: "BKK_C1",
							serviceDate: "20261116",
						},
						{ stopId: "BKK_F01227", arrivalTime: 1794835500, departureTime: 1794835500, tripId: "BKK_C2" },
					],
				},
				references: {
					routes: { BKK_3040: { id: "BKK_3040", shortName: "4", type: "TRAM", color: "FFD800", textColor: "000000" } },
					trips: {
						BKK_C1: { id: "BKK_C1", routeId: "BKK_3040", tripHeadsign: "Széll Kálmán tér M" },
						BKK_C2: { id: "BKK_C2", routeId: "BKK_3040", tripHeadsign: "Újbuda-központ M" },
					},
					stops: { BKK_F01227: { id: "BKK_F01227", name: "Corvin-negyed M" } },
				},
			},
		});
		expect(data.stop).toBe("Corvin-negyed M");
		// Sorted by the real departure; the trip without a headsign at the stop takes its trip's.
		expect(data.departures.map((d) => [d.line, d.destination, d.delay, d.color])).toEqual([
			["4", "Újbuda-központ M", null, "#FFD800"],
			["4", "Széll Kálmán tér M", 2, "#FFD800"],
		]);
		expect(data.departures[1]?.when).toBe(1794835920000);
		expect(() => parseBkkDepartures({ status: "NOT_FOUND", code: 404, text: "Stop not found" })).toThrow(
			"Stop not found",
		);
		expect(() => parseBkkDepartures({ status: "OK", data: {} })).toThrow("not found");
	});

	test("filters by line and by destination", () => {
		const { departures } = parseHafasDepartures(hafas);
		expect(filterDepartures(departures, "", "")).toHaveLength(2);
		expect(filterDepartures(departures, "m5, 100", "").map((d) => d.line)).toEqual(["M5"]);
		expect(filterDepartures(departures, "M", "")).toHaveLength(0);
		expect(filterDepartures(departures, "", "erkner, nowhere").map((d) => d.line)).toEqual(["S3"]);
		expect(filterDepartures(departures, "S 3", "zingster")).toHaveLength(0);
	});
});

describe("prices", () => {
	test("Yahoo chart: change against the previous day's close", () => {
		// query1.finance.yahoo.com/v8/finance/chart/AAPL?range=5d&interval=1d
		const quote = parseYahooChart({
			chart: {
				result: [
					{
						meta: {
							currency: "USD",
							symbol: "AAPL",
							regularMarketTime: 1794603601,
							gmtoffset: -18000,
							regularMarketPrice: 356.27,
							chartPreviousClose: 342.37,
						},
						timestamp: [1794234600, 1794321000, 1794407400, 1794493800, 1794580200],
						indicators: { quote: [{ close: [350.69, 348.51, null, 354.88, 356.2699] }] },
					},
				],
				error: null,
			},
		});
		expect(quote.price).toBe(356.27);
		expect(quote.currency).toBe("USD");
		expect(quote.change).toBeCloseTo(1.39, 2);
		expect(quote.percent).toBeCloseTo(0.3917, 3);
		// Closed days, then the current price; the gap in the data is skipped.
		expect(quote.history).toEqual([350.69, 348.51, 354.88, 356.27]);
		expect(() =>
			parseYahooChart({
				chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } },
			}),
		).toThrow("No data found");
	});

	test("CoinGecko markets, Frankfurter series, Finnhub quote", () => {
		// api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=true
		const coins = parseCoinGeckoMarkets(
			[
				{
					id: "bitcoin",
					symbol: "btc",
					current_price: 64077,
					price_change_24h: -1574.240863595347,
					price_change_percentage_24h: -2.35604,
					sparkline_in_7d: { price: [74846.7, 74658.5, 74798.1, 1, 2, 3, 70000.5, 64077] },
				},
			],
			"usd",
		);
		expect(coins.get("bitcoin")).toEqual({
			price: 64077,
			change: -1574.240863595347,
			percent: -2.35604,
			currency: "USD",
			history: [74846.7, 70000.5, 64077],
		});
		expect(() => parseCoinGeckoMarkets({ status: { error_code: 429, error_message: "Rate limited" } }, "usd")).toThrow(
			"Rate limited",
		);

		// api.frankfurter.dev/v1/2026-11-01..?base=EUR&symbols=USD,HUF
		const series = {
			amount: 1.0,
			base: "EUR",
			start_date: "2026-11-11",
			end_date: "2026-11-13",
			rates: {
				"2026-11-12": { HUF: 364.98, USD: 1.1081 },
				"2026-11-11": { HUF: 365.08, USD: 1.1127 },
				"2026-11-13": { HUF: 365.6, USD: 1.1052 },
			},
		};
		const huf = parseFrankfurterSeries(series, "HUF");
		expect(huf.price).toBe(365.6);
		expect(huf.change).toBeCloseTo(0.62, 5);
		expect(huf.history).toEqual([365.08, 364.98, 365.6]);
		expect(() => parseFrankfurterSeries(series, "XXX")).toThrow("no rate");

		expect(
			parseFinnhubQuote({ c: 261.74, d: 3.12, dp: 1.2064, h: 263.31, l: 260.68, o: 261.07, pc: 258.62 }),
		).toMatchObject({
			price: 261.74,
			change: 3.12,
			percent: 1.2064,
		});
		// finnhub.io/api/v1/quote with a bad key, and what an unknown symbol gets.
		expect(() => parseFinnhubQuote({ error: "Invalid API key." })).toThrow("Invalid API key");
		expect(() => parseFinnhubQuote({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 })).toThrow("no data");
	});

	test("symbols as people type them", () => {
		expect(parsePair("EUR/HUF")).toEqual(["EUR", "HUF"]);
		expect(parsePair(" eurhuf ")).toEqual(["EUR", "HUF"]);
		expect(parsePair("EUR")).toBeNull();
		expect(coinId("BTC")).toBe("bitcoin");
		expect(coinId(" Monero ")).toBe("monero");
	});
});

describe("scores", () => {
	const side = (homeAway: string, name: string, abbreviation: string, score: string, winner = false) => ({
		homeAway,
		score,
		winner,
		team: {
			id: "1",
			abbreviation,
			displayName: name,
			shortDisplayName: name,
			logo: `https://a.espncdn.com/i/teamlogos/soccer/500/${abbreviation}.png`,
		},
	});
	const status = (state: string, shortDetail: string, completed = state === "post") => ({
		displayClock: "0'",
		type: { state, completed, description: shortDetail, shortDetail },
	});
	// site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard
	const board = {
		leagues: [{ name: "English Premier League", abbreviation: "Premier League", slug: "eng.1" }],
		events: [
			{
				id: "401879233",
				date: "2026-11-21T12:30Z",
				name: "Fulham at Manchester City",
				shortName: "FUL @ MNC",
				status: status("pre", "Scheduled"),
				competitions: [{ competitors: [side("home", "Man City", "MNC", "0"), side("away", "Fulham", "FUL", "0")] }],
			},
			{
				id: "401879100",
				date: "2026-11-07T15:00Z",
				name: "Chelsea at Arsenal",
				status: status("post", "FT"),
				competitions: [
					{ competitors: [side("away", "Chelsea", "CHE", "1"), side("home", "Arsenal", "ARS", "2", true)] },
				],
			},
			{
				id: "401879101",
				date: "2026-11-08T15:00Z",
				name: "Everton at Leeds",
				status: status("post", "Postponed", false),
				competitions: [{ competitors: [side("home", "Leeds", "LEE", "0"), side("away", "Everton", "EVE", "0")] }],
			},
			{
				id: "600",
				date: "2026-11-20T00:30Z",
				name: "Las Vegas Grand Prix",
				status: status("pre", "Scheduled"),
				competitions: [{ competitors: [{ athlete: {} }, { athlete: {} }, { athlete: {} }] }],
			},
		],
	};

	test("ESPN scoreboard: sides, scores only once played, events without sides", () => {
		const data = parseScoreboard(board);
		expect(data.league).toBe("Premier League");
		expect(data.events[0]).toMatchObject({
			id: "401879233",
			date: "2026-11-21T12:30:00.000Z",
			state: "pre",
			home: { name: "Man City", short: "MNC", score: "" },
			away: { name: "Fulham", score: "" },
		});
		expect(data.events[1]).toMatchObject({
			state: "post",
			status: "FT",
			home: { name: "Arsenal", score: "2", winner: true },
			away: { name: "Chelsea", score: "1", winner: false },
		});
		expect(data.events[2]).toMatchObject({ status: "Postponed", home: { score: "" } });
		expect(data.events[3]).toMatchObject({ name: "Las Vegas Grand Prix", home: null, away: null });
		expect(() => parseScoreboard({ code: 400, message: "Failed to get events endpoint." })).toThrow(
			"Failed to get events",
		);
	});

	const event = (
		id: string,
		day: number,
		state: SportsEvent["state"],
		home = "Arsenal",
		away = "Chelsea",
	): SportsEvent => ({
		id,
		date: new Date(Date.UTC(2026, 10, day, 15)).toISOString(),
		state,
		status: "",
		name: `${away} at ${home}`,
		home: { name: home, short: home.slice(0, 3).toUpperCase(), logo: "", score: "", winner: false },
		away: { name: away, short: away.slice(0, 3).toUpperCase(), logo: "", score: "", winner: false },
	});

	test("picks the latest results, what is live and the next fixtures", () => {
		const events = [
			event("a", 1, "post"),
			event("b", 2, "post"),
			event("c", 3, "post", "Leeds", "Everton"),
			event("d", 4, "in"),
			event("e", 5, "pre"),
			event("f", 6, "pre", "Leeds", "Everton"),
			event("g", 7, "pre"),
		];
		const ids = (team: string, show: string, count: number) =>
			pickEvents(events, team, show, count)
				.map((e) => e.id)
				.join("");
		expect(ids("", "both", 5)).toBe("bcdef");
		expect(ids("", "both", 20)).toBe("abcdefg");
		expect(ids("", "results", 3)).toBe("bcd");
		expect(ids("", "fixtures", 2)).toBe("ef");
		expect(ids("leeds", "both", 4)).toBe("cf");
		// Short words are abbreviations and must match exactly: "ars" is not "Mars".
		expect(ids("EVE", "both", 4)).toBe("cf");
		expect(ids("eeds", "both", 4)).toBe("cf");
		expect(ids("lee", "both", 4)).toBe("cf");
		expect(ids("ee", "both", 4)).toBe("");
		// Few fixtures leave their room to results.
		expect(
			pickEvents(events.slice(0, 5), "", "both", 4)
				.map((e) => e.id)
				.join(""),
		).toBe("bcde");
	});

	test("merging keeps the freshest copy; months around a date", () => {
		const stale = event("x", 3, "pre");
		const live = event("x", 3, "in");
		expect(mergeEvents([[stale, event("y", 1, "post")], [live]]).map((e) => [e.id, e.state])).toEqual([
			["y", "post"],
			["x", "in"],
		]);
		expect(monthsBetween(Date.UTC(2026, 10, 16, 14), Date.UTC(2026, 10, 30))).toEqual(["202611"]);
		expect(monthsBetween(Date.UTC(2026, 11, 28), Date.UTC(2027, 0, 1, 9))).toEqual(["202612", "202701"]);
	});
});

describe("uptime and requests", () => {
	test("expected status", () => {
		expect(statusExpected(200, "")).toBe(true);
		expect(statusExpected(302, "")).toBe(true);
		expect(statusExpected(404, "")).toBe(false);
		expect(statusExpected(401, "200, 401")).toBe(true);
		expect(statusExpected(204, "200-299")).toBe(true);
		expect(statusExpected(301, "200-299")).toBe(false);
		expect(statusExpected(200, "nonsense")).toBe(false);
	});

	test("header lines", () => {
		expect(parseHeaderLines("Authorization: Bearer a:b\n\n X-Api-Key :  k \nnot a header\nEmpty:")).toEqual({
			Authorization: "Bearer a:b",
			"X-Api-Key": "k",
		});
		expect(() => parseHeaderLines("Bad name: x")).toThrow("not a valid header name");
	});
});

describe("chart data", () => {
	test("CSV with quotes, separators and line breaks", () => {
		expect(parseCsv('a,b,c\n1,"x, y",3\r\n\n"say ""hi""","line\nbreak",\n')).toEqual([
			["a", "b", "c"],
			["1", "x, y", "3"],
			['say "hi"', "line\nbreak", ""],
		]);
		expect(parseCsv("﻿Name;Value\n A ; 1,5 \n")).toEqual([
			["Name", "Value"],
			["A", "1,5"],
		]);
		expect(parseCsv('a,""\n')).toEqual([["a", ""]]);
		expect(parseCsv("")).toEqual([]);
		expect(detectDelimiter("a\tb\tc\n1,2\t3\t4")).toBe("\t");
		expect(detectDelimiter('"a,b";c')).toBe(";");
	});

	test("numbers as they are written", () => {
		expect(toNumber("1,5")).toBe(1.5);
		expect(toNumber("1,234.5")).toBe(1234.5);
		expect(toNumber("1.234,5")).toBe(1234.5);
		expect(toNumber("1 234")).toBe(1234);
		expect(toNumber("12 %")).toBe(12);
		expect(toNumber("€ 3.20")).toBe(3.2);
		expect(toNumber("-0.5")).toBe(-0.5);
		expect(toNumber("")).toBeNull();
		expect(toNumber("Jan")).toBeNull();
		expect(toNumber(7)).toBe(7);
		expect(toNumber(null)).toBeNull();
	});

	const options = { format: "auto", path: "", labelColumn: "", valueColumns: "" };

	test("CSV: first column labels, numeric columns are series", () => {
		expect(parseChartData("Month,Visitors,Note,Members\nJan,120,x,40\nFeb,,y,52", options)).toEqual({
			labels: ["Jan", "Feb"],
			series: [
				{ name: "Visitors", values: [120, null] },
				{ name: "Members", values: [40, 52] },
			],
		});
		expect(
			parseChartData("Month,Visitors,Members\nJan,120,40", { ...options, labelColumn: "month", valueColumns: "3" }),
		).toEqual({
			labels: ["Jan"],
			series: [{ name: "Members", values: [40] }],
		});
		expect(() => parseChartData("a,b\n1,2", { ...options, valueColumns: "nope" })).toThrow('no column "nope"');
		expect(() => parseChartData("a,b\nx,y", options)).toThrow("no column with numbers");
		expect(parseChartData("  ", options)).toEqual({ labels: [], series: [] });
	});

	test("JSON in the shapes people have, with a path", () => {
		expect(parseChartData('[{"day":"Mon","kwh":3.5},{"day":"Tue","kwh":"4,1"}]', options)).toEqual({
			labels: ["Mon", "Tue"],
			series: [{ name: "kwh", values: [3.5, 4.1] }],
		});
		expect(
			parseChartData('{"data":{"rows":[["Day","A"],["Mon",1],["Tue",2]]}}', { ...options, path: "data.rows" }),
		).toEqual({
			labels: ["Mon", "Tue"],
			series: [{ name: "A", values: [1, 2] }],
		});
		expect(parseChartData('{"apples":3,"pears":5}', options)).toEqual({
			labels: ["apples", "pears"],
			series: [{ name: "Value", values: [3, 5] }],
		});
		expect(parseChartData("[4,8,15]", options).series[0]?.values).toEqual([4, 8, 15]);
		expect(
			tableFromJson([
				[1, 2],
				[3, 4],
			]).header,
		).toEqual(["Label", "Series 1"]);
		expect(() => parseChartData('{"a":', { ...options, format: "json" })).toThrow("not valid JSON");
		expect(() => parseChartData('{"a":1}', { ...options, path: "b" })).toThrow('"b" is not in the data');
		// A single column of numbers is numbered.
		expect(chartFromTable({ header: ["n"], rows: [[5], [6]] }, "", "")).toEqual({
			labels: ["1", "2"],
			series: [{ name: "n", values: [5, 6] }],
		});
	});

	test("twitch: the rendition picked from a master playlist", () => {
		const master = [
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=6674066,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",VIDEO="chunked"',
			"https://playlist.example/1080",
			'#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p30",NAME="720p",AUTOSELECT=YES,DEFAULT=YES',
			'#EXT-X-STREAM-INF:BANDWIDTH=2373000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p30"',
			"https://playlist.example/720",
			'#EXT-X-STREAM-INF:BANDWIDTH=630000,RESOLUTION=640x360,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="360p30"',
			"https://playlist.example/360",
			'#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"',
			"https://playlist.example/audio",
		].join("\n");
		expect(pickVariant(master, 0)).toBe("https://playlist.example/1080");
		expect(pickVariant(master, 720)).toBe("https://playlist.example/720");
		expect(pickVariant(master, 480)).toBe("https://playlist.example/360");
		// Nothing that small: the smallest picture, never the sound alone.
		expect(pickVariant(master, 160)).toBe("https://playlist.example/360");
		expect(pickVariant("#EXTM3U", 0)).toBeNull();
	});
});
