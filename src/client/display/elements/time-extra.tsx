/**
 * The later time elements: world clocks, timetable, birthdays, progress and
 * sun & moon. Everything here is computed on the display from its clock; only
 * birthdays read from a calendar come from the server.
 */
import { createMemo, For, type JSX, Show } from "solid-js";
import { moonPath, moonPhase, sunTimes } from "../../../shared/astro";
import type { BirthdaysData } from "../../../shared/data";
import type { El } from "../../../shared/elements";
import {
	daysBetween,
	formatMinutes,
	fractionBetween,
	isoWeek,
	type Period,
	periodRange,
	type TimetableSlot,
	timeFormatter,
	timetableAt,
	upcomingAnniversaries,
	wallInstant,
	zoned,
} from "../../../shared/time";
import { px, useDisplay, useMinute, useNow } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";
import { ClockFace, capitalize, dayWord, formatter } from "./time";

/** "1 hr 20 min", "3 days": a length of time in the display's language. */
function duration(minutes: number, locale: string): string {
	const unit = (value: number, name: "day" | "hour" | "minute", display: "short" | "long" = "short") => {
		try {
			return new Intl.NumberFormat(locale || undefined, { style: "unit", unit: name, unitDisplay: display }).format(
				value,
			);
		} catch {
			return `${value} ${name === "minute" ? "min" : name === "hour" ? "h" : "d"}`;
		}
	};
	const total = Math.max(0, Math.round(minutes));
	// Days round up, as on the countdown: "2 days left" until the last day begins.
	if (total >= 48 * 60) return unit(Math.ceil(total / 1440), "day", "long");
	const hours = Math.floor(total / 60);
	const rest = total % 60;
	if (!hours) return unit(rest, "minute");
	return rest ? `${unit(hours, "hour")} ${unit(rest, "minute")}` : unit(hours, "hour");
}

const SunIcon = () => (
	<svg class="sd-daynight" viewBox="-12 -12 24 24" aria-hidden="true">
		<circle r="4.2" fill="currentColor" />
		<For each={[0, 45, 90, 135, 180, 225, 270, 315]}>
			{(angle) => (
				<line
					y1="-7"
					y2="-10"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					transform={`rotate(${angle})`}
				/>
			)}
		</For>
	</svg>
);
const NightIcon = () => (
	<svg class="sd-daynight" viewBox="-12 -12 24 24" aria-hidden="true">
		<path d="M3 -9.5A9.5 9.5 0 1 0 9.5 5A7.6 7.6 0 0 1 3 -9.5Z" fill="currentColor" />
	</svg>
);

// --------------------------------------------------------------- world clocks

interface City {
	label: string;
	timezone: string;
}

