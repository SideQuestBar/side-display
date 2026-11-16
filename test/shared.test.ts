import { describe, expect, test } from "bun:test";
import { moonPath, moonPhase, sunTimes } from "../src/shared/astro";
import { dither, inkColor, PALETTES } from "../src/shared/color";
import { ELEMENT_TYPES, ELEMENTS } from "../src/shared/elements";
import {
	canHold,
	childLists,
	cloneElement,
	convertLegacyLayout,
	entitiesOf,
	isLegacyLayout,
	locate,
	makeElement,
	normalizeElements,
	normalizeLayoutSettings,
	normalizePlaylist,
	walk,
} from "../src/shared/layout";
import { renderMarkdown } from "../src/shared/markdown";
import { TEMPLATES } from "../src/shared/templates";
import {
	filterEvents,
	formatDatePattern,
	formatMinutes,
	formatTimePattern,
	fractionBetween,
	holidayDates,
	hoursState,
	hoursStatus,
	inSchedule,
	occurrencesAround,
	parseRanges,
	parseTime,
	periodRange,
	timetableAt,
	upcomingAnniversaries,
	type WeekHours,
	wallInstant,
	weekOffsets,
	withHolidays,
	zoned,
	zonedInstant,
} from "../src/shared/time";
import { type AnyEl, ELEMENT_COMMON_DEFAULTS } from "../src/shared/types";

