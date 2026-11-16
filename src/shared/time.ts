/**
 * Time helpers that work in any IANA time zone without a date library:
 * schedules (days + time window) and the opening-hours element's logic.
 */

export interface ZonedParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
	/** 0 = Sunday. */
	weekday: number;
	/** `YYYY-MM-DD` in that zone. */
	date: string;
	/** Minutes since midnight. */
	minutes: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		const options: Intl.DateTimeFormatOptions = {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			weekday: "short",
			hourCycle: "h23",
		};
		try {
			f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone || undefined });
		} catch {
			// Unknown zone name: fall back to the device's zone rather than crash.
			f = new Intl.DateTimeFormat("en-US", options);
		}
		formatters.set(timeZone, f);
	}
	return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The wall-clock parts of an instant in a time zone (empty = local). */
export function zoned(at: Date | number, timeZone = ""): ZonedParts {
	const map: Record<string, string> = {};
	for (const p of partsFormatter(timeZone).formatToParts(at)) map[p.type] = p.value;
	const hour = Number(map.hour) % 24;
	const minute = Number(map.minute);
	return {
		year: Number(map.year),
		month: Number(map.month),
		day: Number(map.day),
		hour,
		minute,
		second: Number(map.second),
		weekday: WEEKDAYS.indexOf(map.weekday ?? "Sun"),
		date: `${map.year}-${map.month}-${map.day}`,
		minutes: hour * 60 + minute,
	};
}

/** `"16:30"` → 990; anything unparsable → null. `"24:00"` is allowed. */
export function parseTime(value: string | null | undefined): number | null {
	const m = /^\s*(\d{1,2})[:.h](\d{2})\s*$/.exec(value ?? "");
	if (!m) return null;
	const total = Number(m[1]) * 60 + Number(m[2]);
	return total >= 0 && total <= 24 * 60 ? total : null;
}

/**
 * Is `now` inside a schedule? No days = every day; no window = all day.
 * A window that ends before it starts (22:00 → 02:00) wraps past midnight and
 * belongs to the day it starts on.
 */
export function inSchedule(now: ZonedParts, days: number[] | undefined, from: string, to: string): boolean {
	const start = parseTime(from);
	const end = parseTime(to);
	const dayOk = (weekday: number) => !days?.length || days.includes(weekday);
	if (start === null && end === null) return dayOk(now.weekday);
	const s = start ?? 0;
	const e = end ?? 24 * 60;
	if (s <= e) return dayOk(now.weekday) && now.minutes >= s && now.minutes < e;
	if (now.minutes >= s) return dayOk(now.weekday);
	return now.minutes < e && dayOk((now.weekday + 6) % 7);
}

// --------------------------------------------------------------- opening hours

export const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayKey = (typeof DAY_KEYS)[number];
export type WeekHours = Record<DayKey, string>;
/** Minutes since midnight; `to` may exceed 1440 when the range runs past midnight. */
export type Range = [from: number, to: number];

export interface ClosureRule {
	date: string;
	from: string;
	to: string;
	note: string;
}

/** `"12:00-14:00, 18:00-01:00"` → [[720, 840], [1080, 1500]]. */
export function parseRanges(value: string | undefined): Range[] {
	const ranges: Range[] = [];
	for (const part of (value ?? "").split(/[,;]/)) {
		const [a, b] = part.split(/\s*[-–—]\s*/);
		const from = parseTime(a);
		let to = parseTime(b);
		if (from === null || to === null) continue;
		if (to <= from) to += 24 * 60;
		ranges.push([from, to]);
	}
	return ranges.sort((x, y) => x[0] - y[0]);
}

/** Removes the closed windows of one day from its opening ranges. */
function subtract(ranges: Range[], closed: Range[]): Range[] {
	let out = ranges;
	for (const [cf, ct] of closed) {
		out = out.flatMap(([f, t]): Range[] => {
			if (ct <= f || cf >= t) return [[f, t]];
			const pieces: Range[] = [];
			if (cf > f) pieces.push([f, cf]);
			if (ct < t) pieces.push([ct, t]);
			return pieces;
		});
	}
	return out;
}

/** A calendar date some days later (or earlier). */
export const addDays = (date: string, n: number) => {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
};

/** The opening ranges of a calendar date, closures applied. */
export function rangesOn(week: WeekHours, closures: ClosureRule[], date: string, weekday: number): Range[] {
	const closed = closures
		.filter((c) => c.date.trim() === date)
		.map((c): Range => [parseTime(c.from) ?? 0, parseTime(c.to) ?? 48 * 60]);
	return subtract(parseRanges(week[DAY_KEYS[weekday]!]), closed);
}

