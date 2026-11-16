import { createMemo, For, Show } from "solid-js";
import type { CalendarData, CalendarEvent, HoursData } from "../../../shared/data";
import type { El } from "../../../shared/elements";
import {
	DAY_KEYS,
	formatDatePattern,
	formatMinutes,
	formatTimePattern,
	fractionBetween,
	hoursState,
	hoursStatus,
	isoWeek,
	occurrencesAround,
	parseRanges,
	rangesOn,
	timeFormatter,
	type WeekHours,
	weekOffsets,
	withHolidays,
	zoned,
} from "../../../shared/time";
import { px, useDisplay, useMinute, useNow } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";

export const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase() + s.slice(1);

/** A formatter that survives a mistyped time zone by falling back to the device's. */
export function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat(locale || undefined, options);
	} catch {
		const { timeZone: _ignored, ...rest } = options;
		return new Intl.DateTimeFormat(undefined, rest);
	}
}

/** "today", "tomorrow" or a weekday name, in the display's language. */
export function dayWord(locale: string, offset: number, date: Date, timeZone: string): string {
	if (offset === 0 || offset === 1) {
		try {
			return new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" }).format(offset, "day");
		} catch {
			return offset === 0 ? "today" : "tomorrow";
		}
	}
	return formatter(locale, { weekday: "long", timeZone: timeZone || undefined }).format(date);
}

export type FaceStyle = "classic" | "minimal" | "numerals" | "roman";
const ROMAN = ["XII", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI"];

/** An analogue clock face showing an instant in a time zone. */
export function ClockFace(props: { at: number; zone: string; seconds: boolean; face: FaceStyle }) {
	const hands = createMemo(() => {
		const z = zoned(props.at, props.zone);
		return {
			hour: (z.hour % 12) * 30 + z.minute * 0.5,
			minute: z.minute * 6 + (props.seconds ? z.second * 0.1 : 0),
			second: z.second * 6,
		};
	});
	const numbered = () => props.face === "numerals" || props.face === "roman";
	const hours = Array.from({ length: 12 }, (_, i) => i);
	return (
		<svg class="sd-clock-face" viewBox="-50 -50 100 100" role="img" aria-label="Clock">
			<circle r="47" fill="none" stroke="currentColor" stroke-width={props.face === "minimal" ? 1.6 : 2.5} />
			<Show when={props.face === "classic"}>
				<For each={hours}>
					{(i) => (
						<line
							y1={i % 3 === 0 ? -36 : -40}
							y2="-43"
							stroke="currentColor"
							stroke-width={i % 3 === 0 ? 2.5 : 1.2}
							stroke-linecap="round"
							transform={`rotate(${i * 30})`}
						/>
					)}
				</For>
			</Show>
			<Show when={numbered()}>
				<For each={hours}>
					{(i) => (
						<text
							x={Math.sin((i * Math.PI) / 6) * 37.5}
							y={-Math.cos((i * Math.PI) / 6) * 37.5}
							text-anchor="middle"
							dominant-baseline="central"
							font-size={props.face === "roman" ? "7.5" : "9.5"}
							font-weight="700"
							fill="currentColor"
						>
							{props.face === "roman" ? ROMAN[i] : i || 12}
						</text>
					)}
				</For>
			</Show>
			<line
				y2={numbered() ? -20 : -24}
				stroke="currentColor"
				stroke-width="4"
				stroke-linecap="round"
				transform={`rotate(${hands().hour})`}
			/>
			<line
				y2={numbered() ? -30 : -36}
				stroke="currentColor"
				stroke-width="2.6"
				stroke-linecap="round"
				transform={`rotate(${hands().minute})`}
			/>
			<Show when={props.seconds}>
				<line
					y1="8"
					y2={numbered() ? -32 : -39}
					stroke="var(--sd-accent)"
					stroke-width="1.2"
					stroke-linecap="round"
					transform={`rotate(${hands().second})`}
				/>
			</Show>
			<circle r="2.6" fill="currentColor" />
		</svg>
	);
}

export function Clock(props: RendererProps<El<"clock">>) {
	const env = useDisplay();
	const second = useNow();
	const minute = useMinute();
	const custom = () => (props.el.style === "digital" ? props.el.timeFormat.trim() : "");
	// ePaper refreshes slowly: never tick seconds there.
	const seconds = () => (props.el.seconds || /s/.test(custom().replace(/\[[^\]]*\]/g, ""))) && !env.lowColor();
	const now = () => (seconds() ? second() : minute());
	const zone = () => props.el.timezone || env.general().timezone;

	const parts = createMemo(() => {
		if (custom()) return { time: formatTimePattern(custom(), now(), zone()), period: "" };
		const cycle = props.el.hourCycle === "auto" ? env.general().hourCycle : props.el.hourCycle;
		const all = timeFormatter(env.general().locale, cycle, zone(), seconds()).formatToParts(now());
		return {
			time: all
				.filter((p) => p.type !== "dayPeriod")
				.map((p) => p.value)
				.join("")
				.trim(),
			period: all.find((p) => p.type === "dayPeriod")?.value ?? "",
		};
	});
	const date = () =>
		formatter(env.general().locale, {
			weekday: "long",
			day: "numeric",
			month: "long",
			timeZone: zone() || undefined,
		}).format(now());
	// A blinking colon is a redraw every second, which an ePaper panel cannot do.
	const blink = () => props.el.blink && !env.lowColor();
	const colonOff = () => Math.floor(second() / 1000) % 2 === 1;

	return (
		<div class="sd-clock" style={{ "font-size": px(props.el.size) }}>
			<Show
				when={props.el.style === "analog"}
				fallback={
					<div class="sd-clock-digits">
						<Show when={blink()} fallback={parts().time}>
							<For each={parts().time.split(/([:.])/)}>
								{(piece) => (
									<Show when={piece === ":" || piece === "."} fallback={piece}>
										<span class="sd-clock-colon" classList={{ "sd-clock-colon-off": colonOff() }}>
											{piece}
										</span>
									</Show>
								)}
							</For>
						</Show>
						<Show when={parts().period}>
							<span class="sd-clock-period">{parts().period}</span>
						</Show>
					</div>
				}
			>
				<ClockFace at={now()} zone={zone()} seconds={seconds()} face={props.el.face} />
			</Show>
			<Show when={props.el.date}>
				<div class="sd-clock-date" style={props.el.dateSize > 0 ? { "font-size": px(props.el.dateSize) } : undefined}>
					{capitalize(date())}
				</div>
			</Show>
			<Show when={props.el.label}>
				<div class="sd-clock-label">{props.el.label}</div>
			</Show>
		</div>
	);
}