describe("elements", () => {
	test("every type builds, survives normalisation unchanged, and only has fields for real properties", () => {
		for (const type of ELEMENT_TYPES) {
			const el = makeElement(type);
			expect(normalizeElements([el])).toEqual([el]);
			for (const field of ELEMENTS[type].fields) expect(field.key in el).toBe(true);
		}
	});

	test("no element names a property after one every element has", () => {
		const common = Object.keys(ELEMENT_COMMON_DEFAULTS);
		for (const type of ELEMENT_TYPES) {
			const clash = Object.keys(ELEMENTS[type].defaults).filter((key) => common.includes(key));
			expect([type, clash]).toEqual([type, []]);
		}
	});

	test("templates produce valid layouts", () => {
		for (const template of TEMPLATES) {
			const { settings, elements } = template.build();
			expect(normalizeLayoutSettings(settings)).toEqual(settings);
			expect(normalizeElements(elements)).toEqual(elements);
		}
	});

	test("normalisation drops unknown types, repairs bad values and de-duplicates ids", () => {
		const out = normalizeElements([
			{ type: "text", id: "a", size: "not a number", align: 3 },
			{ type: "nope" },
			{ type: "clock", id: "a" },
			null,
		]);
		expect(out.map((e) => e.type)).toEqual(["text", "clock"]);
		expect(out[0]!.size).toBe(56);
		expect(out[0]!.align).toBe("3");
		expect(out[0]!.id).not.toBe(out[1]!.id);
	});

	test("columns cannot nest and their children always flow", () => {
		const [columns] = normalizeElements([
			{ type: "columns", columns: [[{ type: "sticker" }, { type: "columns", columns: [[{ type: "text" }]] }], "junk"] },
		]);
		const children = columns!.columns as AnyEl[][];
		expect(children).toHaveLength(2);
		expect(children[0]!.map((c) => c.type)).toEqual(["sticker"]);
		expect(children[0]![0]!.placement).toBe("flow");
		expect(children[1]).toEqual([]);
	});

	test("a carousel holds elements but no container, and sits in a column", () => {
		const [columns, carousel] = normalizeElements([
			{ type: "columns", columns: [[{ type: "carousel", elements: [{ type: "map" }, { type: "carousel" }] }]] },
			{
				type: "carousel",
				elements: [{ type: "image", slideSeconds: 30 }, { type: "columns" }, { type: "video", slideSeconds: -5 }, 7],
			},
		]);
		const nested = (columns!.columns as AnyEl[][])[0]![0]!;
		expect(nested.type).toBe("carousel");
		expect((nested.elements as AnyEl[]).map((c) => c.type)).toEqual(["map"]);
		const slides = carousel!.elements as AnyEl[];
		expect(slides.map((c) => [c.type, c.slideSeconds])).toEqual([
			["image", 30],
			["video", 0],
		]);
		const seen: string[] = [];
		walk([columns!, carousel!], (el, parent) => seen.push(`${parent?.type ?? "top"}>${el.type}`));
		expect(seen).toEqual([
			"top>columns",
			"columns>carousel",
			"carousel>map",
			"top>carousel",
			"carousel>image",
			"carousel>video",
		]);
		expect(locate([carousel!], slides[1]!.id)).toEqual({ list: slides, index: 1 });
		expect(cloneElement(carousel!).elements).not.toEqual(slides);
	});

	test("containers nest one way: arranging ones hold picking ones, which hold plain elements", () => {
		expect(canHold(null, "columns")).toBe(true);
		expect(canHold("columns", "carousel")).toBe(true);
		expect(canHold("grid", "switch")).toBe(true);
		expect(canHold("grid", "columns")).toBe(false);
		expect(canHold("carousel", "switch")).toBe(false);
		expect(canHold("switch", "text")).toBe(true);
		const [grid] = normalizeElements([
			{
				type: "grid",
				cells: [
					{ type: "text", spanCols: 99, spanRows: 0 },
					{ type: "grid" },
					{ type: "switch", cases: [{ type: "clock" }, { type: "carousel" }] },
				],
			},
		]);
		const cells = grid!.cells as AnyEl[];
		expect(cells.map((c) => c.type)).toEqual(["text", "switch"]);
		expect([cells[0]!.spanCols, cells[0]!.spanRows]).toEqual([12, 1]);
		expect((cells[1]!.cases as AnyEl[]).map((c) => c.type)).toEqual(["clock"]);
		expect(childLists(grid!)).toEqual([cells]);
		expect(childLists(makeElement("text"))).toEqual([]);
	});

	test("tree helpers find, locate and clone with fresh ids", () => {
		const inner = makeElement("ha-entity", { entity: "sensor.a", showEntity: "binary_sensor.b" });
		const tree = [makeElement("columns", { columns: [[inner], []] }), makeElement("text")];
		const seen: string[] = [];
		walk(tree, (el) => seen.push(el.type));
		expect(seen).toEqual(["columns", "ha-entity", "text"]);
		expect(locate(tree, inner.id)?.index).toBe(0);
		expect(entitiesOf(inner).sort()).toEqual(["binary_sensor.b", "sensor.a"]);
		const copy = cloneElement(tree[0]!);
		expect(copy.id).not.toBe(tree[0]!.id);
		expect((copy.columns as AnyEl[][])[0]![0]!.id).not.toBe(inner.id);
	});

	test("playlists keep only well-formed entries", () => {
		expect(normalizePlaylist([{ layoutId: "x", seconds: 1 }, { seconds: 5 }, "no"])).toEqual([
			{ layoutId: "x", seconds: 3, days: [], from: "", to: "" },
		]);
	});
});

describe("import from sidequest-bar", () => {
	const legacy = {
		name: "TV",
		settings: {
			spacing: 16,
			padding: 32,
			verticalAlign: "top",
			background: "#5a839a",
			backgroundImage: "/display/bg.jpg",
		},
		elements: [
			{ id: "1", type: "message", text: { en: "Hello", hu: "Szia" }, textSize: 40 },
			{
				id: "2",
				type: "columns",
				columns: [
					[
						{
							id: "3",
							type: "qr",
							shortUrl: "https://s.example/x",
							url: "https://example.com",
							text: { en: "Scan" },
							textPosition: "below",
						},
					],
					[{ id: "4", type: "events", count: 3, daysLimit: null }],
				],
			},
			{ id: "5", type: "hours", variant: "long", textSize: 30 },
			{
				id: "6",
				type: "slideshow",
				slides: [{ id: "s", title: { en: "One" }, subtitle: null, image: "/display/a.jpg" }],
			},
		],
	};

	test("is recognised and converted", () => {
		expect(isLegacyLayout(legacy)).toBe(true);
		expect(isLegacyLayout({ elements: [makeElement("text")] })).toBe(false);
		const { settings, elements } = convertLegacyLayout(legacy, "https://bar.example/");
		expect(settings.backgroundImage).toBe("https://bar.example/display/bg.jpg");
		expect(elements.map((e) => e.type)).toEqual(["text", "columns", "hours", "slideshow"]);
		expect(elements[0]!.text).toBe("Hello");
		const columns = elements[1]!.columns as AnyEl[][];
		expect(columns[0]![0]).toMatchObject({ type: "qr", url: "https://s.example/x", caption: "Scan" });
		expect(columns[1]![0]!.type).toBe("calendar");
		expect(elements[2]!.variant).toBe("week");
		expect((elements[3]!.slides as { image: string }[])[0]!.image).toBe("https://bar.example/display/a.jpg");
	});
});