/**
 * The order of a week list: for each row, how many days from today it is.
 * `start` is the weekday of the first row (0 = Sunday), or null to start today.
 * Every row is the next occurrence of its weekday, so none lies in the past.
 */
export function weekOffsets(today: number, start: number | null): number[] {
	return Array.from({ length: 7 }, (_, i) => ((((start ?? today) + i - today) % 7) + 7) % 7);
}

export type HoursStatus =
	| { open: true; closesAt: number; soon: boolean; note: string }
	| { open: false; opensAt: number; inDays: number; weekday: number; note: string }
	| { open: false; opensAt: null; note: string };

/** Open or closed right now, and when that changes. */
export function hoursStatus(week: WeekHours, closures: ClosureRule[], now: ZonedParts, soonMinutes = 30): HoursStatus {
	const note = closures.find((c) => c.date.trim() === now.date)?.note ?? "";
	// Still open from yesterday's late range (e.g. Friday 16:00–01:00 at 00:30 on Saturday)?
	const yesterday = rangesOn(week, closures, addDays(now.date, -1), (now.weekday + 6) % 7);
	for (const [, to] of yesterday) {
		const end = to - 24 * 60;
		if (end > now.minutes)
			return { open: true, closesAt: end % (24 * 60), soon: end - now.minutes <= soonMinutes, note };
	}
	for (let offset = 0; offset < 8; offset++) {
		const date = addDays(now.date, offset);
		const weekday = (now.weekday + offset) % 7;
		for (const [from, to] of rangesOn(week, closures, date, weekday)) {
			if (offset === 0 && now.minutes >= from && now.minutes < to) {
				return { open: true, closesAt: to % (24 * 60), soon: to - now.minutes <= soonMinutes, note };
			}
			if (offset > 0 || from > now.minutes) return { open: false, opensAt: from, inDays: offset, weekday, note };
		}
	}
	return { open: false, opensAt: null, note };
}

/** 990 → "16:30" or "4:30 PM", following the locale and hour cycle. */
export function formatMinutes(minutes: number, locale: string, hourCycle: "auto" | "12" | "24" = "auto"): string {
	const m = ((minutes % 1440) + 1440) % 1440;
	const date = new Date(Date.UTC(2020, 0, 1, Math.floor(m / 60), m % 60));
	return timeFormatter(locale, hourCycle, "UTC").format(date);
}

/**
 * A time-of-day formatter. 24-hour clocks pad the hour ("09:05"), 12-hour
 * ones do not ("9:05 AM"), which is how each is normally written.
 */
export function timeFormatter(
	locale: string,
	hourCycle: "auto" | "12" | "24",
	timeZone: string,
	seconds = false,
): Intl.DateTimeFormat {
	const cycle = hourCycle === "auto" ? {} : { hourCycle: hourCycle === "12" ? ("h12" as const) : ("h23" as const) };
	const build = (zone: string | undefined) => {
		const base = { minute: "2-digit", second: seconds ? "2-digit" : undefined, timeZone: zone, ...cycle } as const;
		const probe = new Intl.DateTimeFormat(locale || undefined, { ...base, hour: "numeric" });
		const padded = ["h23", "h24"].includes(probe.resolvedOptions().hourCycle ?? "");
		return padded ? new Intl.DateTimeFormat(locale || undefined, { ...base, hour: "2-digit" }) : probe;
	};
	try {
		return build(timeZone || undefined);
	} catch {
		// Unknown time zone: use the device's.
		return build(undefined);
	}
}

// ---------------------------------------------------------------- date formats