export function DateElement(props: RendererProps<El<"date">>) {
	const env = useDisplay();
	const minute = useMinute();
	const zone = () => props.el.timezone || env.general().timezone || undefined;
	const locale = () => props.el.locale.trim() || env.general().locale;
	const format = (options: Intl.DateTimeFormatOptions) =>
		capitalize(formatter(locale(), { ...options, timeZone: zone() }).format(minute()));
	const text = createMemo(() => {
		switch (props.el.format) {
			case "custom":
				return formatDatePattern(props.el.pattern, minute(), locale(), zone() ?? "");
			case "long":
				return format({ dateStyle: "long" });
			case "medium":
				return format({ dateStyle: "medium" });
			case "short":
				return format({ dateStyle: "short" });
			case "weekday":
				return format({ weekday: "long" });
			default:
				return format({ dateStyle: "full" });
		}
	});
	const week = () => {
		const z = zoned(minute(), zone() ?? "");
		return isoWeek(z.year, z.month, z.day);
	};
	return (
		<div class="sd-date" style={{ "font-size": px(props.el.size), "text-align": props.el.align }}>
			<Show when={props.el.format === "day"} fallback={<div class="sd-date-text">{text()}</div>}>
				<div class="sd-date-weekday">{format({ weekday: "long" })}</div>
				<div class="sd-date-number">{format({ day: "numeric" })}</div>
				<div class="sd-date-month">{format({ month: "long", year: "numeric" })}</div>
			</Show>
			<Show when={props.el.week}>
				<div class="sd-date-week">Week {week()}</div>
			</Show>
		</div>
	);
}

