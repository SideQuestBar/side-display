import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { contrastOn } from "../../../shared/color";
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
} from "../../../shared/data";
import type { El } from "../../../shared/elements";
import { timeFormatter, zoned } from "../../../shared/time";
import { px, useDisplay, useMinute, useNow } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";
import { Picture } from "../Picture";
import { useMarquee } from "./content";
import { EntityRows, EntityValue } from "./ha";

const UP = "#30a46c";
const DOWN = "#e5484d";

/** `Intl` formatters throw on a mistyped locale, time zone or currency; fall back to the device's. */
function safely<T>(build: () => T, fallback: () => T): T {
	try {
		return build();
	} catch {
		return fallback();
	}
}

/** Formats instants as a clock time, and as a short day when they are not today. */
function useWhen() {
	const env = useDisplay();
	const minute = useMinute();
	const zone = () => env.general().timezone;
	const clock = createMemo(() => timeFormatter(env.general().locale, env.general().hourCycle, zone()));
	const dayKey = (time: number) => {
		const z = zoned(time, zone());
		return z.year * 372 + z.month * 31 + z.day;
	};
	const today = createMemo(() => dayKey(minute()));
	const day = createMemo(() => {
		const options = { weekday: "short", day: "numeric", month: "short" } as const;
		return safely(
			() => new Intl.DateTimeFormat(env.general().locale || undefined, { ...options, timeZone: zone() || undefined }),
			() => new Intl.DateTimeFormat(undefined, options),
		);
	});
	return {
		time: (time: number) => clock().format(time),
		/** Empty for today. */
		day: (time: number) => (dayKey(time) === today() ? "" : day().format(time)),
	};
}

// ------------------------------------------------------------------- transit