/** ISO 8601 week number of a calendar date. */
export function isoWeek(year: number, month: number, day: number): number {
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
	return Math.ceil(((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7);
}

const PATTERN_TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|WW|W/g;

/**
 * Formats a date with a pattern such as `dddd D MMMM YYYY`:
 * `YYYY` `YY` year, `MMMM` `MMM` `MM` `M` month, `DD` `D` day,
 * `dddd` `ddd` weekday, `WW` `W` ISO week. Text in `[brackets]` is kept as is.
 * Names come out in the given locale.
 */
export function formatDatePattern(pattern: string, at: Date | number, locale = "", timeZone = ""): string {
	const z = zoned(at, timeZone);
	// The calendar date as a UTC instant, so names need no time zone of their own.
	const date = new Date(Date.UTC(z.year, z.month - 1, z.day, 12));
	const part = (type: "month" | "weekday", options: Intl.DateTimeFormatOptions) => {
		let f: Intl.DateTimeFormat;
		try {
			f = new Intl.DateTimeFormat(locale || undefined, { ...options, timeZone: "UTC" });
		} catch {
			// Unknown locale: use the device's.
			f = new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" });
		}
		return f.formatToParts(date).find((p) => p.type === type)?.value ?? "";
	};
	// Next to a day number, many languages inflect the month ("3 марта", not "3 март").
	const withDay = pattern.replace(/\[[^\]]*\]/g, "").includes("D");
	const month = (style: "long" | "short") =>
		part("month", withDay ? { day: "numeric", month: style } : { month: style });
	const pad = (n: number) => String(n).padStart(2, "0");
	return pattern.replace(PATTERN_TOKENS, (token, literal: string | undefined) => {
		if (literal !== undefined) return literal;
		switch (token) {
			case "YYYY":
				return String(z.year);
			case "YY":
				return pad(z.year % 100);
			case "MMMM":
				return month("long");
			case "MMM":
				return month("short");
			case "MM":
				return pad(z.month);
			case "M":
				return String(z.month);
			case "DD":
				return pad(z.day);
			case "D":
				return String(z.day);
			case "dddd":
				return part("weekday", { weekday: "long" });
			case "ddd":
				return part("weekday", { weekday: "short" });
			case "WW":
				return pad(isoWeek(z.year, z.month, z.day));
			default:
				return String(isoWeek(z.year, z.month, z.day));
		}
	});
}

const TIME_TOKENS = /\[([^\]]*)\]|HH|H|hh|h|mm|m|ss|s|A|a/g;

/**
 * Formats a time of day with a pattern such as `HH:mm:ss` or `h:mm A`:
 * `HH` `H` 24-hour, `hh` `h` 12-hour, `mm` `m` minutes, `ss` `s` seconds,
 * `A` AM/PM, `a` am/pm. Text in `[brackets]` is kept as is.
 */
export function formatTimePattern(pattern: string, at: Date | number, timeZone = ""): string {
	const z = zoned(at, timeZone);
	const pad = (n: number) => String(n).padStart(2, "0");
	const twelve = z.hour % 12 || 12;
	return pattern.replace(TIME_TOKENS, (token, literal: string | undefined) => {
		if (literal !== undefined) return literal;
		switch (token) {
			case "HH":
				return pad(z.hour);
			case "H":
				return String(z.hour);
			case "hh":
				return pad(twelve);
			case "h":
				return String(twelve);
			case "mm":
				return pad(z.minute);
			case "m":
				return String(z.minute);
			case "ss":
				return pad(z.second);
			case "s":
				return String(z.second);
			case "A":
				return z.hour < 12 ? "AM" : "PM";
			default:
				return z.hour < 12 ? "am" : "pm";
		}
	});
}

// ------------------------------------------------------- instants and periods

const DAY_MINUTES = 24 * 60;
const pad2 = (n: number) => String(n).padStart(2, "0");
const isLeap = (year: number) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
/** Whole days from one calendar date to another. */
export const daysBetween = (from: string, to: string) =>
	Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * The instant at which a zone's clocks show `date` + `minutes` after midnight.
 * A time skipped by a daylight-saving jump lands just after the jump.
 */
export function zonedInstant(date: string, minutes: number, timeZone = ""): number {
	const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
	const wall = Date.UTC(year, month - 1, day, 0, minutes);
	let guess = wall;
	// Two rounds: the first finds the offset, the second corrects it across a clock change.
	for (let i = 0; i < 2; i++) {
		const z = zoned(guess, timeZone);
		guess += wall - Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
	}
	return guess;
}

export type LeapDay = "feb28" | "mar1";

/** The date an anniversary falls on in a year; 29 February moves in common years. */
export function anniversaryIn(year: number, month: number, day: number, leapDay: LeapDay = "feb28"): string {
	if (month === 2 && day === 29 && !isLeap(year)) return leapDay === "mar1" ? `${year}-03-01` : `${year}-02-28`;
	return `${year}-${pad2(month)}-${pad2(day)}`;
}

export interface Recurrence {
	repeat: "daily" | "weekly" | "yearly";
	/** `HH:MM`; unparsable = midnight. */
	time: string;
	/** Weekly: 0 = Sunday. */
	weekday: number;
	/** Yearly: `MM-DD`. */
	date: string;
}