export function Countdown(props: RendererProps<El<"countdown">>) {
	const env = useDisplay();
	const second = useNow();
	const minute = useMinute();
	// Only the second-precise formats need a tick every second.
	const coarse = () => env.lowColor() || props.el.units === "days" || props.el.units === "dhm";
	const tick = () => (coarse() ? minute() : second());
	/** What is counted to, and where the ring starts from (null = no start known). */
	const span = createMemo((): { start: number | null; end: number } | null => {
		if (props.el.repeat !== "none") {
			const around = occurrencesAround(
				{
					repeat: props.el.repeat,
					time: props.el.repeatTime,
					weekday: Number(props.el.repeatDay),
					date: props.el.repeatDate,
				},
				tick(),
				env.general().timezone,
			);
			return around && { start: around.previous, end: around.next };
		}
		const end = props.el.target ? new Date(props.el.target).getTime() : Number.NaN;
		if (Number.isNaN(end)) return null;
		const start = props.el.ringFrom ? new Date(props.el.ringFrom).getTime() : Number.NaN;
		return { start: Number.isNaN(start) ? null : start, end };
	});
	const state = createMemo(() => {
		const range = span();
		if (!range) return null;
		let left = range.end - tick();
		const done = left <= 0;
		if (done && !props.el.countUp) return { done: true, segments: [] as [number, string][] };
		left = Math.abs(left);
		const days = Math.floor(left / 86_400_000);
		const hours = Math.floor(left / 3_600_000) % 24;
		const minutes = Math.floor(left / 60_000) % 60;
		const seconds = Math.floor(left / 1000) % 60;
		let units = props.el.units;
		if (units === "auto") units = days >= 2 ? "days" : days >= 1 || env.lowColor() ? "dhm" : "hms";
		let segments: [number, string][];
		// Days round up so "in 2 days" does not jump to "1 day" a full day early.
		if (units === "days") segments = [[done ? days : Math.ceil(left / 86_400_000), "days"]];
		else if (units === "dhm")
			segments = [
				[days, "days"],
				[hours, "hours"],
				[minutes, "min"],
			];
		else
			segments = [
				[days * 24 + hours, "hours"],
				[minutes, "min"],
				[seconds, "sec"],
			];
		return { done, segments };
	});
	const ring = () => {
		const range = span();
		return range && range.start !== null ? fractionBetween(range.start, range.end, tick()) : 0;
	};
	// In the editor a hidden countdown stays, so it can still be selected and changed.
	const hidden = () => Boolean(state()?.done) && props.el.hideDone && !env.editing;
	const Segments = (p: { list: [number, string][] }) => (
		<div class="sd-countdown-segments">
			<For each={p.list}>
				{([value, label]) => (
					<div class="sd-countdown-segment">
						<div class="sd-countdown-value">{String(value).padStart(label === "days" ? 1 : 2, "0")}</div>
						<div class="sd-countdown-unit">{label}</div>
					</div>
				)}
			</For>
		</div>
	);
	return (
		<Show when={!hidden()}>
			<div class="sd-countdown" style={{ "font-size": px(props.el.size) }}>
				<Show when={state()} fallback={<Placeholder text="Choose a date and time" />}>
					{(s) => (
						<Show when={s().segments.length} fallback={<div class="sd-countdown-done">{props.el.doneText}</div>}>
							<Show when={props.el.ring} fallback={<Segments list={s().segments} />}>
								<div
									class="sd-countdown-ring"
									style={{ "--sd-ring": env.ink(props.el.ringColor) || "var(--sd-accent)" }}
								>
									<svg viewBox="0 0 100 100" aria-hidden="true">
										<circle class="sd-timering-track" cx="50" cy="50" r="46" />
										<circle
											class="sd-timering-value"
											cx="50"
											cy="50"
											r="46"
											pathLength="100"
											stroke-dasharray="100"
											stroke-dashoffset={100 - ring() * 100}
											transform="rotate(-90 50 50)"
										/>
									</svg>
									<Segments list={s().segments} />
								</div>
							</Show>
						</Show>
					)}
				</Show>
				<Show when={props.el.label}>
					<div class="sd-countdown-label">{props.el.label}</div>
				</Show>
			</div>
		</Show>
	);
}

// ------------------------------------------------------------------ calendar