export function WorldClocks(props: RendererProps<El<"world-clocks">>) {
	const env = useDisplay();
	const second = useNow();
	const minute = useMinute();
	// ePaper refreshes slowly: never tick seconds there.
	const seconds = () => props.el.seconds && !env.lowColor();
	const now = () => (seconds() ? second() : minute());
	const home = () => env.general().timezone;
	const locale = () => env.general().locale;

	const cities = createMemo(() =>
		(props.el.cities as City[]).map((city) => {
			const zone = city.timezone.trim() || home();
			const there = zoned(now(), zone);
			const offset = daysBetween(zoned(now(), home()).date, there.date);
			const cycle = props.el.hourCycle === "auto" ? env.general().hourCycle : props.el.hourCycle;
			const parts = timeFormatter(locale(), cycle, zone, seconds()).formatToParts(now());
			let shift = "";
			if (offset && props.el.dayOffset === "number") shift = offset > 0 ? `+${offset}` : `−${-offset}`;
			if (offset && props.el.dayOffset === "word") shift = capitalize(dayWord(locale(), offset, new Date(now()), zone));
			return {
				label: city.label || zone.split("/").at(-1)?.replace(/_/g, " ") || "",
				zone,
				time: parts
					.filter((p) => p.type !== "dayPeriod")
					.map((p) => p.value)
					.join("")
					.trim(),
				period: parts.find((p) => p.type === "dayPeriod")?.value ?? "",
				date: formatter(locale(), {
					weekday: "short",
					day: "numeric",
					month: "short",
					timeZone: zone || undefined,
				}).format(now()),
				shift,
				// A hint, not astronomy: the working day against the evening and night.
				night: there.hour < 6 || there.hour >= 19,
			};
		}),
	);
	const perRow = () => (props.el.perRow > 0 ? props.el.perRow : Math.max(1, cities().length));

	return (
		<div
			class="sd-worldclocks"
			style={{ "font-size": px(props.el.size), "grid-template-columns": `repeat(${perRow()}, minmax(0, 1fr))` }}
		>
			<For each={cities()} fallback={<Placeholder text="Add a city" />}>
				{(city) => (
					<div class="sd-worldclock" classList={{ "sd-worldclock-night": city.night && props.el.dayNight }}>
						<div class="sd-worldclock-label">
							<Show when={props.el.dayNight}>
								<Show when={city.night} fallback={<SunIcon />}>
									<NightIcon />
								</Show>
							</Show>
							{city.label}
						</div>
						<Show
							when={props.el.style === "analog"}
							fallback={
								<div class="sd-worldclock-time">
									{city.time}
									<Show when={city.period}>
										<span class="sd-clock-period">{city.period}</span>
									</Show>
									<Show when={city.shift && props.el.dayOffset === "number"}>
										<sup class="sd-worldclock-shift">{city.shift}</sup>
									</Show>
								</div>
							}
						>
							<ClockFace at={now()} zone={city.zone} seconds={seconds()} face={props.el.face} />
						</Show>
						<Show
							when={props.el.date || (city.shift && (props.el.dayOffset === "word" || props.el.style === "analog"))}
						>
							<div class="sd-worldclock-date">
								{props.el.date ? city.date : city.shift}
								<Show
									when={props.el.date && city.shift && props.el.style === "analog" && props.el.dayOffset === "number"}
								>
									{` (${city.shift})`}
								</Show>
							</div>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}

// ------------------------------------------------------------------ timetable

interface TimetableEntry {
	days: number[];
	from: string;
	to: string;
	title: string;
	note: string;
}

export function Timetable(props: RendererProps<El<"timetable">>) {
	const env = useDisplay();
	const minute = useMinute();
	const locale = () => env.general().locale;
	const now = createMemo(() => zoned(minute(), env.general().timezone));
	const table = createMemo(() =>
		timetableAt(
			(props.el.slots as TimetableEntry[]).filter((row) => row && typeof row.from === "string"),
			now(),
		),
	);
	const clock = (minutes: number) => formatMinutes(minutes, locale(), env.general().hourCycle);
	const span = (slot: TimetableSlot<TimetableEntry>) =>
		slot.end > slot.start ? `${clock(slot.start)} – ${clock(slot.end)}` : clock(slot.start);
	/** "14:00", or "tomorrow 09:00" / "Friday 09:00" for a slot on a later day. */
	const startsAt = (slot: TimetableSlot<TimetableEntry>) => {
		const offset = Math.floor(slot.start / 1440);
		if (offset <= 0) return clock(slot.start);
		const day = dayWord(locale(), offset, new Date(minute() + offset * 86_400_000), env.general().timezone);
		return `${capitalize(day)} ${clock(slot.start)}`;
	};
	const left = (slot: TimetableSlot<TimetableEntry>) =>
		props.el.leftText.replace("{time}", duration(slot.end - now().minutes, locale()));
	const Body = (p: { slot: TimetableSlot<TimetableEntry> }) => (
		<div class="sd-timetable-body">
			<div class="sd-timetable-title">{p.slot.row.title}</div>
			<Show when={props.el.notes && p.slot.row.note}>
				<div class="sd-timetable-note">{p.slot.row.note}</div>
			</Show>
		</div>
	);
	const accent = (): JSX.CSSProperties => ({ "--sd-ring": env.ink(props.el.color) || "var(--sd-accent)" });

	return (
		<div class="sd-timetable" style={{ "font-size": px(props.el.size), ...accent() }} data-variant={props.el.variant}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<Show when={props.el.slots.length} fallback={<Placeholder text="Add a time slot" />}>
				<Show
					when={props.el.variant === "day"}
					fallback={
						<>
							<Show when={props.el.nowLabel}>
								<div class="sd-timetable-heading">{props.el.nowLabel}</div>
							</Show>
							<For each={table().current} fallback={<div class="sd-empty">{props.el.emptyText}</div>}>
								{(slot) => (
									<div class="sd-timetable-now">
										<div class="sd-timetable-row">
											<Body slot={slot} />
											<Show when={props.el.remaining === "left" || props.el.remaining === "both"}>
												<div class="sd-timetable-left">{left(slot)}</div>
											</Show>
										</div>
										<Show when={props.el.remaining === "bar" || props.el.remaining === "both"}>
											<div class="sd-timebar">
												<div
													class="sd-timebar-fill"
													style={{ width: `${fractionBetween(slot.start, slot.end, now().minutes) * 100}%` }}
												/>
											</div>
										</Show>
									</div>
								)}
							</For>
							<Show when={props.el.count > 0 && table().next.length}>
								<Show when={props.el.nextLabel}>
									<div class="sd-timetable-heading sd-timetable-heading-next">{props.el.nextLabel}</div>
								</Show>
								<For each={table().next.slice(0, props.el.count)}>
									{(slot) => (
										<div class="sd-timetable-row">
											<div class="sd-timetable-time">{startsAt(slot)}</div>
											<Body slot={slot} />
										</div>
									)}
								</For>
							</Show>
						</>
					}
				>
					<For each={table().today} fallback={<div class="sd-empty">{props.el.emptyText}</div>}>
						{(slot) => (
							<div
								class="sd-timetable-row"
								classList={{
									"sd-timetable-current": slot.start <= now().minutes && now().minutes < slot.end,
									"sd-timetable-past": slot.end <= now().minutes,
								}}
							>
								<div class="sd-timetable-time">{span(slot)}</div>
								<Body slot={slot} />
							</div>
						)}
					</For>
				</Show>
			</Show>
		</div>
	);
}

// ------------------------------------------------------------------ birthdays

interface Person {
	name: string;
	date: string;
	kind: string;
}

export function Birthdays(props: RendererProps<El<"birthdays">, BirthdaysData>) {
	const env = useDisplay();
	const minute = useMinute();
	const locale = () => env.general().locale;
	const today = createMemo(() => zoned(minute(), env.general().timezone).date);
	const list = createMemo(() => {
		const people = [...(props.el.people as Person[]), ...(props.data()?.entries ?? [])].filter(
			(p) => p && typeof p.date === "string" && p.name,
		);
		return upcomingAnniversaries(people, today(), props.el.days, props.el.leapDay).slice(0, props.el.max);
	});
	/** "today", "tomorrow", "in 3 days". */
	const when = (inDays: number) => {
		try {
			return new Intl.RelativeTimeFormat(locale() || undefined, { numeric: "auto" }).format(inDays, "day");
		} catch {
			return inDays === 0 ? "today" : `in ${inDays} days`;
		}
	};
	const date = (iso: string) =>
		formatter(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
			new Date(`${iso}T12:00:00Z`),
		);
	const years = (entry: { row: Person; years: number | null }) => {
		if (!props.el.age || !entry.years) return "";
		const text = entry.row.kind === "anniversary" ? props.el.yearsText : props.el.ageText;
		return text.replace("{n}", String(entry.years));
	};
	const empty = () => !props.el.people.length && !props.el.sources.length;

	return (
		<div class="sd-birthdays" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<Show when={!empty()} fallback={<Placeholder text="Add people or a calendar" />}>
				<Show when={env.editing && props.data()?.errors.length}>
					<Placeholder text="" error={props.data()?.errors.join(" · ")} />
				</Show>
				<For each={list()} fallback={<div class="sd-empty">{props.el.emptyText}</div>}>
					{(entry) => (
						<div class="sd-birthday" classList={{ "sd-birthday-today": entry.inDays === 0 }}>
							<svg class="sd-birthday-icon" viewBox="0 0 24 24" aria-hidden="true">
								<Show
									when={entry.row.kind === "anniversary"}
									fallback={
										<path
											d="M12 3v.5M12 7v5M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M3 21h18M5 16.5c1.2 1 2.3 1 3.5 0s2.3-1 3.5 0 2.3 1 3.5 0 2.3-1 3.5 0"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										/>
									}
								>
									<path
										d="M12 20.5 4.5 13a4.8 4.8 0 0 1 6.8-6.8l.7.7.7-.7A4.8 4.8 0 0 1 19.5 13Z"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linejoin="round"
									/>
								</Show>
							</svg>
							<div class="sd-birthday-body">
								<div class="sd-birthday-name">{entry.row.name}</div>
								<Show when={years(entry)}>
									<div class="sd-birthday-years">{years(entry)}</div>
								</Show>
							</div>
							<div class="sd-birthday-when">
								<div>{capitalize(when(entry.inDays))}</div>
								<Show when={props.el.dates && entry.inDays > 0}>
									<div class="sd-birthday-date">{date(entry.date)}</div>
								</Show>
							</div>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}

// ------------------------------------------------------------------- progress

export function Progress(props: RendererProps<El<"progress">>) {
	const env = useDisplay();
	const minute = useMinute();
	const zone = () => env.general().timezone;
	const locale = () => env.general().locale;
	const range = createMemo((): [number, number] | null => {
		if (props.el.range !== "custom") {
			return periodRange(
				props.el.range as Period,
				zoned(minute(), zone()),
				zone(),
				props.el.weekStart === "sun" ? 0 : 1,
			);
		}
		const start = wallInstant(props.el.start, zone());
		const end = wallInstant(props.el.end, zone());
		return Number.isNaN(start) || Number.isNaN(end) || end <= start ? null : [start, end];
	});
	const fraction = () => {
		const r = range();
		return r ? fractionBetween(r[0], r[1], minute()) : 0;
	};
	const percent = () => {
		const digits = Math.min(3, Math.max(0, props.el.decimals));
		// Rounded down: 100% is for when it is over, not for the last half percent.
		const scale = 10 ** digits;
		const value = Math.floor(fraction() * 100 * scale) / scale;
		try {
			return new Intl.NumberFormat(locale() || undefined, {
				style: "percent",
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
			}).format(value / 100);
		} catch {
			return `${value.toFixed(digits)}%`;
		}
	};
	const left = () => {
		const r = range();
		if (!r) return "";
		const minutes = (r[1] - minute()) / 60_000;
		return minutes <= 0 ? props.el.doneText : props.el.leftText.replace("{time}", duration(minutes, locale()));
	};
	/** The name of the period, when no label was typed. */
	const label = () => {
		if (props.el.label || props.el.range === "custom") return props.el.label;
		const z = zoned(minute(), zone());
		const name = (options: Intl.DateTimeFormatOptions) =>
			capitalize(formatter(locale(), { ...options, timeZone: zone() || undefined }).format(minute()));
		switch (props.el.range) {
			case "day":
				return name({ weekday: "long" });
			case "week":
				return `Week ${isoWeek(z.year, z.month, z.day)}`;
			case "month":
				return name({ month: "long" });
			case "quarter":
				return `Q${Math.ceil(z.month / 3)} ${z.year}`;
			default:
				return String(z.year);
		}
	};
	const showPercent = () => props.el.detail === "percent" || props.el.detail === "both";
	const showLeft = () => props.el.detail === "left" || props.el.detail === "both";
	const color = (): JSX.CSSProperties => ({ "--sd-ring": env.ink(props.el.color) || "var(--sd-accent)" });

	return (
		<div class="sd-progress" style={{ "font-size": px(props.el.size), ...color() }} data-variant={props.el.variant}>
			<Show when={range()} fallback={<Placeholder text="Choose a start and an end" />}>
				<Show
					when={props.el.variant === "ring"}
					fallback={
						<>
							<div class="sd-progress-head">
								<span class="sd-progress-label">{label()}</span>
								<Show when={showPercent()}>
									<span class="sd-progress-value">{percent()}</span>
								</Show>
							</div>
							<div class="sd-timebar">
								<div class="sd-timebar-fill" style={{ width: `${fraction() * 100}%` }} />
							</div>
							<Show when={showLeft()}>
								<div class="sd-progress-left">{left()}</div>
							</Show>
						</>
					}
				>
					<div class="sd-progress-ring">
						<svg viewBox="0 0 100 100" aria-hidden="true">
							<circle class="sd-timering-track" cx="50" cy="50" r="44" />
							<circle
								class="sd-timering-value"
								cx="50"
								cy="50"
								r="44"
								pathLength="100"
								stroke-dasharray="100"
								stroke-dashoffset={100 - fraction() * 100}
								transform="rotate(-90 50 50)"
							/>
						</svg>
						<div class="sd-progress-centre">
							<Show when={showPercent()} fallback={<span class="sd-progress-left">{showLeft() ? left() : ""}</span>}>
								<span class="sd-progress-value">{percent()}</span>
							</Show>
						</div>
					</div>
					<Show when={label()}>
						<div class="sd-progress-label">{label()}</div>
					</Show>
					<Show when={showLeft() && showPercent()}>
						<div class="sd-progress-left">{left()}</div>
					</Show>
				</Show>
			</Show>
		</div>
	);
}

// ----------------------------------------------------------------- sun & moon

const PHASE_NAMES: Record<string, string> = {
	new: "New moon",
	"waxing-crescent": "Waxing crescent",
	"first-quarter": "First quarter",
	"waxing-gibbous": "Waxing gibbous",
	full: "Full moon",
	"waning-gibbous": "Waning gibbous",
	"last-quarter": "Last quarter",
	"waning-crescent": "Waning crescent",
};

/** The moon as seen from a hemisphere: a dim disc with its lit part on top. */
function Moon(props: { phase: number; southern: boolean }) {
	return (
		<svg class="sd-moon" viewBox="-12 -12 24 24" role="img" aria-label="Moon phase">
			<circle r="10" class="sd-moon-disc" />
			<path d={moonPath(props.phase, 10, props.southern)} fill="currentColor" />
		</svg>
	);
}

/** A sun on the horizon with an arrow: up for sunrise, down for sunset. */
function HorizonIcon(props: { down?: boolean }) {
	return (
		<svg class="sd-sun-icon" viewBox="0 0 24 24" aria-hidden="true">
			<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M2 18h20M6 22h12M16 18a4 4 0 0 0-8 0M4.9 10.9l1.4 1.4M19.1 10.9l-1.4 1.4" />
				<path d={props.down ? "M12 2v7M9 6l3 3 3-3" : "M12 9V2M9 5l3-3 3 3"} />
			</g>
		</svg>
	);
}

export function SunMoon(props: RendererProps<El<"sun-moon">>) {
	const env = useDisplay();
	const minute = useMinute();
	const locale = () => env.general().locale;
	const zone = () => props.el.timezone.trim() || env.general().timezone;
	const place = createMemo(() => {
		const own = props.el.latitude !== 0 || props.el.longitude !== 0;
		const latitude = own ? props.el.latitude : env.general().latitude;
		const longitude = own ? props.el.longitude : env.general().longitude;
		return latitude === 0 && longitude === 0 ? null : { latitude, longitude };
	});
	const sun = createMemo(() => {
		const at = place();
		return at ? sunTimes(zoned(minute(), zone()).date, at.latitude, at.longitude) : null;
	});
	const moon = createMemo(() => moonPhase(minute()));
	const southern = () => (place()?.latitude ?? 0) < 0;
	const time = (ms: number | null) =>
		ms === null ? "–" : timeFormatter(locale(), env.general().hourCycle, zone()).format(new Date(ms));
	const daylight = () => {
		const s = sun();
		if (!s) return "";
		if (s.polar) return s.polar === "day" ? "Midnight sun" : "Polar night";
		return duration(s.dayLength, locale());
	};
	const moonText = () => {
		const name = PHASE_NAMES[moon().name] ?? "";
		return props.el.percent ? `${name} · ${Math.round(moon().illumination * 100)}%` : name;
	};
	/** Where the sun is on its arc, 0 at sunrise to 1 at sunset; null at night. */
	const position = () => {
		const s = sun();
		if (!s) return null;
		if (s.polar) return s.polar === "day" ? 0.5 : null;
		const now = minute();
		return now >= s.rise! && now <= s.set! ? fractionBetween(s.rise!, s.set!, now) : null;
	};
	const dot = () => {
		const f = position() ?? 0;
		return { x: 100 - 80 * Math.cos(Math.PI * f), y: 70 - 56 * Math.sin(Math.PI * f) };
	};

	return (
		<div class="sd-sunmoon" style={{ "font-size": px(props.el.size) }} data-variant={props.el.variant}>
			<Show when={sun()} fallback={<Placeholder text="Set a location here or in the settings" />}>
				{(s) => (
					<>
						<Show when={props.el.variant === "arc"}>
							<svg class="sd-sun-arc" viewBox="0 0 200 84" role="img" aria-label="The sun's path today">
								<path
									class="sd-sun-arc-path"
									classList={{ "sd-sun-arc-night": position() === null }}
									d="M20 70A80 56 0 0 1 180 70"
								/>
								<line class="sd-sun-arc-horizon" x1="6" y1="70" x2="194" y2="70" />
								<Show when={position() !== null}>
									<circle class="sd-sun-arc-dot" cx={dot().x} cy={dot().y} r="7" />
								</Show>
							</svg>
						</Show>
						<div class="sd-sunmoon-items">
							<div class="sd-sunmoon-item">
								<HorizonIcon />
								<div>
									<div class="sd-sunmoon-name">Sunrise</div>
									<div class="sd-sunmoon-value">{time(s().rise)}</div>
								</div>
							</div>
							<Show when={props.el.dayLength}>
								<div class="sd-sunmoon-item sd-sunmoon-daylight">
									<SunIcon />
									<div>
										<div class="sd-sunmoon-name">Daylight</div>
										<div class="sd-sunmoon-value">{daylight()}</div>
									</div>
								</div>
							</Show>
							<div class="sd-sunmoon-item">
								<HorizonIcon down />
								<div>
									<div class="sd-sunmoon-name">Sunset</div>
									<div class="sd-sunmoon-value">{time(s().set)}</div>
								</div>
							</div>
							<Show when={props.el.moon}>
								<div class="sd-sunmoon-item sd-sunmoon-moon">
									<Moon phase={moon().phase} southern={southern()} />
									<div>
										<div class="sd-sunmoon-name">Moon</div>
										<div class="sd-sunmoon-value">{moonText()}</div>
									</div>
								</div>
							</Show>
						</div>
					</>
				)}
			</Show>
		</div>
	);
}