/**
 * The occurrences of a recurring moment around an instant: the last one at or
 * before it and the first one after it. Null when the rule cannot be read.
 */
export function occurrencesAround(
	rule: Recurrence,
	at: number,
	timeZone = "",
): { previous: number; next: number } | null {
	const now = zoned(at, timeZone);
	const minutes = parseTime(rule.time) ?? 0;
	let dates: string[];
	if (rule.repeat === "yearly") {
		const m = /^\s*(?:\d{4}-)?(\d{1,2})-(\d{1,2})\s*$/.exec(rule.date);
		if (!m) return null;
		const month = Number(m[1]);
		const day = Number(m[2]);
		if (month < 1 || month > 12 || day < 1 || day > 31) return null;
		dates = [-1, 0, 1].map((n) => anniversaryIn(now.year + n, month, day));
	} else {
		// A fortnight around today holds the previous and the next of any weekday.
		dates = [];
		for (let offset = -7; offset <= 7; offset++) {
			if (rule.repeat === "daily" || (((now.weekday + offset) % 7) + 7) % 7 === rule.weekday) {
				dates.push(addDays(now.date, offset));
			}
		}
	}
	const instants = dates.map((date) => zonedInstant(date, minutes, timeZone));
	const next = instants.find((t) => t > at);
	const previous = instants.findLast((t) => t <= at);
	return next === undefined || previous === undefined ? null : { previous, next };
}

export type Period = "day" | "week" | "month" | "quarter" | "year";

/** Start and end instants of the current day, week, month, quarter or year. `weekStart`: 0 = Sunday. */
export function periodRange(
	period: Period,
	now: ZonedParts,
	timeZone = "",
	weekStart = 1,
): [start: number, end: number] {
	let from = now.date;
	let to: string;
	if (period === "day") to = addDays(from, 1);
	else if (period === "week") {
		from = addDays(from, -((now.weekday - weekStart + 7) % 7));
		to = addDays(from, 7);
	} else if (period === "year") {
		from = `${now.year}-01-01`;
		to = `${now.year + 1}-01-01`;
	} else {
		const length = period === "quarter" ? 3 : 1;
		const first = now.month - ((now.month - 1) % length);
		from = `${now.year}-${pad2(first)}-01`;
		const last = first + length;
		to = last > 12 ? `${now.year + 1}-01-01` : `${now.year}-${pad2(last)}-01`;
	}
	return [zonedInstant(from, 0, timeZone), zonedInstant(to, 0, timeZone)];
}

/** How far `at` is between two instants, 0 to 1. */
export function fractionBetween(start: number, end: number, at: number): number {
	if (!(end > start)) return at >= end ? 1 : 0;
	return Math.min(1, Math.max(0, (at - start) / (end - start)));
}

// ------------------------------------------------------------------ timetable

export interface TimetableRow {
	days: number[];
	from: string;
	to: string;
}
export interface TimetableSlot<T> {
	row: T;
	/** Minutes from today's midnight; negative for yesterday, above 1440 for later days. */
	start: number;
	end: number;
}

/**
 * What a weekly timetable says at one moment: the slots under way, the ones
 * coming up within a week (soonest first) and today's whole list. No days =
 * every day. A slot that ends before it starts runs past midnight; one without
 * an end is a moment, listed but never "on".
 */
export function timetableAt<T extends TimetableRow>(
	rows: T[],
	now: ZonedParts,
): { current: TimetableSlot<T>[]; next: TimetableSlot<T>[]; today: TimetableSlot<T>[] } {
	const slots: (TimetableSlot<T> & { offset: number })[] = [];
	for (const row of rows) {
		const from = parseTime(row.from);
		if (from === null) continue;
		let to = parseTime(row.to) ?? from;
		if (to < from) to += DAY_MINUTES;
		// Yesterday (for a slot still running after midnight) up to the same weekday next week.
		for (let offset = -1; offset <= 7; offset++) {
			const weekday = (now.weekday + offset + 7) % 7;
			if (row.days?.length && !row.days.includes(weekday)) continue;
			slots.push({ row, start: offset * DAY_MINUTES + from, end: offset * DAY_MINUTES + to, offset });
		}
	}
	slots.sort((a, b) => a.start - b.start || a.end - b.end);
	const strip = ({ row, start, end }: TimetableSlot<T>): TimetableSlot<T> => ({ row, start, end });
	const on = (s: TimetableSlot<T>) => s.start <= now.minutes && now.minutes < s.end;
	return {
		current: slots.filter(on).map(strip),
		next: slots.filter((s) => s.start > now.minutes && s.start <= now.minutes + 7 * DAY_MINUTES).map(strip),
		today: slots.filter((s) => s.offset === 0 || (s.offset === -1 && on(s))).map(strip),
	};
}