const DAY_MS = 86_400_000;
const shiftDate = (date: string, days: number) => {
	const d = new Date(`${date}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};
/** Noon UTC of a calendar date: a safe instant for formatting a plain date. */
const noon = (date: string) => new Date(`${date}T12:00:00Z`);

interface Occurrence extends CalendarEvent {
	/** First and last calendar day (inclusive) in the display's time zone. */
	firstDay: string;
	lastDay: string;
}

export function Calendar(props: RendererProps<El<"calendar">, CalendarData>) {
	const env = useDisplay();
	const minute = useMinute();
	const zone = () => env.general().timezone;
	const locale = () => env.general().locale;
	const today = createMemo(() => zoned(minute(), zone()).date);

	const occurrences = createMemo((): Occurrence[] =>
		(props.data()?.events ?? []).map((event) => {
			if (event.allDay) {
				// iCal all-day events end on the day after their last day.
				const last = event.end > event.start ? shiftDate(event.end, -1) : event.start;
				return { ...event, firstDay: event.start, lastDay: last };
			}
			const end = Math.max(Date.parse(event.start), Date.parse(event.end) - 1);
			return { ...event, firstDay: zoned(Date.parse(event.start), zone()).date, lastDay: zoned(end, zone()).date };
		}),
	);

	const time = (iso: string) => timeFormatter(locale(), env.general().hourCycle, zone()).format(new Date(iso));
	const when = (event: Occurrence) => {
		if (event.allDay) return "";
		return props.el.endTime ? `${time(event.start)} – ${time(event.end)}` : time(event.start);
	};

	const listed = () => props.el.view === "agenda" || props.el.view === "today";
	const happening = (event: CalendarEvent) =>
		props.el.highlightNow && !event.allDay && Date.parse(event.start) <= minute() && Date.parse(event.end) > minute();
	/** Without day headings every row says which day it is on. */
	const dayShort = (day: string) => {
		const offset = Math.round((noon(day).getTime() - noon(today()).getTime()) / DAY_MS);
		if (offset === 0 || offset === 1) return capitalize(dayWord(locale(), offset, noon(day), "UTC"));
		return formatter(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(noon(day));
	};

	/** Agenda: upcoming events grouped by day. */
	const agenda = createMemo(() => {
		const from = today();
		const to = props.el.view === "today" ? from : shiftDate(from, props.el.days);
		const now = minute();
		const upcoming = occurrences()
			.filter((e) => e.lastDay >= from && e.firstDay <= to)
			.filter((e) => props.el.pastToday || e.allDay || Date.parse(e.end) > now)
			// An event already under way is listed under today.
			.map((e) => ({ ...e, day: e.firstDay < from ? from : e.firstDay }))
			.sort(
				(a, b) => a.day.localeCompare(b.day) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start),
			)
			.slice(0, props.el.max);
		const groups: { day: string; label: string; events: typeof upcoming }[] = [];
		for (const event of upcoming) {
			let group = groups.at(-1);
			if (group?.day !== event.day) {
				const offset = Math.round((noon(event.day).getTime() - noon(from).getTime()) / DAY_MS);
				const date = formatter(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(noon(event.day));
				const word = capitalize(dayWord(locale(), offset, noon(event.day), "UTC"));
				group = { day: event.day, label: `${word} · ${date}`, events: [] };
				groups.push(group);
			}
			group.events.push(event);
		}
		return groups;
	});

	/** Month and week grids: the days to draw, each with its events. */
	const grid = createMemo(() => {
		const current = today();
		const week = props.el.view === "week";
		let firstDay = 1;
		try {
			// 7 = Sunday in `weekInfo`; not every browser has it, Monday is the fallback.
			const info = new Intl.Locale(locale()) as unknown as {
				weekInfo?: { firstDay: number };
				getWeekInfo?: () => { firstDay: number };
			};
			firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay ?? 1;
		} catch {}
		const anchor = week ? current : `${current.slice(0, 8)}01`;
		const weekday = noon(anchor).getUTCDay();
		const start = shiftDate(anchor, -((weekday - (firstDay % 7) + 7) % 7));
		const days = Array.from({ length: week ? 7 : 42 }, (_, i) => {
			const date = shiftDate(start, i);
			return {
				date,
				number: Number(date.slice(8)),
				outside: !week && date.slice(0, 7) !== current.slice(0, 7),
				today: date === current,
				events: occurrences()
					.filter((e) => e.firstDay <= date && e.lastDay >= date)
					.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start)),
			};
		});
		// Drop a trailing week that belongs entirely to next month.
		const trimmed = !week && days.slice(35).every((d) => d.outside) ? days.slice(0, 35) : days;
		const names = trimmed
			.slice(0, 7)
			.map((d) => formatter(locale(), { weekday: "short", timeZone: "UTC" }).format(noon(d.date)));
		const month = capitalize(
			formatter(locale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(noon(current)),
		);
		return { days: trimmed, names, month };
	});

	const empty = () => !props.el.sources.length;
	return (
		<div class="sd-calendar" style={{ "font-size": px(props.el.size) }} data-view={props.el.view}>
			<Show when={props.el.title || props.el.view === "month"}>
				<div class="sd-title">{props.el.title || grid().month}</div>
			</Show>
			<Show when={!empty()} fallback={<Placeholder text="Add a calendar" />}>
				<Show when={props.data()?.errors.length}>
					<Placeholder text="" error={props.data()?.errors.join(" · ")} />
				</Show>
				<Show
					when={listed()}
					fallback={
						<div class="sd-calendar-grid" classList={{ "sd-calendar-week": props.el.view === "week" }}>
							<For each={grid().names}>{(name) => <div class="sd-calendar-weekday">{name}</div>}</For>
							<For each={grid().days}>
								{(day) => (
									<div
										class="sd-calendar-cell"
										classList={{ "sd-calendar-outside": day.outside, "sd-calendar-today": day.today }}
									>
										<div class="sd-calendar-number">{day.number}</div>
										<For each={day.events.slice(0, props.el.view === "week" ? 8 : 3)}>
											{(event) => (
												<div
													class="sd-calendar-chip"
													classList={{ "sd-calendar-chip-now": happening(event) }}
													style={{ "--sd-event": env.ink(event.color) || "var(--sd-accent)" }}
												>
													<Show when={!event.allDay && props.el.view === "week"}>
														<span class="sd-calendar-chip-time">{time(event.start)}</span>
													</Show>
													{event.title}
												</div>
											)}
										</For>
										<Show when={day.events.length > (props.el.view === "week" ? 8 : 3)}>
											<div class="sd-calendar-more">+{day.events.length - (props.el.view === "week" ? 8 : 3)}</div>
										</Show>
									</div>
								)}
							</For>
						</div>
					}
				>
					<For each={agenda()} fallback={<div class="sd-empty">{props.loaded() ? props.el.emptyText : ""}</div>}>
						{(group) => (
							<div
								class="sd-agenda-day"
								classList={{ "sd-agenda-today": group.day === today(), "sd-agenda-flat": !props.el.dayHeadings }}
							>
								<Show when={props.el.dayHeadings}>
									<div class="sd-agenda-heading">{group.label}</div>
								</Show>
								<For each={group.events}>
									{(event) => (
										<div
											class="sd-agenda-event"
											classList={{ "sd-agenda-now": happening(event) }}
											style={{ "--sd-event": env.ink(event.color) || "var(--sd-accent)" }}
										>
											<Show when={!props.el.dayHeadings && props.el.view !== "today"}>
												<div class="sd-agenda-time sd-agenda-date">{dayShort(group.day)}</div>
											</Show>
											<div class="sd-agenda-time">{when(event)}</div>
											<div class="sd-agenda-body">
												<div class="sd-agenda-title">{event.title}</div>
												<Show when={props.el.location && event.location}>
													<div class="sd-agenda-location">{event.location}</div>
												</Show>
											</div>
										</div>
									)}
								</For>
							</div>
						)}
					</For>
				</Show>
			</Show>
		</div>
	);
}

// ------------------------------------------------------------- opening hours

type HoursEl = El<"hours">;

export function Hours(props: RendererProps<HoursEl, HoursData>) {
	const env = useDisplay();
	const minute = useMinute();
	const locale = () => env.general().locale;
	const now = createMemo(() => zoned(minute(), env.general().timezone));
	const clock = (minutes: number) => formatMinutes(minutes, locale(), env.general().hourCycle);
	// Holidays are whole-day closures carrying the holiday's name. Without the
	// server (or when the feed fails) there are simply none.
	const closures = createMemo(() => withHolidays(props.el.closures, props.data()?.holidays ?? []));

	/** The two sets of hours, e.g. kitchen and bar; the second only when switched on. */
	const sets = createMemo((): { label: string; week: WeekHours }[] => {
		const e = props.el;
		const first = { sun: e.sun, mon: e.mon, tue: e.tue, wed: e.wed, thu: e.thu, fri: e.fri, sat: e.sat };
		if (!e.second) return [{ label: e.hoursLabel, week: first }];
		const second = { sun: e.sun2, mon: e.mon2, tue: e.tue2, wed: e.wed2, thu: e.thu2, fri: e.fri2, sat: e.sat2 };
		return [
			{ label: e.hoursLabel, week: first },
			{ label: e.hoursLabel2, week: second },
		];
	});

	const status = (week: WeekHours) => {
		const s = hoursStatus(week, closures(), now(), props.el.soonMinutes);
		const state = hoursState(s);
		const chosen = { open: props.el.openColor, soon: props.el.soonColor, closed: props.el.closedColor }[state];
		const base = { state, color: env.ink(chosen) || undefined };
		if (s.open) {
			return {
				...base,
				main: props.el.openText.replace("{time}", clock(s.closesAt)),
				note: s.soon ? props.el.soonText : s.note,
			};
		}
		if (s.opensAt === null) return { ...base, main: props.el.closedLabel, note: s.note };
		const date = new Date(minute() + s.inDays * DAY_MS);
		const day = dayWord(locale(), s.inDays, date, env.general().timezone);
		return {
			...base,
			main: props.el.closedText.replace("{day}", day).replace("{time}", clock(s.opensAt)),
			note: s.note,
		};
	};

	/**
	 * Today and the six days after it, in the chosen order, so every row is an
	 * upcoming date and closures line up with it.
	 */
	const rows = (week: WeekHours) => {
		const start = props.el.weekStart === "today" ? null : props.el.weekStart === "sun" ? 0 : 1;
		return weekOffsets(now().weekday, start).map((i) => {
			const weekday = (now().weekday + i) % 7;
			const date = shiftDate(now().date, i);
			const regular = parseRanges(week[DAY_KEYS[weekday]!]);
			const actual = rangesOn(week, closures(), date, weekday);
			const closure = closures().find((c) => c.date.trim() === date);
			return {
				name: capitalize(formatter(locale(), { weekday: "long", timeZone: "UTC" }).format(noon(date))),
				today: i === 0,
				hours: actual.length
					? actual.map(([from, to]) => `${clock(from)} – ${clock(to)}`).join(", ")
					: props.el.closedLabel,
				note: closure && (closure.note || actual.length !== regular.length) ? closure.note || props.el.closedLabel : "",
			};
		});
	};

	return (
		<div class="sd-hours" style={{ "font-size": px(props.el.size) }}>
			{/* A holiday feed that cannot be read is the editor's business, not the room's. */}
			<Show when={env.editing && props.data()?.error}>
				<Placeholder text="" error={props.data()?.error} />
			</Show>
			<For each={sets()}>
				{(set) => (
					<div class="sd-hours-set">
						<Show when={set.label}>
							<div class="sd-hours-label">{set.label}</div>
						</Show>
						<Show
							when={props.el.variant === "week"}
							fallback={
								<div class="sd-hours-status" data-open={status(set.week).state === "closed" ? undefined : ""}>
									<div class="sd-hours-main" style={{ color: status(set.week).color }}>
										{capitalize(status(set.week).main)}
									</div>
									<Show when={status(set.week).note}>
										<div class="sd-hours-note">{status(set.week).note}</div>
									</Show>
								</div>
							}
						>
							<div class="sd-hours-week">
								<For each={rows(set.week)}>
									{(row) => (
										<div
											class="sd-hours-row"
											classList={{ "sd-hours-today": row.today }}
											style={{ color: row.today ? status(set.week).color : undefined }}
										>
											<span>{row.name}</span>
											<span class="sd-hours-times">{row.hours}</span>
											<Show when={row.note}>
												<span class="sd-hours-closure">{row.note}</span>
											</Show>
										</div>
									)}
								</For>
							</div>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}
