/**
 * Server data of the time elements: calendar events, the holiday calendar of
 * the opening hours and birthdays read from calendars.
 */
import ICAL from "ical.js";
import type { BirthdaysData, CalendarData, CalendarEvent, HoursData } from "../../shared/data";
import type { CalendarSource, El } from "../../shared/elements";
import { filterEvents, holidayDates, zoned } from "../../shared/time";
import type { GeneralSettings } from "../../shared/types";
import { haJson } from "../ha/client";
import { cached, icalEvents, icalRoot, icalText } from "./sources";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Events of a Home Assistant calendar entity. Its API hands over the title,
 * times, description and location only: no status and no attendees, so
 * cancelled or declined events cannot be told apart here.
 */
async function haEvents(
	entity: string,
	from: Date,
	to: Date,
	color: string,
	calendar: string,
): Promise<CalendarEvent[]> {
	const query = `start=${encodeURIComponent(from.toISOString())}&end=${encodeURIComponent(to.toISOString())}`;
	type HaTime = { dateTime?: string; date?: string };
	// The window moves with the clock; the day it starts on is enough to tell two apart.
	const key = `ha-calendar:${entity}:${from.toISOString().slice(0, 10)}:${Math.round((to.getTime() - from.getTime()) / DAY)}`;
	const events = await cached(key, 300, () =>
		haJson<{ summary?: string; location?: string; start: HaTime; end: HaTime }[]>(`/calendars/${entity}?${query}`),
	);
	return events.map((e) => ({
		title: e.summary || "(untitled)",
		start: e.start.dateTime ? new Date(e.start.dateTime).toISOString() : (e.start.date ?? ""),
		end: e.end.dateTime ? new Date(e.end.dateTime).toISOString() : (e.end.date ?? ""),
		allDay: !e.start.dateTime,
		location: e.location ?? "",
		color,
		calendar,
	}));
}

export async function calendarData(el: El<"calendar">): Promise<CalendarData> {
	const now = Date.now();
	// Wide enough for the month grid whatever the day of the month.
	const from = new Date(now - 45 * DAY);
	const to = new Date(now + Math.max(el.days, 45) * DAY);
	const errors: string[] = [];
	const lists = await Promise.all(
		(el.sources as CalendarSource[]).map(async (source) => {
			try {
				if (source.kind === "ha") {
					return source.entity ? await haEvents(source.entity, from, to, source.color, source.name) : [];
				}
				if (!source.url) return [];
				return await icalEvents(source.url, from, to, source.color, source.name, {
					hideCancelled: el.hideCancelled,
					declinedBy: el.attendee,
				});
			} catch (err) {
				errors.push(`${source.name || "Calendar"}: ${(err as Error).message}`);
				return [];
			}
		}),
	);
	const events = filterEvents(lists.flat(), {
		include: el.include,
		exclude: el.exclude,
		hideAllDay: el.hideAllDay,
	}).sort((a, b) => a.start.localeCompare(b.start));
	return { events: events.slice(0, 500), errors };
}

/** The closed days of the opening hours' holiday calendar. A feed that fails leaves the regular hours standing. */
export async function hoursData(el: El<"hours">): Promise<HoursData> {
	const url = el.holidayUrl.trim();
	if (!url) return { holidays: [], error: "" };
	try {
		const now = Date.now();
		const events = await icalEvents(url, new Date(now - 2 * DAY), new Date(now + 60 * DAY), "", "", {
			hideCancelled: true,
		});
		return { holidays: holidayDates(events).slice(0, 200), error: "" };
	} catch (err) {
		return { holidays: [], error: `Holiday calendar: ${(err as Error).message}` };
	}
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Birthdays in an iCal feed. A yearly series is read from its first event,
 * which is where the birth year is (and the only place a 29 February shows up
 * every year); address books write a placeholder year such as 1604 when they
 * do not know it.
 */
export function icalBirthdays(text: string, from: Date, to: Date): { name: string; date: string }[] {
	const out: { name: string; date: string }[] = [];
	for (const component of icalRoot(text).getAllSubcomponents("vevent")) {
		const event = new ICAL.Event(component);
		if (event.isRecurrenceException() || !event.startDate) continue;
		const start = event.startDate;
		const day = `${pad(start.month)}-${pad(start.day)}`;
		const name = event.summary || "(untitled)";
		const rule = component.getFirstPropertyValue("rrule") as { freq?: string } | null;
		if (rule?.freq === "YEARLY") {
			const omitted = component.getFirstProperty("dtstart")?.getParameter("x-apple-omit-year");
			out.push({ name, date: start.year >= 1900 && !omitted ? `${start.year}-${day}` : day });
		} else if (!event.isRecurring()) {
			// A one-off entry only counts while it is still ahead.
			const ms = start.toJSDate().getTime();
			if (ms >= from.getTime() && ms <= to.getTime()) out.push({ name, date: day });
		}
	}
	return out;
}

interface BirthdaySource {
	kind: string;
	url: string;
	entity: string;
	occasion: string;
}

export async function birthdaysData(el: El<"birthdays">, general: GeneralSettings): Promise<BirthdaysData> {
	const now = Date.now();
	const from = new Date(now - 2 * DAY);
	// A whole year, so the list is right whatever "days ahead" is set to.
	const to = new Date(now + 367 * DAY);
	const errors: string[] = [];
	const lists = await Promise.all(
		(el.sources as BirthdaySource[]).map(async (source, index) => {
			const kind = source.occasion === "anniversary" ? "anniversary" : "birthday";
			try {
				if (source.kind === "ha") {
					if (!source.entity) return [];
					const events = await haEvents(source.entity, from, to, "", "");
					return events.map((e) => ({
						name: e.title,
						// Home Assistant gives the occurrence, not the year it all started.
						date: (e.allDay ? e.start : zoned(Date.parse(e.start), general.timezone).date).slice(5),
						kind,
					}));
				}
				if (!source.url) return [];
				return icalBirthdays(await icalText(source.url), from, to).map((b) => ({ ...b, kind }));
			} catch (err) {
				errors.push(`Calendar ${index + 1}: ${(err as Error).message}`);
				return [];
			}
		}),
	);
	const seen = new Set<string>();
	const entries = lists.flat().filter((entry) => {
		const key = `${entry.name}|${entry.date.slice(-5)}|${entry.kind}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return { entries: entries.slice(0, 500), errors };
}