export function Transit(props: RendererProps<El<"transit">, TransitData>) {
	const env = useDisplay();
	const second = useNow();
	const when = useWhen();
	// Minutes do not need the screen redrawn every second.
	const now = createMemo(() => Math.floor(second() / 10_000) * 10_000);
	const rows = createMemo(() => {
		const earliest = now() + Math.max(0, props.el.walk) * 60_000;
		return (props.data()?.departures ?? [])
			.filter((departure) => departure.when >= earliest)
			.slice(0, Math.max(1, props.el.count));
	});
	const minutes = createMemo(() =>
		safely(
			() =>
				new Intl.NumberFormat(env.general().locale || undefined, {
					style: "unit",
					unit: "minute",
					unitDisplay: "short",
				}),
			() => new Intl.NumberFormat(undefined, { style: "unit", unit: "minute", unitDisplay: "short" }),
		),
	);
	const countdown = (departure: TransitDeparture) => {
		const left = Math.floor((departure.when - now()) / 60_000);
		if (left <= 0) return props.el.nowText;
		// Past the hour a clock time says more than "83 min".
		return left > 60 ? when.time(departure.when) : minutes().format(left);
	};
	const badge = (departure: TransitDeparture): JSX.CSSProperties => {
		if (!props.el.lineColors || !departure.color) return {};
		// One ink cannot show a line's colour: leave the badge outlined.
		if (env.mode() === "mono" || env.mode() === "gray") return {};
		const background = env.ink(departure.color);
		return {
			background,
			// The few inks of a colour ePaper are not the line's own: pick the text that reads on them.
			color: env.lowColor() ? contrastOn(background) : departure.textColor || contrastOn(background),
			"border-color": "transparent",
		};
	};
	return (
		<div class="sd-transit" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title || (props.el.stopName && props.data()?.stop)}>
				<div class="sd-title">{props.el.title || props.data()?.stop}</div>
			</Show>
			<Show
				when={props.data()}
				fallback={
					<Placeholder text={props.el.stop.trim() ? "Loading departures…" : "Enter a stop"} error={props.error()} />
				}
			>
				<div class="sd-transit-rows" classList={{ "sd-transit-platforms": props.el.platform }}>
					<For each={rows()} fallback={<div class="sd-empty">{props.el.emptyText}</div>}>
						{(departure) => (
							<div class="sd-transit-row" classList={{ "sd-transit-cancelled": departure.cancelled }}>
								<span class="sd-transit-line" style={badge(departure)}>
									{departure.line}
								</span>
								<span class="sd-transit-destination">{departure.destination}</span>
								<Show when={props.el.platform}>
									<span class="sd-transit-platform">{departure.platform}</span>
								</Show>
								<span class="sd-transit-when">
									<Show
										when={!departure.cancelled}
										fallback={<span class="sd-transit-note">{props.el.cancelledText}</span>}
									>
										<Show when={props.el.delays && departure.delay !== null && departure.delay > 0}>
											<span class="sd-transit-delay" style={{ color: env.ink(DOWN) }}>
												+{departure.delay}
											</span>
										</Show>
										<Show when={props.el.clock !== "time"}>
											<span class="sd-transit-minutes">{countdown(departure)}</span>
										</Show>
										<Show when={props.el.clock !== "minutes"}>
											<span classList={{ "sd-transit-clock": props.el.clock === "both" }}>
												{when.time(departure.when)}
											</span>
										</Show>
									</Show>
								</span>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

// -------------------------------------------------------------------- stocks

function Sparkline(props: { values: number[]; color: string }) {
	const points = createMemo(() => {
		const { values } = props;
		if (values.length < 2) return "";
		const min = Math.min(...values);
		const span = Math.max(...values) - min || 1;
		return values
			.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 26).toFixed(1)}`)
			.join(" ");
	});
	return (
		<Show when={points()}>
			<svg class="sd-stocks-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="Trend">
				<polyline
					points={points()}
					fill="none"
					stroke={props.color}
					stroke-width="2.5"
					stroke-linejoin="round"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
				/>
			</svg>
		</Show>
	);
}

export function Stocks(props: RendererProps<El<"stocks">, StocksData>) {
	const env = useDisplay();
	const quotes = () => props.data()?.quotes ?? [];
	const locale = () => env.general().locale || undefined;

	const price = (quote: Quote) => {
		if (quote.price === null) return "–";
		// Small prices (a cheap coin, an exchange rate) need more digits to say anything.
		const digits = props.el.decimals >= 0 ? props.el.decimals : Math.abs(quote.price) < 10 ? 4 : 2;
		const fraction = { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits };
		const plain = () =>
			safely(
				() => new Intl.NumberFormat(locale(), fraction),
				() => new Intl.NumberFormat(undefined, fraction),
			);
		if (!props.el.currencySign || !quote.currency) return plain().format(quote.price);
		return safely(
			() =>
				new Intl.NumberFormat(locale(), {
					...fraction,
					style: "currency",
					currency: quote.currency,
					currencyDisplay: "narrowSymbol",
				}),
			plain,
		).format(quote.price);
	};
	const direction = (quote: Quote) => Math.sign(quote.percent ?? quote.change ?? 0);
	const color = (quote: Quote) => {
		const d = direction(quote);
		return d === 0 ? "currentColor" : env.ink(d > 0 ? props.el.upColor || UP : props.el.downColor || DOWN);
	};
	// The arrow says what the colour says, for screens without colour.
	const arrow = (quote: Quote) => ["▼", "", "▲"][direction(quote) + 1];
	const move = (quote: Quote) => {
		const parts: string[] = [];
		const signed = (value: number, digits: number) =>
			safely(
				() =>
					new Intl.NumberFormat(locale(), {
						signDisplay: "exceptZero",
						maximumFractionDigits: digits,
						minimumFractionDigits: digits,
					}),
				() => new Intl.NumberFormat(undefined, { signDisplay: "exceptZero", maximumFractionDigits: digits }),
			).format(value);
		if (props.el.change && quote.change !== null) parts.push(signed(quote.change, Math.abs(quote.change) < 10 ? 2 : 1));
		if (props.el.percent && quote.percent !== null) parts.push(`${signed(quote.percent, 2)} %`);
		// Both: the amount, then the percentage in brackets.
		return parts.length === 2 ? `${parts[0]} (${parts[1]})` : (parts[0] ?? "");
	};
	const Move = (p: { quote: Quote }) => (
		<Show when={move(p.quote)}>
			<span class="sd-stocks-move" style={{ color: color(p.quote) }}>
				<span class="sd-stocks-arrow">{arrow(p.quote)}</span> {move(p.quote)}
			</span>
		</Show>
	);

	const marquee = useMarquee(
		() => props.el.speed,
		() => [quotes(), props.el.size, props.el.variant],
	);
	const strip = () => (
		<For each={quotes()}>
			{(quote) => (
				<span class="sd-stocks-item">
					<span class="sd-stocks-label">{quote.label}</span>
					<span class="sd-stocks-price">{price(quote)}</span>
					<Move quote={quote} />
				</span>
			)}
		</For>
	);

	return (
		<div class="sd-stocks" style={{ "font-size": px(props.el.size) }} data-variant={props.el.variant}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<Show
				when={quotes().length}
				fallback={
					<Placeholder
						text={props.el.symbols.some((row) => row.symbol.trim()) ? "Loading prices…" : "Add a symbol"}
						error={props.error()}
					/>
				}
			>
				<Show
					when={props.el.variant === "ticker"}
					fallback={
						<div
							class="sd-stocks-list"
							style={{
								"grid-template-columns":
									props.el.variant === "tiles" ? `repeat(${Math.max(1, props.el.perRow)}, minmax(0, 1fr))` : undefined,
							}}
						>
							<For each={quotes()}>
								{(quote) => (
									<div class="sd-stocks-quote">
										<span class="sd-stocks-label">{quote.label}</span>
										<Show when={props.el.sparkline && props.el.variant === "rows"}>
											<Sparkline values={quote.history} color={color(quote)} />
										</Show>
										<span class="sd-stocks-price">{price(quote)}</span>
										<Move quote={quote} />
										<Show when={props.el.sparkline && props.el.variant === "tiles"}>
											<Sparkline values={quote.history} color={color(quote)} />
										</Show>
										<Show when={env.editing && quote.error}>
											<span class="sd-stocks-error">{quote.error}</span>
										</Show>
									</div>
								)}
							</For>
						</div>
					}
				>
					{/* ePaper cannot scroll: the strip stands still and shows what fits. */}
					<Show when={!env.lowColor()} fallback={<div class="sd-stocks-static">{strip()}</div>}>
						<div class="sd-stocks-track" ref={marquee.ref} style={{ "animation-duration": `${marquee.duration()}s` }}>
							<For each={marquee.copies()}>{() => strip()}</For>
						</div>
					</Show>
				</Show>
			</Show>
		</div>
	);
}

// -------------------------------------------------------------------- sports

export function Sports(props: RendererProps<El<"sports">, SportsData>) {
	const env = useDisplay();
	const when = useWhen();
	const events = () => props.data()?.events ?? [];
	const Side = (p: { side: SportsSide; home?: boolean }) => (
		<span class="sd-sports-side" classList={{ "sd-sports-home": p.home, "sd-sports-winner": p.side.winner }}>
			<Show when={props.el.logos && p.side.logo}>
				<span class="sd-sports-logo">
					<Picture src={p.side.logo} fit="contain" />
				</span>
			</Show>
			<span class="sd-sports-name">{props.el.shortNames ? p.side.short : p.side.name}</span>
		</span>
	);
	const stamp = (event: SportsEvent) => {
		const time = Date.parse(event.date);
		if (event.state === "in") return { main: event.status, sub: "" };
		if (event.state === "post") return { main: event.status, sub: when.day(time) };
		return { main: when.time(time), sub: when.day(time) };
	};
	return (
		<div class="sd-sports" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title || (props.el.leagueName && props.data()?.league)}>
				<div class="sd-title">{props.el.title || props.data()?.league}</div>
			</Show>
			<Show when={props.data()} fallback={<Placeholder text="Loading scores…" error={props.error()} />}>
				<div class="sd-sports-rows">
					<For each={events()} fallback={<div class="sd-empty">{props.el.emptyText}</div>}>
						{(event) => (
							<div class="sd-sports-row" data-state={event.state}>
								<span class="sd-sports-when">
									<span class="sd-sports-status" style={{ color: event.state === "in" ? env.ink(DOWN) : undefined }}>
										{/* A dot marks a running match where red cannot. */}
										{event.state === "in" ? "● " : ""}
										{stamp(event).main}
									</span>
									<Show when={stamp(event).sub}>
										<span class="sd-sports-day">{stamp(event).sub}</span>
									</Show>
								</span>
								<Show when={event.home && event.away} fallback={<span class="sd-sports-event">{event.name}</span>}>
									<Side side={event.home as SportsSide} home />
									<span class="sd-sports-score">
										{event.home?.score && event.away?.score ? `${event.home.score} – ${event.away.score}` : "–"}
									</span>
									<Side side={event.away as SportsSide} />
								</Show>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

// -------------------------------------------------------------------- uptime

export function Uptime(props: RendererProps<El<"uptime">, UptimeData>) {
	const env = useDisplay();
	const when = useWhen();
	const checks = () => props.data()?.checks ?? [];
	const down = () => checks().filter((check) => !check.up);
	const shown = () => (props.el.onlyDown ? down() : checks());
	const color = (check: UptimeCheck) => env.ink(check.up ? UP : DOWN);
	const detail = (check: UptimeCheck) => {
		if (check.up) return props.el.responseTime ? `${check.ms} ms` : "";
		const since = [when.day(check.since), when.time(check.since)].filter(Boolean).join(" ");
		return `${check.error} · ${props.el.sinceText} ${since}`;
	};
	return (
		<div class="sd-uptime" style={{ "font-size": px(props.el.size) }} data-variant={props.el.variant}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<Show
				when={props.data()}
				fallback={
					<Placeholder text={props.el.sites.length ? "Checking…" : "Add an address to watch"} error={props.error()} />
				}
			>
				<Show when={props.el.okText && checks().length > 0 && down().length === 0}>
					<div class="sd-uptime-ok">
						<span style={{ color: env.ink(UP) }}>✓</span> {props.el.okText}
					</div>
				</Show>
				<div
					class="sd-uptime-list"
					style={{
						"grid-template-columns":
							props.el.variant === "tiles" ? `repeat(${Math.max(1, props.el.perRow)}, minmax(0, 1fr))` : undefined,
					}}
				>
					<For each={shown()}>
						{(check) => (
							<div class="sd-uptime-check" data-up={check.up ? "yes" : "no"} style={{ "--sd-uptime": color(check) }}>
								{/* The symbol and the word carry the state where colour cannot. */}
								<span class="sd-uptime-mark">{check.up ? "✓" : "✕"}</span>
								<span class="sd-uptime-label">{check.label}</span>
								<span class="sd-uptime-state">{check.up ? props.el.upText : props.el.downText}</span>
								<Show when={detail(check)}>
									<span class="sd-uptime-detail">{detail(check)}</span>
								</Show>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

// ---------------------------------------------------------------- json value

export function JsonValue(props: RendererProps<El<"json">, JsonValueData>) {
	const rows = createMemo(() =>
		props.el.values.flatMap((row, i) => {
			const state = props.data()?.states[i];
			return state ? [{ label: row.label || state.name, state }] : [];
		}),
	);
	return (
		<Show
			when={props.el.variant === "value"}
			fallback={
				<EntityRows
					el={{
						title: props.el.title,
						size: props.el.rowSize,
						variant: props.el.variant,
						columns: props.el.perRow,
						thresholds: props.el.thresholds,
						stateMap: props.el.stateMap,
					}}
					rows={rows()}
					empty={props.el.values.length ? "Nothing to show yet" : "Add a value"}
					error={props.error()}
				/>
			}
		>
			<Show
				when={props.data()?.state}
				fallback={<Placeholder text={props.el.url.trim() ? "Loading…" : "Enter an address"} error={props.error()} />}
			>
				{(state) => <EntityValue state={state()} el={props.el} />}
			</Show>
		</Show>
	);
}

// --------------------------------------------------------------------- chart

const PALETTE = ["#3b82f6", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
// How series are told apart without colour: a fill pattern and a dash each.
const PATTERNS = ["solid", "diagonal", "dots", "horizontal", "cross", "vertical", "backward", "grid"] as const;
const DASHES = ["", "10 6", "2 5", "14 5 2 5", "6 3", "1 3", "18 6", "8 3 2 3 2 3"];

/** Round axis steps (1, 2, 2.5 or 5 times a power of ten) covering min…max. */
function axisTicks(min: number, max: number, wanted: number): number[] {
	const span = max - min || Math.abs(max) || 1;
	const rough = span / Math.max(1, wanted);
	const power = 10 ** Math.floor(Math.log10(rough));
	const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
	const ticks: number[] = [];
	for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step)
		ticks.push(Math.abs(value) < step * 1e-9 ? 0 : value);
	return ticks;
}

function PatternDefs(props: { id: string; colors: string[] }) {
	const tile = (kind: (typeof PATTERNS)[number], color: string) => {
		const line = { stroke: color, "stroke-width": 2.5 };
		switch (kind) {
			case "diagonal":
				return <path d="M-2 10L10 -2M0 12L12 0M-2 2L2 -2" {...line} />;
			case "backward":
				return <path d="M-2 0L10 12M0 -2L12 10M8 -2L12 2" {...line} />;
			case "dots":
				return <circle cx="5" cy="5" r="2.2" fill={color} />;
			case "horizontal":
				return <path d="M0 5H10" {...line} />;
			case "vertical":
				return <path d="M5 0V10" {...line} />;
			case "cross":
				return <path d="M0 0L10 10M10 0L0 10" {...line} stroke-width={1.8} />;
			case "grid":
				return <path d="M0 5H10M5 0V10" {...line} stroke-width={1.8} />;
			default:
				return <rect width="10" height="10" fill={color} />;
		}
	};
	return (
		<defs>
			<For each={props.colors}>
				{(color, i) => (
					<pattern
						id={`${props.id}-${i()}`}
						width="10"
						height="10"
						patternUnits="userSpaceOnUse"
						// Coarse enough to survive an ePaper panel's own dithering.
						patternTransform="scale(1.5)"
					>
						{tile(PATTERNS[i() % PATTERNS.length] ?? "solid", color)}
					</pattern>
				)}
			</For>
		</defs>
	);
}

export function Chart(props: RendererProps<El<"chart">, ChartData>) {
	const env = useDisplay();
	let plot: HTMLDivElement | undefined;
	// Drawn in real stage pixels, so text keeps its shape whatever the size of the element.
	const [box, setBox] = createSignal({ w: 0, h: 0, font: 20 });
	const measure = () => {
		if (!plot) return;
		setBox({
			w: plot.clientWidth,
			h: plot.clientHeight,
			font: Number.parseFloat(getComputedStyle(plot).fontSize) || 20,
		});
	};
	onMount(() => {
		const observer = new ResizeObserver(measure);
		if (plot) observer.observe(plot);
		onCleanup(() => observer.disconnect());
	});
	createEffect(
		on([() => props.el.size, () => props.el.kind, () => props.data()], () => queueMicrotask(measure), { defer: true }),
	);

	const round = () => props.el.kind === "pie" || props.el.kind === "donut";
	const low = () => env.lowColor();
	const series = () => props.data()?.series ?? [];
	const labels = () => props.data()?.labels ?? [];
	const palette = createMemo(() => {
		const own = props.el.palette.map((entry) => entry.color).filter(Boolean);
		return (own.length ? own : PALETTE).map((color) => env.ink(color));
	});
	const color = (i: number) => palette()[i % palette().length] ?? "currentColor";
	const patternId = () => `sd-chart-${props.el.id}`;
	/** How a series (or slice) is filled: its colour, or its pattern where colours are few. */
	const fill = (i: number) => (low() ? `url(#${patternId()}-${i % PATTERNS.length})` : color(i));
	const dash = (i: number) => (low() ? DASHES[i % DASHES.length] : undefined);
	const patternColors = createMemo(() => PATTERNS.map((_, i) => color(i)));
	const compact = createMemo(() => {
		const options = { notation: "compact", maximumFractionDigits: 2 } as const;
		return safely(
			() => new Intl.NumberFormat(env.general().locale || undefined, options),
			() => new Intl.NumberFormat(undefined, options),
		);
	});
	const number = (value: number) => compact().format(value);

	// Pies show one series; what does not fit in twelve slices becomes "Other".
	const slices = createMemo(() => {
		const values = series()[0]?.values ?? [];
		const all = labels()
			.map((label, i) => ({ label, value: Math.max(0, values[i] ?? 0) }))
			.filter((slice) => slice.value > 0);
		const kept = all.slice(0, 11);
		const rest = all.slice(11).reduce((sum, slice) => sum + slice.value, 0);
		if (rest > 0) kept.push({ label: "Other", value: rest });
		const total = kept.reduce((sum, slice) => sum + slice.value, 0);
		let turned = 0;
		return kept.map((slice) => {
			const from = turned;
			turned += slice.value / total;
			return { ...slice, share: slice.value / total, from, to: turned };
		});
	});

	const pie = createMemo(() => {
		const { w, h } = box();
		const radius = Math.max(0, Math.min(w, h) / 2 - 4);
		const inner = props.el.kind === "donut" ? radius * 0.58 : 0;
		const point = (turn: number, r: number) => {
			const angle = turn * 2 * Math.PI - Math.PI / 2;
			return `${(w / 2 + Math.cos(angle) * r).toFixed(1)} ${(h / 2 + Math.sin(angle) * r).toFixed(1)}`;
		};
		return slices().map((slice) => {
			// A full circle cannot be drawn as one arc.
			const to = Math.min(slice.to, slice.from + 0.9999);
			const large = to - slice.from > 0.5 ? 1 : 0;
			const outer = `M${point(slice.from, radius)}A${radius} ${radius} 0 ${large} 1 ${point(to, radius)}`;
			const d = inner
				? `${outer}L${point(to, inner)}A${inner} ${inner} 0 ${large} 0 ${point(slice.from, inner)}Z`
				: `${outer}L${w / 2} ${h / 2}Z`;
			const middle = point((slice.from + slice.to) / 2, inner ? (radius + inner) / 2 : radius * 0.66).split(" ");
			return { d, x: middle[0], y: middle[1], share: slice.share };
		});
	});

	const plane = createMemo(() => {
		const { w, h, font } = box();
		const all = series();
		const count = labels().length;
		if (!all.length || !count || w < 40 || h < 40) return null;
		const small = font * 0.62;
		const bars = props.el.kind === "bar";
		const values = all.flatMap((s) => s.values).filter((v): v is number => v !== null);
		if (!values.length) return null;
		const fixedMin = Number.parseFloat(props.el.min);
		const fixedMax = Number.parseFloat(props.el.max);
		// Bars and areas are read from the baseline, so zero belongs on the axis.
		const grounded = bars || props.el.kind === "area";
		let min = Number.isFinite(fixedMin) ? fixedMin : Math.min(...values, ...(grounded ? [0] : []));
		let max = Number.isFinite(fixedMax) ? fixedMax : Math.max(...values, ...(grounded ? [0] : []));
		if (max - min < 1e-9) {
			min -= 1;
			max += 1;
		}
		let ticks = axisTicks(min, max, Math.max(2, Math.floor(h / (small * 3.2))));
		// Without fixed limits the axis starts and ends on a round number.
		const step = (ticks[1] ?? max) - (ticks[0] ?? min);
		if (step > 0) {
			if (!Number.isFinite(fixedMin)) min = Math.floor(min / step + 1e-9) * step;
			if (!Number.isFinite(fixedMax)) max = Math.ceil(max / step - 1e-9) * step;
			ticks = axisTicks(min, max, Math.round((max - min) / step));
		}
		const tickLabels = ticks.map(number);
		const left = Math.max(...tickLabels.map((label) => label.length)) * small * 0.62 + small * 0.6;
		const top = small * (props.el.valueLabels ? 1.6 : 0.7);
		const bottom = small * 1.7;
		const right = small * 0.5;
		const innerW = Math.max(1, w - left - right);
		const innerH = Math.max(1, h - top - bottom);
		const band = innerW / count;
		const x = (i: number) => left + band * (i + 0.5);
		const y = (v: number) => top + innerH - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * innerH;
		const base = y(Math.min(max, Math.max(min, 0)));
		// Labels that would run into each other are thinned out, then shortened.
		const longest = Math.max(...labels().map((label) => Math.min(label.length, 14)));
		const every = Math.max(1, Math.ceil((longest * small * 0.6 + small) / band));
		const lines = all.map((s) => {
			let d = "";
			let area = "";
			let open = false;
			let first = 0;
			let last = 0;
			s.values.forEach((value, i) => {
				if (value === null) {
					if (open) area += `L${x(last).toFixed(1)} ${base.toFixed(1)}L${x(first).toFixed(1)} ${base.toFixed(1)}Z`;
					open = false;
					return;
				}
				const at = `${x(i).toFixed(1)} ${y(value).toFixed(1)}`;
				d += `${open ? "L" : "M"}${at}`;
				area += `${open ? "L" : "M"}${at}`;
				if (!open) first = i;
				last = i;
				open = true;
			});
			if (open) area += `L${x(last).toFixed(1)} ${base.toFixed(1)}L${x(first).toFixed(1)} ${base.toFixed(1)}Z`;
			return { d, area };
		});
		const slot = (band * 0.76) / all.length;
		const rects = bars
			? all.flatMap((s, si) =>
					s.values.flatMap((value, i) => {
						if (value === null) return [];
						const at = y(value);
						return [
							{
								series: si,
								x: left + band * i + band * 0.12 + slot * si + slot * 0.06,
								y: Math.min(at, base),
								w: slot * 0.88,
								h: Math.max(1, Math.abs(base - at)),
								value,
								above: value >= 0,
							},
						];
					}),
				)
			: [];
		const points = bars
			? []
			: all.flatMap((s, si) =>
					s.values.flatMap((value, i) => (value === null ? [] : [{ series: si, x: x(i), y: y(value), value }])),
				);
		return {
			left,
			right: w - right,
			top,
			bottom: top + innerH,
			small,
			band,
			x,
			y,
			base,
			ticks,
			tickLabels,
			every,
			lines,
			rects,
			points,
		};
	});

	const shorten = (label: string) => (label.length > 14 ? `${label.slice(0, 13)}…` : label);
	const legend = () => {
		if (!props.el.legend) return [];
		if (round()) return slices().map((slice) => ({ name: slice.label, note: `${Math.round(slice.share * 100)} %` }));
		return series().length > 1 ? series().map((s) => ({ name: s.name, note: "" })) : [];
	};
	const empty = () => (round() ? slices().length === 0 : series().length === 0 || labels().length === 0);

	return (
		<div class="sd-chart" style={{ "font-size": px(props.el.size) }} data-kind={props.el.kind}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<Show when={empty()}>
				<Placeholder
					text={props.loaded() ? "No numbers to draw: paste CSV or JSON data" : "Loading…"}
					error={props.error()}
				/>
			</Show>
			<div class="sd-chart-body" classList={{ "sd-chart-empty": empty() }}>
				<div class="sd-chart-plot" ref={plot}>
					<svg
						viewBox={`0 0 ${Math.max(1, box().w)} ${Math.max(1, box().h)}`}
						width={box().w}
						height={box().h}
						role="img"
						aria-label={props.el.title || "Chart"}
					>
						<Show when={low()}>
							<PatternDefs id={patternId()} colors={patternColors()} />
						</Show>
						<Show
							when={round()}
							fallback={
								<Show when={plane()}>
									{(p) => (
										<>
											<g class="sd-chart-axis" font-size={p().small}>
												<For each={p().ticks}>
													{(tick, i) => (
														<>
															<line
																x1={p().left}
																x2={p().right}
																y1={p().y(tick)}
																y2={p().y(tick)}
																class="sd-chart-grid"
															/>
															<text
																x={p().left - p().small * 0.4}
																y={p().y(tick)}
																text-anchor="end"
																dominant-baseline="middle"
															>
																{p().tickLabels[i()]}
															</text>
														</>
													)}
												</For>
												<For each={labels()}>
													{(label, i) => (
														<Show when={i() % p().every === 0}>
															<text x={p().x(i())} y={p().bottom + p().small * 1.25} text-anchor="middle">
																{shorten(label)}
															</text>
														</Show>
													)}
												</For>
												<line x1={p().left} x2={p().right} y1={p().base} y2={p().base} class="sd-chart-base" />
											</g>
											<For each={p().rects}>
												{(rect) => (
													<rect
														x={rect.x}
														y={rect.y}
														width={rect.w}
														height={rect.h}
														fill={fill(rect.series)}
														stroke={low() ? color(rect.series) : "none"}
														stroke-width="2"
													/>
												)}
											</For>
											<For each={p().lines}>
												{(line, i) => (
													<>
														<Show when={props.el.kind === "area"}>
															<path d={line.area} fill={fill(i())} opacity={low() ? 1 : 0.22} />
														</Show>
														<Show when={props.el.kind !== "bar"}>
															<path
																d={line.d}
																fill="none"
																stroke={color(i())}
																stroke-width={Math.max(2.5, p().small * 0.16)}
																stroke-dasharray={dash(i())}
																stroke-linejoin="round"
																stroke-linecap="round"
															/>
														</Show>
													</>
												)}
											</For>
											<Show when={props.el.kind === "line" && p().band > p().small * 1.2}>
												<For each={p().points}>
													{(point) => (
														<circle
															cx={point.x}
															cy={point.y}
															r={Math.max(3, p().small * 0.2)}
															fill={color(point.series)}
														/>
													)}
												</For>
											</Show>
											<Show when={props.el.valueLabels}>
												<g class="sd-chart-values" font-size={p().small * 0.9} text-anchor="middle">
													<For each={p().rects}>
														{(rect) => (
															<text
																x={rect.x + rect.w / 2}
																y={rect.above ? rect.y - p().small * 0.35 : rect.y + rect.h + p().small}
															>
																{number(rect.value)}
															</text>
														)}
													</For>
													<For each={p().points}>
														{(point) => (
															<text x={point.x} y={point.y - p().small * 0.6}>
																{number(point.value)}
															</text>
														)}
													</For>
												</g>
											</Show>
										</>
									)}
								</Show>
							}
						>
							<For each={pie()}>
								{(slice, i) => (
									<>
										<path d={slice.d} fill={fill(i())} stroke={low() ? color(i()) : "none"} stroke-width="2" />
										{/* On patterns a number would be unreadable; the legend has the shares. */}
										<Show when={props.el.valueLabels && !low() && slice.share >= 0.05}>
											<text
												class="sd-chart-share"
												x={slice.x}
												y={slice.y}
												font-size={String(box().font * 0.62)}
												text-anchor="middle"
												dominant-baseline="middle"
											>
												{Math.round(slice.share * 100)} %
											</text>
										</Show>
									</>
								)}
							</For>
						</Show>
					</svg>
				</div>
				<Show when={legend().length}>
					<div class="sd-chart-legend">
						<For each={legend()}>
							{(entry, i) => (
								<span class="sd-chart-key">
									<svg viewBox="0 0 30 20" class="sd-chart-swatch" aria-hidden="true">
										<Show
											when={props.el.kind === "line"}
											fallback={
												<rect
													x="1"
													y="1"
													width="28"
													height="18"
													fill={fill(i())}
													stroke={low() ? color(i()) : "none"}
													stroke-width="2"
												/>
											}
										>
											<line
												x1="0"
												x2="30"
												y1="10"
												y2="10"
												stroke={color(i())}
												stroke-width="4"
												stroke-dasharray={dash(i())}
											/>
										</Show>
									</svg>
									<span class="sd-chart-name">{entry.name}</span>
									<Show when={entry.note}>
										<span class="sd-chart-note">{entry.note}</span>
									</Show>
								</span>
							)}
						</For>
					</div>
				</Show>
			</div>
		</div>
	);
}