// ------------------------------------------------------------------ birthdays

export interface Anniversary<T> {
	row: T;
	/** The date it is celebrated on next (today included). */
	date: string;
	inDays: number;
	/** The age or number of years on that date; null when the year is unknown. */
	years: number | null;
}

/** `1985-03-14`, `03-14` or `--03-14` → its parts; anything else → null. */
export function parseAnniversary(value: string): { year: number | null; month: number; day: number } | null {
	const m = /^\s*(?:(\d{4})-|--)?(\d{1,2})-(\d{1,2})\s*$/.exec(value ?? "");
	if (!m) return null;
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(2000, month, 0)).getUTCDate()) return null;
	return { year: m[1] ? Number(m[1]) : null, month, day };
}

/** The yearly dates coming up within `days` days of `today`, soonest first. */
export function upcomingAnniversaries<T extends { date: string }>(
	rows: T[],
	today: string,
	days: number,
	leapDay: LeapDay = "feb28",
): Anniversary<T>[] {
	const year = Number(today.slice(0, 4));
	const out: Anniversary<T>[] = [];
	for (const row of rows) {
		const parsed = parseAnniversary(row.date);
		if (!parsed) continue;
		for (const y of [year, year + 1]) {
			const date = anniversaryIn(y, parsed.month, parsed.day, leapDay);
			const inDays = daysBetween(today, date);
			if (inDays < 0) continue;
			const years = parsed.year !== null && y >= parsed.year ? y - parsed.year : null;
			if (inDays <= days) out.push({ row, date, inDays, years });
			break;
		}
	}
	return out.sort((a, b) => a.inDays - b.inDays);
}

// ------------------------------------------------- calendar and holiday events

interface EventLike {
	title: string;
	start: string;
	end: string;
	allDay: boolean;
}

const keywords = (list: string) =>
	list
		.split(",")
		.map((k) => k.trim().toLocaleLowerCase())
		.filter(Boolean);

/**
 * Keeps the events whose title contains one of the `include` keywords (when
 * there are any) and none of the `exclude` ones; both are comma-separated.
 */
export function filterEvents<T extends EventLike>(
	events: T[],
	filter: { include?: string; exclude?: string; hideAllDay?: boolean },
): T[] {
	const include = keywords(filter.include ?? "");
	const exclude = keywords(filter.exclude ?? "");
	return events.filter((event) => {
		if (filter.hideAllDay && event.allDay) return false;
		const title = event.title.toLocaleLowerCase();
		if (include.length && !include.some((k) => title.includes(k))) return false;
		return !exclude.some((k) => title.includes(k));
	});
}

export interface Holiday {
	date: string;
	name: string;
}

/** Every date covered by the all-day events of a calendar, with the event's title. */
export function holidayDates(events: EventLike[]): Holiday[] {
	const out: Holiday[] = [];
	for (const event of events) {
		if (!event.allDay) continue;
		// iCal all-day events end on the day after their last day; cap runaway ranges.
		const length = Math.min(60, Math.max(1, daysBetween(event.start, event.end)));
		for (let i = 0; i < length; i++) out.push({ date: addDays(event.start, i), name: event.title });
	}
	return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Holidays as whole-day closures, after the hand-written ones so those keep their notes. */
export function withHolidays(closures: ClosureRule[], holidays: Holiday[]): ClosureRule[] {
	return [...closures, ...holidays.map((h) => ({ date: h.date, from: "", to: "", note: h.name }))];
}

/** The three states an opening-hours display distinguishes. */
export const hoursState = (status: HoursStatus): "open" | "soon" | "closed" =>
	status.open ? (status.soon ? "soon" : "open") : "closed";

/**
 * The instant of a `YYYY-MM-DDTHH:MM` value (what a date-and-time field
 * stores) read as wall-clock time in a zone. NaN when it cannot be read.
 */
export function wallInstant(value: string, timeZone = ""): number {
	const m = /^\s*(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2}))?/.exec(value ?? "");
	if (!m) return Number.NaN;
	return zonedInstant(m[1]!, Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0), timeZone);
}