describe("markdown", () => {
	test("renders the supported syntax", () => {
		expect(renderMarkdown("# Title\n\nSome **bold** and *italic*\n- one\n- two")).toBe(
			"<h1>Title</h1><p>Some <strong>bold</strong> and <em>italic</em></p><ul><li>one</li><li>two</li></ul>",
		);
		expect(renderMarkdown("a\nb")).toBe("<p>a<br>b</p>");
	});

	test("escapes HTML and refuses script links", () => {
		expect(renderMarkdown('<img src=x onerror="alert(1)">')).toBe(
			"<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>",
		);
		expect(renderMarkdown("[x](javascript:alert(1))")).not.toContain("<a");
		expect(renderMarkdown("[x](https://example.com)")).toBe('<p><a href="https://example.com">x</a></p>');
	});
});

describe("time", () => {
	const at = (iso: string) => zoned(new Date(iso), "Europe/Budapest");

	test("zoned parts follow the time zone", () => {
		// 23:30 UTC is already the next day in Budapest (UTC+1 in winter).
		expect(at("2026-01-10T23:30:00Z")).toMatchObject({ date: "2026-01-11", hour: 0, minute: 30, weekday: 0 });
	});

	test("times and ranges parse", () => {
		expect(parseTime("16:30")).toBe(990);
		expect(parseTime("24:00")).toBe(1440);
		expect(parseTime("nope")).toBeNull();
		expect(parseRanges("12:00-14:00, 18:00-01:00")).toEqual([
			[720, 840],
			[1080, 1500],
		]);
	});

	test("schedules handle days and windows past midnight", () => {
		const friday2330 = at("2026-01-09T22:30:00Z");
		const saturday0030 = at("2026-01-09T23:30:00Z");
		expect(inSchedule(friday2330, [], "", "")).toBe(true);
		expect(inSchedule(friday2330, [5], "22:00", "02:00")).toBe(true);
		// Still Friday's window, although the calendar says Saturday.
		expect(inSchedule(saturday0030, [5], "22:00", "02:00")).toBe(true);
		expect(inSchedule(saturday0030, [6], "22:00", "02:00")).toBe(false);
		expect(inSchedule(friday2330, [5], "09:00", "17:00")).toBe(false);
	});

	const week: WeekHours = {
		mon: "",
		tue: "16:00-23:00",
		wed: "16:00-23:00",
		thu: "16:00-23:00",
		fri: "16:00-01:00",
		sat: "14:00-01:00",
		sun: "14:00-22:00",
	};

	test("opening hours: open, closing soon, and open past midnight", () => {
		expect(hoursStatus(week, [], at("2026-01-06T17:00:00Z"))).toMatchObject({
			open: true,
			closesAt: 23 * 60,
			soon: false,
		});
		expect(hoursStatus(week, [], at("2026-01-06T21:45:00Z"))).toMatchObject({ open: true, soon: true });
		// Saturday 00:30 still belongs to Friday's 16:00-01:00.
		expect(hoursStatus(week, [], at("2026-01-09T23:30:00Z"))).toMatchObject({ open: true, closesAt: 60 });
	});

	test("opening hours: next opening skips closed days", () => {
		// Sunday 23:00: closed, Monday is closed all day, so Tuesday 16:00.
		expect(hoursStatus(week, [], at("2026-01-11T22:00:00Z"))).toEqual({
			open: false,
			opensAt: 16 * 60,
			inDays: 2,
			weekday: 2,
			note: "",
		});
		// Tuesday morning: opens today.
		expect(hoursStatus(week, [], at("2026-01-06T09:00:00Z"))).toMatchObject({
			open: false,
			inDays: 0,
			opensAt: 16 * 60,
		});
	});

	test("opening hours: closures close a whole day or part of it", () => {
		const wholeDay = [{ date: "2026-01-06", from: "", to: "", note: "Private event" }];
		expect(hoursStatus(week, wholeDay, at("2026-01-06T17:00:00Z"))).toMatchObject({
			open: false,
			inDays: 1,
			note: "Private event",
		});
		const evening = [{ date: "2026-01-06", from: "20:00", to: "23:00", note: "" }];
		expect(hoursStatus(week, evening, at("2026-01-06T17:00:00Z"))).toMatchObject({ open: true, closesAt: 20 * 60 });
		expect(
			hoursStatus({ ...week, tue: "", wed: "", thu: "", fri: "", sat: "", sun: "" }, [], at("2026-01-06T17:00:00Z")),
		).toMatchObject({ open: false, opensAt: null });
	});

	test("week list order: Monday, Sunday or today first, never a past day", () => {
		// Today is Wednesday (3).
		expect(weekOffsets(3, null)).toEqual([0, 1, 2, 3, 4, 5, 6]);
		expect(weekOffsets(3, 1)).toEqual([5, 6, 0, 1, 2, 3, 4]);
		expect(weekOffsets(3, 0)).toEqual([4, 5, 6, 0, 1, 2, 3]);
		expect(weekOffsets(0, 1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
	});

	test("custom date patterns", () => {
		const day = Date.parse("2026-03-03T12:00:00Z");
		expect(formatDatePattern("dddd D MMMM YYYY", day, "en-GB", "UTC")).toBe("Tuesday 3 March 2026");
		expect(formatDatePattern("ddd, MMM D", day, "en-US", "UTC")).toBe("Tue, Mar 3");
		expect(formatDatePattern("YYYY-MM-DD", day, "en-GB", "UTC")).toBe("2026-03-03");
		expect(formatDatePattern("D.M.YY", day, "de-DE", "UTC")).toBe("3.3.26");
		expect(formatDatePattern("[Week] W, [Day] D", day, "en-GB", "UTC")).toBe("Week 10, Day 3");
		expect(formatDatePattern("dddd D MMMM", day, "fr-FR", "UTC")).toBe("mardi 3 mars");
		// Inflected next to a day number, plain on its own.
		expect(formatDatePattern("D MMMM", day, "ru-RU", "UTC")).toBe("3 марта");
		expect(formatDatePattern("MMMM YYYY", day, "ru-RU", "UTC")).toBe("март 2026");
		// The date follows the time zone; a mistyped locale does not throw.
		expect(formatDatePattern("D", Date.parse("2026-03-03T23:30:00Z"), "en-GB", "Europe/Budapest")).toBe("4");
		expect(formatDatePattern("D M", day, "not a locale", "UTC")).toBe("3 3");
	});

	test("minutes format in 12 and 24 hours", () => {
		expect(formatMinutes(9 * 60 + 5, "en-GB", "24")).toBe("09:05");
		expect(formatMinutes(25 * 60, "en-GB", "24")).toBe("01:00");
		expect(formatMinutes(16 * 60 + 30, "en-US", "12")).toMatch(/^4:30\sPM$/);
	});
});

describe("ePaper colours", () => {
	test("colours map to the inks of each mode", () => {
		expect(inkColor("#ffd24a", "full")).toBe("#ffd24a");
		// One ink: an accent turns black on white paper, white on black paper.
		expect(inkColor("#ffd24a", "mono")).toBe("#000000");
		expect(inkColor("#ffd24a", "mono", true)).toBe("#ffffff");
		expect(inkColor("#fefefe", "mono")).toBe("#ffffff");
		expect(inkColor("#d02020", "color6")).toBe("#c81e1e");
		expect(inkColor("#808080", "gray")).toBe("#888888");
		// Translucent colours are blended with the paper first.
		expect(inkColor("#00000010", "mono")).toBe("#ffffff");
	});

	test("dithering only produces palette colours and keeps the overall brightness", () => {
		const width = 64;
		const height = 64;
		const pixels = new Uint8ClampedArray(width * height * 4);
		for (let i = 0; i < width * height; i++) pixels.set([128, 128, 128, 255], i * 4);
		dither(pixels, width, height, "mono");
		let white = 0;
		for (let i = 0; i < width * height; i++) {
			const value = pixels[i * 4]!;
			expect(value === 0 || value === 255).toBe(true);
			if (value === 255) white++;
		}
		expect(white / (width * height)).toBeCloseTo(0.5, 1);
	});

	test("dithering stays bounded for colours the inks cannot reproduce, and keeps transparency", () => {
		const width = 32;
		const height = 32;
		const pixels = new Uint8ClampedArray(width * height * 4);
		// Top half: a saturated orange outside the 6-colour gamut. Bottom half: white.
		for (let i = 0; i < width * height; i++)
			pixels.set(i < (width * height) / 2 ? [255, 120, 0, 255] : [255, 255, 255, 255], i * 4);
		pixels.set([0, 0, 0, 0], (width * height - 1) * 4);
		dither(pixels, width, height, "color6");
		const palette = new Set(PALETTES.color6.map((c) => c.join()));
		let stray = 0;
		for (let i = 0; i < width * height - 1; i++) {
			expect(palette.has([pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]].join())).toBe(true);
			// Error carried over from the orange must not bleed deep into the white half.
			if (i >= width * (height / 2 + 2) && pixels[i * 4 + 2] !== 255) stray++;
		}
		expect(stray).toBe(0);
		expect(pixels[(width * height - 1) * 4 + 3]).toBe(0);
	});
});

describe("time elements", () => {
	const zone = "Europe/Budapest";
	const at = (iso: string) => zoned(new Date(iso), zone);
	const ms = (iso: string) => Date.parse(iso);

	test("custom time patterns", () => {
		const t = ms("2026-03-03T14:05:09Z");
		expect(formatTimePattern("HH:mm:ss", t, "UTC")).toBe("14:05:09");
		expect(formatTimePattern("h:mm A", t, "UTC")).toBe("2:05 PM");
		expect(formatTimePattern("hh.mm a", t, "UTC")).toBe("02.05 pm");
		expect(formatTimePattern("H [h] mm", t, "UTC")).toBe("14 h 05");
		expect(formatTimePattern("HH:mm", t, zone)).toBe("15:05");
		expect(formatTimePattern("h A", ms("2026-03-03T00:30:00Z"), "UTC")).toBe("12 AM");
	});

	test("wall-clock times become instants, summer and winter", () => {
		expect(zonedInstant("2026-07-01", 9 * 60, zone)).toBe(ms("2026-07-01T07:00:00Z"));
		expect(zonedInstant("2026-01-10", 0, zone)).toBe(ms("2026-01-09T23:00:00Z"));
		expect(wallInstant("2026-12-24T18:00", zone)).toBe(ms("2026-12-24T17:00:00Z"));
		expect(wallInstant("soon", zone)).toBeNaN();
	});

	test("recurring countdown targets: the next and the previous occurrence", () => {
		const friday = { repeat: "weekly" as const, time: "18:00", weekday: 5, date: "" };
		expect(occurrencesAround(friday, ms("2026-01-07T12:00:00Z"), zone)).toEqual({
			previous: ms("2026-01-02T17:00:00Z"),
			next: ms("2026-01-09T17:00:00Z"),
		});
		// At the very moment it starts over.
		expect(occurrencesAround(friday, ms("2026-01-09T17:00:00Z"), zone)).toEqual({
			previous: ms("2026-01-09T17:00:00Z"),
			next: ms("2026-01-16T17:00:00Z"),
		});
		const daily = { repeat: "daily" as const, time: "08:00", weekday: 0, date: "" };
		expect(occurrencesAround(daily, ms("2026-01-07T12:00:00Z"), zone)).toEqual({
			previous: ms("2026-01-07T07:00:00Z"),
			next: ms("2026-01-08T07:00:00Z"),
		});
		// The clocks go forward in the night in between: 08:00 is an hour earlier in UTC.
		expect(occurrencesAround(daily, ms("2026-03-28T12:00:00Z"), zone)?.next).toBe(ms("2026-03-29T06:00:00Z"));
		const yearly = { repeat: "yearly" as const, time: "", weekday: 0, date: "12-25" };
		expect(occurrencesAround(yearly, ms("2026-12-26T12:00:00Z"), zone)).toEqual({
			previous: ms("2026-12-24T23:00:00Z"),
			next: ms("2027-12-24T23:00:00Z"),
		});
		expect(occurrencesAround({ ...yearly, date: "02-29" }, ms("2026-01-10T12:00:00Z"), zone)?.next).toBe(
			ms("2026-02-27T23:00:00Z"),
		);
		expect(occurrencesAround({ ...yearly, date: "soon" }, ms("2026-01-10T12:00:00Z"), zone)).toBeNull();
	});

	test("periods: day, week, month, quarter and year", () => {
		// Monday 16 November 2026, 11:00 in Budapest.
		const now = at("2026-11-16T10:00:00Z");
		expect(periodRange("day", now, zone)).toEqual([ms("2026-11-15T23:00:00Z"), ms("2026-11-16T23:00:00Z")]);
		expect(periodRange("week", now, zone)).toEqual([ms("2026-11-15T23:00:00Z"), ms("2026-11-22T23:00:00Z")]);
		expect(periodRange("week", now, zone, 0)).toEqual([ms("2026-11-14T23:00:00Z"), ms("2026-11-21T23:00:00Z")]);
		expect(periodRange("month", now, zone)).toEqual([ms("2026-10-31T23:00:00Z"), ms("2026-11-30T23:00:00Z")]);
		// The quarter began in summer time.
		expect(periodRange("quarter", now, zone)).toEqual([ms("2026-09-30T22:00:00Z"), ms("2026-12-31T23:00:00Z")]);
		expect(periodRange("year", now, zone)).toEqual([ms("2025-12-31T23:00:00Z"), ms("2026-12-31T23:00:00Z")]);
		expect(fractionBetween(0, 10, 5)).toBe(0.5);
		expect(fractionBetween(0, 10, -3)).toBe(0);
		expect(fractionBetween(0, 10, 30)).toBe(1);
	});

	test("timetable: now and next, past midnight and around the week", () => {
		const rows = [
			{ title: "Class", days: [1, 2, 3, 4, 5], from: "09:00", to: "12:00" },
			{ title: "Late", days: [5], from: "22:00", to: "02:00" },
			{ title: "Brunch", days: [0], from: "10:00", to: "11:00" },
			{ title: "Bell", days: [], from: "20:00", to: "" },
			{ title: "Broken", days: [], from: "", to: "10:00" },
		];
		const titles = (slots: { row: { title: string } }[]) => slots.map((s) => s.row.title);
		// Monday 10:00.
		const monday = timetableAt(rows, at("2026-01-05T09:00:00Z"));
		expect(titles(monday.current)).toEqual(["Class"]);
		expect(monday.next.slice(0, 2).map((s) => [s.row.title, s.start])).toEqual([
			["Bell", 20 * 60],
			["Class", 1440 + 9 * 60],
		]);
		expect(titles(monday.today)).toEqual(["Class", "Bell"]);
		// Saturday 01:00: Friday's late slot is still on.
		const saturday = timetableAt(rows, at("2026-01-10T00:00:00Z"));
		expect(saturday.current).toEqual([{ row: rows[1]!, start: -120, end: 120 }]);
		expect(titles(saturday.today)).toEqual(["Late", "Bell"]);
		// Saturday 23:00: next is Sunday's brunch, then the bell, then Monday's class.
		const late = timetableAt(rows, at("2026-01-10T22:00:00Z"));
		expect(late.current).toEqual([]);
		expect(late.next.slice(0, 3).map((s) => [s.row.title, s.start])).toEqual([
			["Brunch", 1440 + 10 * 60],
			["Bell", 1440 + 20 * 60],
			["Class", 2 * 1440 + 9 * 60],
		]);
		// Nothing is listed twice: at most a week ahead.
		expect(late.next.filter((s) => s.row.title === "Brunch")).toHaveLength(1);
		expect(late.next.filter((s) => s.row.title === "Bell")).toHaveLength(7);
	});

	test("birthdays: sorted, with ages, 29 February and the turn of the year", () => {
		const people = [
			{ name: "Ada", date: "1990-02-29" },
			{ name: "Bob", date: "03-01" },
			{ name: "Cy", date: "1980-02-27" },
			{ name: "Di", date: "2000-12-31" },
			{ name: "Eve", date: "--01-02" },
			{ name: "Nobody", date: "13-45" },
		];
		const list = (today: string, days: number, leap?: "feb28" | "mar1") =>
			upcomingAnniversaries(people, today, days, leap).map((a) => [a.row.name, a.date, a.inDays, a.years]);
		expect(list("2026-02-27", 7)).toEqual([
			["Cy", "2026-02-27", 0, 46],
			["Ada", "2026-02-28", 1, 36],
			["Bob", "2026-03-01", 2, null],
		]);
		expect(list("2026-02-27", 7, "mar1")[1]).toEqual(["Ada", "2026-03-01", 2, 36]);
		// A leap year has the real day.
		expect(list("2028-02-27", 2)[1]).toEqual(["Ada", "2028-02-29", 2, 38]);
		expect(list("2026-12-30", 5)).toEqual([
			["Di", "2026-12-31", 1, 26],
			["Eve", "2027-01-02", 3, null],
		]);
	});

	test("calendar filters: keywords and all-day events", () => {
		const events = [
			{ title: "Quiz night", start: "2026-01-06T18:00:00Z", end: "2026-01-06T20:00:00Z", allDay: false },
			{ title: "Private party", start: "2026-01-07T18:00:00Z", end: "2026-01-07T20:00:00Z", allDay: false },
			{ title: "Epiphany", start: "2026-01-06", end: "2026-01-07", allDay: true },
		];
		const titles = (filter: Parameters<typeof filterEvents>[1]) => filterEvents(events, filter).map((e) => e.title);
		expect(titles({})).toHaveLength(3);
		expect(titles({ include: "quiz, PARTY" })).toEqual(["Quiz night", "Private party"]);
		expect(titles({ include: "quiz, party", exclude: " private ," })).toEqual(["Quiz night"]);
		expect(titles({ hideAllDay: true })).toEqual(["Quiz night", "Private party"]);
	});

	test("opening hours: holidays close the day and carry their name", () => {
		const week: WeekHours = { mon: "", tue: "16:00-23:00", wed: "16:00-23:00", thu: "", fri: "", sat: "", sun: "" };
		const holidays = holidayDates([
			{ title: "Epiphany", start: "2026-01-06", end: "2026-01-07", allDay: true },
			{ title: "Winter break", start: "2026-02-02", end: "2026-02-05", allDay: true },
			{ title: "Not a holiday", start: "2026-01-07T10:00:00Z", end: "2026-01-07T11:00:00Z", allDay: false },
		]);
		expect(holidays.map((h) => h.date)).toEqual(["2026-01-06", "2026-02-02", "2026-02-03", "2026-02-04"]);
		const closures = withHolidays([], holidays);
		// Tuesday 18:00 would be open; the holiday moves the next opening to Wednesday.
		const status = hoursStatus(week, closures, at("2026-01-06T17:00:00Z"));
		expect(status).toMatchObject({ open: false, inDays: 1, opensAt: 16 * 60, note: "Epiphany" });
		expect(hoursState(status)).toBe("closed");
		expect(hoursState(hoursStatus(week, [], at("2026-01-06T17:00:00Z")))).toBe("open");
		expect(hoursState(hoursStatus(week, [], at("2026-01-06T21:45:00Z")))).toBe("soon");
	});

	test("sunrise and sunset match published times", () => {
		const near = (value: number | null, iso: string) =>
			expect(Math.abs((value ?? 0) - ms(iso))).toBeLessThanOrEqual(2 * 60_000);
		// London, summer solstice 2024: 04:43 and 21:21 BST.
		const london = sunTimes("2024-06-21", 51.5074, -0.1278);
		near(london.rise, "2024-06-21T03:43:00Z");
		near(london.set, "2024-06-21T20:21:00Z");
		// New York, winter solstice 2024: 07:17 and 16:32 EST.
		const newYork = sunTimes("2024-12-21", 40.7128, -74.006);
		near(newYork.rise, "2024-12-21T12:17:00Z");
		near(newYork.set, "2024-12-21T21:32:00Z");
		expect(Math.round(newYork.dayLength)).toBe(555);
		// Wellington is half a day ahead of UTC: its morning is the evening before there.
		near(sunTimes("2026-01-15", -41.2866, 174.7756).rise, "2026-01-14T17:05:00Z");
		// Tromsø: midnight sun and polar night.
		expect(sunTimes("2024-06-21", 69.6492, 18.9553)).toMatchObject({ rise: null, set: null, polar: "day" });
		expect(sunTimes("2024-12-21", 69.6492, 18.9553)).toMatchObject({ polar: "night", dayLength: 0 });
	});

	test("moon phases match known new and full moons", () => {
		// Within an hour and a half of the published instants (0.002 of a cycle).
		const offBy = (iso: string, phase: number) => {
			const d = Math.abs(moonPhase(ms(iso)).phase - phase);
			return Math.min(d, 1 - d);
		};
		expect(offBy("2000-01-06T18:14:00Z", 0)).toBeLessThan(0.002);
		expect(offBy("2024-04-08T18:21:00Z", 0)).toBeLessThan(0.002);
		expect(offBy("2024-04-23T23:49:00Z", 0.5)).toBeLessThan(0.002);
		expect(offBy("2025-03-14T06:55:00Z", 0.5)).toBeLessThan(0.002);
		expect(offBy("2026-02-17T12:01:00Z", 0)).toBeLessThan(0.002);
		expect(moonPhase(ms("2024-04-23T23:49:00Z"))).toMatchObject({ name: "full" });
		expect(moonPhase(ms("2024-04-23T23:49:00Z")).illumination).toBeGreaterThan(0.999);
		expect(moonPhase(ms("2024-04-13T12:00:00Z")).name).toBe("waxing-crescent");
		expect(moonPhase(ms("2024-05-03T12:00:00Z")).name).toBe("waning-crescent");
	});

	test("the moon is lit on the right when waxing in the north, on the left in the south", () => {
		// The first arc is the lit limb: sweep flag 1 goes round the right-hand side.
		expect(moonPath(0.2, 10)).toStartWith("M0 -10A10 10 0 0 1 0 10");
		expect(moonPath(0.2, 10, true)).toStartWith("M0 -10A10 10 0 0 0 0 10");
		expect(moonPath(0.8, 10)).toStartWith("M0 -10A10 10 0 0 0 0 10");
		// A crescent's terminator curves back on the lit side, a gibbous one bulges away from it.
		expect(moonPath(0.2, 10)).toEndWith("0 0 0 0 -10Z");
		expect(moonPath(0.4, 10)).toEndWith("0 0 1 0 -10Z");
	});
});
