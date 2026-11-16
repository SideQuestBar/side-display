import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { EntitiesData, EntityData, EntityStats, GraphData, TemplateData, TodoData } from "../../../shared/data";
import type { Align, El } from "../../../shared/elements";
import type { AnyEl, HaEntityState } from "../../../shared/types";
import { px, useDisplay, useMinute, useNow } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";
import { Picture } from "../Picture";
import { Markdown } from "./content";

/** `"on=Open, off=Closed"` → { on: "Open", off: "Closed" }. */
function parseStateMap(text: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const pair of text.split(",")) {
		const [from, ...to] = pair.split("=");
		if (from?.trim() && to.length) map[from.trim().toLowerCase()] = to.join("=").trim();
	}
	return map;
}

/** How a state is written on screen: renamed, rounded, or tidied up. */
export function formatState(
	state: HaEntityState,
	options: { precision?: number; stateMap?: string; locale: string },
): string {
	const renamed = parseStateMap(options.stateMap ?? "")[state.state.toLowerCase()];
	if (renamed !== undefined) return renamed;
	const number = Number(state.state);
	if (state.state.trim() !== "" && Number.isFinite(number)) {
		const precision = options.precision ?? -1;
		return new Intl.NumberFormat(
			options.locale || undefined,
			precision >= 0
				? { minimumFractionDigits: precision, maximumFractionDigits: precision }
				: { maximumFractionDigits: 2 },
		).format(number);
	}
	if (state.state === "unavailable" || state.state === "unknown") return "–";
	// Timestamps (device_class timestamp) read better as a time.
	if (state.device_class === "timestamp" && !Number.isNaN(Date.parse(state.state))) {
		return new Intl.DateTimeFormat(options.locale || undefined, { dateStyle: "medium", timeStyle: "short" }).format(
			new Date(state.state),
		);
	}
	return state.state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const missing = (entity: string, error?: string) => (
	<Placeholder text={entity ? `Waiting for ${entity}…` : "Choose an entity"} error={error} />
);

function ago(from: number, now: number, locale: string): string {
	// `now` only moves once a minute, so a fresh change can be ahead of it: never "in 1 minute".
	const minutes = Math.min(0, Math.round((from - now) / 60_000));
	const format = new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" });
	if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
	if (Math.abs(minutes) < 60 * 24) return format.format(Math.round(minutes / 60), "hour");
	return format.format(Math.round(minutes / 60 / 24), "day");
}

/** The state as a number; NaN for text (and for an empty state, which `Number` would call 0). */
export const numeric = (state: HaEntityState | null | undefined) =>
	state && state.state.trim() !== "" ? Number(state.state) : Number.NaN;

export interface Threshold {
	from: number;
	color: string;
}

/** The colour of the highest threshold a value has reached, as an ink of this screen; "" when none applies. */
export function thresholdColor(
	thresholds: Threshold[] | undefined,
	value: number,
	ink: (color: string) => string,
): string {
	if (!thresholds?.length || !Number.isFinite(value)) return "";
	const reached = [...thresholds].sort((a, b) => a.from - b.from).filter((t) => value >= t.from);
	return ink(reached.at(-1)?.color ?? "");
}

/** A warning triangle drawn as a shape: emoji would lose their meaning on a black-and-white panel. */
export function WarningMark() {
	return (
		<svg class="sd-mark" viewBox="0 0 24 24" aria-hidden="true">
			<path d="M12 3 22.5 21h-21Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" />
			<path d="M12 9.5v5.5M12 17.6v.4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
		</svg>
	);
}

/**
 * Minutes since the value last arrived, once that is longer than allowed;
 * null while it is fresh. MQTT states say when the last message came in, even
 * when it repeated the previous value.
 */
function staleFor(state: HaEntityState, limit: number | undefined, now: number): number | null {
	if (!limit || limit <= 0) return null;
	const at = Date.parse(String(state.attributes.received ?? state.last_changed));
	if (Number.isNaN(at)) return null;
	const minutes = Math.floor((now - at) / 60_000);
	return minutes >= limit ? minutes : null;
}
const duration = (minutes: number) =>
	minutes < 120
		? `${minutes} min`
		: minutes < 2880
			? `${Math.round(minutes / 60)} h`
			: `${Math.round(minutes / 1440)} d`;

/** An arrow saying where a value went since `past`; nothing without a past to compare with. */
function Trend(props: { value: number; past: number | null | undefined }) {
	const direction = () => {
		const past = props.past;
		if (past === null || past === undefined || !Number.isFinite(props.value)) return null;
		const change = props.value - past;
		// Sensor jitter is not a trend.
		if (Math.abs(change) <= Math.max(Math.abs(past), Math.abs(props.value)) * 0.002) return "flat";
		return change > 0 ? "up" : "down";
	};
	return (
		<Show when={direction()}>
			{(d) => (
				<span class="sd-trend" data-trend={d()}>
					{d() === "up" ? "↑" : d() === "down" ? "↓" : "→"}
				</span>
			)}
		</Show>
	);
}

/** The lowest and highest value of the day. */
function DayRange(props: { stats: EntityStats | undefined; unit: string; precision?: number }) {
	const env = useDisplay();
	const text = (value: number) => {
		const precision = props.precision ?? -1;
		return new Intl.NumberFormat(
			env.general().locale || undefined,
			precision >= 0
				? { minimumFractionDigits: precision, maximumFractionDigits: precision }
				: { maximumFractionDigits: 1 },
		).format(value);
	};
	return (
		<Show when={props.stats && props.stats.min !== null && props.stats.max !== null ? props.stats : null}>
			{(stats) => (
				<div class="sd-range">
					<span>
						▼ {text(stats().min ?? 0)}
						{props.unit}
					</span>
					<span>
						▲ {text(stats().max ?? 0)}
						{props.unit}
					</span>
				</div>
			)}
		</Show>
	);
}

/** The look of one value; shared by the MQTT elements, whose data has the same shape. */
export interface ValueStyle {
	label: string;
	icon: string;
	size: number;
	align: Align;
	unit: string;
	precision: number;
	stateMap: string;
	changed: boolean;
	/** Colours the value by its level. */
	thresholds?: Threshold[];
	/** Minutes back the trend arrow compares with; needs `stats`. */
	trend?: number;
	dayRange?: boolean;
	/** Minutes without news after which the value is marked as out of date. */
	staleMinutes?: number;
}

export function EntityValue(props: { state: HaEntityState; el: ValueStyle; stats?: EntityStats }) {
	const env = useDisplay();
	const minute = useMinute();
	const now = useNow();
	const stale = createMemo(() => staleFor(props.state, props.el.staleMinutes, now()));
	return (
		<div
			class="sd-entity"
			classList={{ "sd-stale": stale() !== null }}
			style={{ "font-size": px(props.el.size), "text-align": props.el.align }}
		>
			<div class="sd-entity-label">
				{props.el.icon} {props.el.label || props.state.name}
			</div>
			<div
				class="sd-entity-value"
				style={{ color: thresholdColor(props.el.thresholds, numeric(props.state), env.ink) || undefined }}
			>
				{formatState(props.state, {
					precision: props.el.precision,
					stateMap: props.el.stateMap,
					locale: env.general().locale,
				})}
				<Show when={props.el.unit || props.state.unit}>
					<span class="sd-entity-unit">{props.el.unit || props.state.unit}</span>
				</Show>
				<Show when={props.el.trend}>
					<Trend value={numeric(props.state)} past={props.stats?.past} />
				</Show>
			</div>
			<Show when={props.el.dayRange}>
				<DayRange stats={props.stats} unit={props.el.unit || props.state.unit} precision={props.el.precision} />
			</Show>
			<Show when={stale()}>
				{(minutes) => (
					<div class="sd-stale-note">
						<WarningMark /> no data for {duration(minutes())}
					</div>
				)}
			</Show>
			<Show when={props.el.changed}>
				<div class="sd-entity-changed">{ago(Date.parse(props.state.last_changed), minute(), env.general().locale)}</div>
			</Show>
		</div>
	);
}

export function HaEntity(props: RendererProps<El<"ha-entity">, EntityData>) {
	return (
		<Show when={props.data()?.state} fallback={missing(props.el.entity, props.error())}>
			{(state) => <EntityValue state={state()} el={props.el} stats={props.data()?.stats} />}
		</Show>
	);
}

/** Several values as rows or tiles; `rows` are the ones that have a value. */
export function EntityRows(props: {
	el: {
		title: string;
		size: number;
		variant: string;
		columns: number;
		stateMap: string;
		thresholds?: Threshold[];
		staleMinutes?: number;
	};
	rows: { label: string; state: HaEntityState }[];
	/** What the editor shows while there is nothing to list. */
	empty: string;
	error?: string;
}) {
	const env = useDisplay();
	const now = useNow();
	return (
		<div class="sd-entities" style={{ "font-size": px(props.el.size) }} data-variant={props.el.variant}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<div
				class="sd-entities-list"
				style={{
					"grid-template-columns":
						props.el.variant === "tiles" ? `repeat(${Math.max(1, props.el.columns)}, minmax(0, 1fr))` : undefined,
				}}
			>
				<For each={props.rows} fallback={<Placeholder text={props.empty} error={props.error} />}>
					{(row) => {
						const stale = createMemo(() => staleFor(row.state, props.el.staleMinutes, now()));
						return (
							<div class="sd-entities-row" classList={{ "sd-stale": stale() !== null }}>
								<span class="sd-entities-label">{row.label}</span>
								<span class="sd-entities-value">
									<Show when={stale()}>
										{(minutes) => (
											<span class="sd-stale-note">
												<WarningMark /> {duration(minutes())}
											</span>
										)}
									</Show>
									<span
										class="sd-entities-number"
										style={{ color: thresholdColor(props.el.thresholds, numeric(row.state), env.ink) || undefined }}
									>
										{formatState(row.state, { stateMap: props.el.stateMap, locale: env.general().locale })}
										<Show when={row.state.unit}>
											<span class="sd-entity-unit">{row.state.unit}</span>
										</Show>
									</span>
								</span>
							</div>
						);
					}}
				</For>
			</div>
		</div>
	);
}

export function HaEntities(props: RendererProps<El<"ha-entities">, EntitiesData>) {
	const rows = createMemo(() =>
		props.el.entities.flatMap((row, i) => {
			const state = props.data()?.states[i];
			return state ? [{ label: row.label || state.name, state }] : [];
		}),
	);
	return (
		<EntityRows
			el={props.el}
			rows={rows()}
			empty={props.el.entities.length ? "Waiting for Home Assistant…" : "Add an entity"}
			error={props.error()}
		/>
	);
}

/** A point of the gauge dial: `f` of the way along its 240° arc, `r` from the centre (viewBox units). */
export function dialPoint(f: number, r: number): [number, number] {
	const angle = ((150 + 240 * f) * Math.PI) / 180;
	return [50 + r * Math.cos(angle), 50 + r * Math.sin(angle)];
}
export const spoke = (f: number, from: number, to: number) => {
	const [x1, y1] = dialPoint(f, from);
	const [x2, y2] = dialPoint(f, to);
	return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
};
/** A 240° arc of radius 40: its length is what the dash arrays of the dials are measured against. */
export const DIAL_ARC = (240 / 360) * 2 * Math.PI * 40;

export function HaGauge(props: RendererProps<El<"ha-gauge">, EntityData>) {
	const env = useDisplay();
	const value = () => numeric(props.data()?.state);
	const along = (v: number) => {
		const span = props.el.max - props.el.min;
		return span > 0 && Number.isFinite(v) ? Math.min(1, Math.max(0, (v - props.el.min) / span)) : 0;
	};
	const fraction = () => along(value());
	const color = () => thresholdColor(props.el.thresholds, value(), env.ink) || "var(--sd-accent)";
	/** Where the target sits on the scale; null without one, or when it is off the scale. */
	const target = () => {
		const t = Number.parseFloat(props.el.target);
		return Number.isFinite(t) && t >= props.el.min && t <= props.el.max ? along(t) : null;
	};
	const reading = (state: HaEntityState) => (
		<>
			{formatState(state, { precision: props.el.precision, locale: env.general().locale })}
			<span class="sd-entity-unit">{state.unit}</span>
			<Show when={props.el.trend}>
				<Trend value={value()} past={props.data()?.stats?.past} />
			</Show>
		</>
	);
	const range = (state: HaEntityState) => (
		<Show when={props.el.dayRange}>
			<DayRange stats={props.data()?.stats} unit={state.unit} precision={props.el.precision} />
		</Show>
	);
	return (
		<Show when={props.data()?.state} fallback={missing(props.el.entity, props.error())}>
			{(state) => (
				<div class="sd-gauge" style={{ "font-size": px(props.el.size) }} data-style={props.el.style}>
					<Show
						when={props.el.style === "arc"}
						fallback={
							<>
								<div class="sd-gauge-head">
									<span>{props.el.label || state().name}</span>
									<span class="sd-gauge-value">{reading(state())}</span>
								</div>
								<div class="sd-gauge-track">
									<div class="sd-gauge-bar">
										<div
											style={{
												width: `${props.el.needle === "fill" ? fraction() * 100 : 0}%`,
												background: color(),
											}}
										/>
									</div>
									<Show when={props.el.needle !== "fill"}>
										<span
											class="sd-gauge-marker"
											data-kind={props.el.needle}
											style={{ left: `${fraction() * 100}%`, background: color() }}
										/>
									</Show>
									<Show when={target() !== null}>
										<span class="sd-gauge-tick" style={{ left: `${(target() ?? 0) * 100}%` }} />
									</Show>
								</div>
								{range(state())}
							</>
						}
					>
						<div class="sd-gauge-dial">
							<svg viewBox="0 0 100 78" role="img" aria-label="Gauge">
								<g transform="rotate(150 50 50)" fill="none" stroke-width="9" stroke-linecap="round">
									<circle
										class="sd-dial-track"
										cx="50"
										cy="50"
										r="40"
										stroke="var(--sd-line)"
										stroke-dasharray={`${DIAL_ARC} 400`}
									/>
									<Show when={props.el.needle === "fill"}>
										<circle cx="50" cy="50" r="40" stroke={color()} stroke-dasharray={`${DIAL_ARC * fraction()} 400`} />
									</Show>
								</g>
								<Show when={target() !== null}>
									<path d={spoke(target() ?? 0, 33, 47)} stroke="var(--sd-fg)" stroke-width="2.5" />
								</Show>
								<Show when={props.el.needle === "needle"}>
									<path d={spoke(fraction(), 27, 47)} stroke={color()} stroke-width="4.5" stroke-linecap="round" />
								</Show>
								<Show when={props.el.needle === "dot"}>
									<circle
										cx={dialPoint(fraction(), 40)[0]}
										cy={dialPoint(fraction(), 40)[1]}
										r="6.5"
										fill={color()}
										stroke="var(--sd-fg)"
										stroke-width="1.5"
									/>
								</Show>
							</svg>
							<div class="sd-gauge-reading">
								<div class="sd-gauge-value">{reading(state())}</div>
							</div>
						</div>
						<div class="sd-gauge-label">{props.el.label || state().name}</div>
						{range(state())}
					</Show>
				</div>
			)}
		</Show>
	);
}

type Point = [number, number];
/** Colours for the extra lines of a graph that were given none. */
const SERIES_COLORS = ["#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#12a594", "#e93d82", "#3e63dd", "#978365"];
/** Where colours cannot tell lines apart (ePaper), their strokes do. */
const DASHES = ["", "10 6", "2 6", "14 5 2 5"];

/** The mean of each clock hour that has values, as `[start of the hour, mean]`. */
export function hourly(points: Point[]): Point[] {
	const HOUR = 3_600_000;
	const buckets = new Map<number, { sum: number; count: number }>();
	for (const [at, value] of points) {
		const hour = Math.floor(at / HOUR) * HOUR;
		const bucket = buckets.get(hour) ?? { sum: 0, count: 0 };
		bucket.sum += value;
		bucket.count++;
		buckets.set(hour, bucket);
	}
	return [...buckets].sort(([a], [b]) => a - b).map(([hour, b]) => [hour, b.sum / b.count]);
}

export function HaGraph(props: RendererProps<El<"ha-graph">, GraphData>) {
	const env = useDisplay();
	const WIDTH = 1000;
	const HEIGHT = 300;
	const HOUR = 3_600_000;
	const series = createMemo(() => {
		const data = props.data();
		const low = env.lowColor();
		const all = [
			{
				label: props.el.label || data?.state?.name || props.el.entity,
				color: env.ink(props.el.color) || "var(--sd-accent)",
				points: data?.points ?? [],
			},
			...(data?.series ?? []).map((s, i) => ({
				label: s.label,
				color: env.ink(s.color || SERIES_COLORS[i % SERIES_COLORS.length]!),
				points: s.points,
			})),
		];
		return all
			.map((s, i) => ({ ...s, dash: low ? DASHES[i % DASHES.length]! : "" }))
			.filter((s) => s.points.length >= 2);
	});
	const several = () => (props.data()?.series?.length ?? 0) > 0;
	const plot = createMemo(() => {
		const all = series();
		if (!all.length) return null;
		const end = Date.now();
		const start = end - props.el.hours * HOUR;
		const bars = props.el.graphType === "bars";
		const drawn = all.map((s) => ({ ...s, points: bars ? hourly(s.points.filter(([t]) => t >= start)) : s.points }));
		const values = drawn.flatMap((s) => s.points.map((p) => p[1]));
		if (!values.length) return null;
		const target = Number.parseFloat(props.el.target);
		// The target is part of the picture: keep it on the scale.
		if (Number.isFinite(target)) values.push(target);
		// Bars measure from zero unless the axis says otherwise.
		if (bars) values.push(0);
		const fixedMin = Number.parseFloat(props.el.min);
		const fixedMax = Number.parseFloat(props.el.max);
		let min = Number.isFinite(fixedMin) ? fixedMin : Math.min(...values);
		let max = Number.isFinite(fixedMax) ? fixedMax : Math.max(...values);
		if (max - min < 1e-9) {
			min -= 1;
			max += 1;
		}
		const x = (t: number) => ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * WIDTH;
		const y = (v: number) => HEIGHT - 8 - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * (HEIGHT - 16);
		const fixed = (n: number) => n.toFixed(1);
		const shapes = drawn.map((s, index) => {
			if (bars) {
				const rects = s.points.map(([hour, value]) => {
					const left = x(hour);
					const slot = (x(hour + HOUR) - left) / drawn.length;
					const top = Math.min(y(value), y(0));
					return {
						x: left + slot * index + slot * 0.1,
						y: top,
						width: Math.max(0.5, slot * 0.8),
						height: Math.max(1, Math.abs(y(value) - y(0))),
					};
				});
				return { ...s, rects, line: "", area: "" };
			}
			// States hold until the next change, so extend the last one to "now".
			const path = [...s.points, [end, s.points.at(-1)![1]] as Point];
			const line =
				props.el.graphType === "step"
					? path.map(([t, v], i) => (i ? `H${fixed(x(t))}V${fixed(y(v))}` : `M${fixed(x(t))} ${fixed(y(v))}`)).join("")
					: path.map(([t, v], i) => `${i ? "L" : "M"}${fixed(x(t))} ${fixed(y(v))}`).join("");
			return { ...s, rects: [], line, area: `${line}L${WIDTH} ${HEIGHT}L${fixed(x(path[0]![0]))} ${HEIGHT}Z` };
		});
		// The lowest and highest point of the first line, placed in percent so the dots stay round.
		const marks: { left: number; top: number; value: number; high: boolean }[] = [];
		const first = drawn[0]!.points.filter(([t]) => t >= start);
		if (props.el.extremes && first.length) {
			const at = (p: Point, high: boolean) => ({
				left: (x(bars ? p[0] + HOUR / 2 : p[0]) / WIDTH) * 100,
				top: (y(p[1]) / HEIGHT) * 100,
				value: p[1],
				high,
			});
			marks.push(
				at(
					first.reduce((a, b) => (b[1] > a[1] ? b : a)),
					true,
				),
			);
			marks.push(
				at(
					first.reduce((a, b) => (b[1] < a[1] ? b : a)),
					false,
				),
			);
		}
		return {
			shapes,
			min,
			max,
			marks,
			target: Number.isFinite(target) ? (y(target) / HEIGHT) * 100 : null,
			targetY: Number.isFinite(target) ? y(target) : 0,
		};
	});
	const number = (v: number) =>
		new Intl.NumberFormat(env.general().locale || undefined, { maximumFractionDigits: 1 }).format(v);
	return (
		<div class="sd-graph" style={{ "font-size": px(props.el.size) }}>
			<div class="sd-graph-head">
				<span class="sd-graph-label">{props.el.label || props.data()?.state?.name || props.el.entity}</span>
				<Show when={props.el.value && props.data()?.state}>
					{(state) => (
						<span class="sd-graph-value">
							{formatState(state(), { locale: env.general().locale })}
							<span class="sd-entity-unit">{state().unit}</span>
						</span>
					)}
				</Show>
			</div>
			<Show
				when={plot()}
				fallback={<Placeholder text={props.el.entity ? "No history yet" : "Choose an entity"} error={props.error()} />}
			>
				{(p) => (
					<>
						<div class="sd-graph-plot" style={{ height: `${props.el.graphHeight}cqh` }}>
							<svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" role="img" aria-label="History">
								<For each={p().shapes}>
									{(shape, i) => (
										<Show
											when={shape.line}
											fallback={
												<For each={shape.rects}>
													{(r) => (
														<rect
															x={r.x}
															y={r.y}
															width={r.width}
															height={r.height}
															fill={shape.dash ? "none" : shape.color}
															stroke={shape.color}
															stroke-width={shape.dash ? 2 : 0}
															vector-effect="non-scaling-stroke"
														/>
													)}
												</For>
											}
										>
											<Show when={props.el.fill && !env.lowColor() && i() === 0 && p().shapes.length === 1}>
												<path d={shape.area} fill={shape.color} opacity="0.18" />
											</Show>
											<path
												d={shape.line}
												fill="none"
												stroke={shape.color}
												stroke-width="3"
												stroke-linejoin="round"
												stroke-dasharray={shape.dash || undefined}
												vector-effect="non-scaling-stroke"
											/>
										</Show>
									)}
								</For>
								<Show when={p().target !== null}>
									<path
										d={`M0 ${p().targetY.toFixed(1)}H${WIDTH}`}
										fill="none"
										stroke="var(--sd-fg)"
										stroke-width="2"
										stroke-dasharray="6 6"
										vector-effect="non-scaling-stroke"
									/>
								</Show>
							</svg>
							<span class="sd-graph-max">{number(p().max)}</span>
							<span class="sd-graph-min">{number(p().min)}</span>
							<Show when={p().target !== null}>
								<span class="sd-graph-target" style={{ top: `${p().target}%` }}>
									{props.el.targetLabel || number(Number.parseFloat(props.el.target))}
								</span>
							</Show>
							<For each={p().marks}>
								{(mark) => (
									<span
										class="sd-graph-mark"
										classList={{ "sd-graph-mark-high": mark.high, "sd-graph-mark-end": mark.left > 85 }}
										style={{ left: `${mark.left}%`, top: `${mark.top}%` }}
									>
										<span>{number(mark.value)}</span>
									</span>
								)}
							</For>
						</div>
						<Show when={several()}>
							<div class="sd-graph-legend">
								<For each={p().shapes}>
									{(shape) => (
										<span>
											<svg viewBox="0 0 28 6" aria-hidden="true">
												<path
													d="M0 3H28"
													stroke={shape.color}
													stroke-width="4"
													stroke-dasharray={
														shape.dash ? shape.dash.replace(/\d+/g, (n) => String(Number(n) / 2)) : undefined
													}
												/>
											</svg>
											{shape.label}
										</span>
									)}
								</For>
							</div>
						</Show>
					</>
				)}
			</Show>
		</div>
	);
}

/**
 * A Home Assistant picture, refetched on a timer; the previous frame stays until the next has loaded.
 * `entity` picks one picture of an element that has several (the people of a presence element).
 */
export function usePicture(el: () => object, seconds: () => number, key: () => unknown, entity?: () => string) {
	const env = useDisplay();
	const [source, setSource] = createSignal("");
	let stale: string | undefined;
	const load = async () => {
		try {
			const who = entity?.();
			// The editor sends the element whole, so narrowing its list to one entity asks for that
			// picture; a display asks by id and names the entity, which the server checks against the list.
			const target = who ? { ...el(), entities: [{ entity: who }] } : el();
			let next = await env.pictureUrl(target as AnyEl);
			if (who && !next.startsWith("blob:"))
				next += `${next.includes("?") ? "&" : "?"}entity=${encodeURIComponent(who)}`;
			if (stale?.startsWith("blob:")) URL.revokeObjectURL(stale);
			stale = source();
			setSource(next);
		} catch {
			// Keep the last frame.
		}
	};
	createEffect(
		on([key, seconds], () => {
			void load();
			const timer = setInterval(load, Math.max(1, seconds()) * 1000);
			onCleanup(() => clearInterval(timer));
		}),
	);
	return source;
}

export function HaCamera(props: RendererProps<El<"ha-camera">, EntityData>) {
	const source = usePicture(
		() => props.el,
		() => props.el.refresh,
		() => props.el.entity,
	);
	return (
		<div class="sd-camera sd-media-frame">
			<Show
				when={props.el.entity && source()}
				fallback={
					<Placeholder text={props.el.entity ? "Waiting for a snapshot…" : "Choose a camera"} error={props.error()} />
				}
			>
				<Picture src={source()} fit={props.el.fit} />
				<Show when={props.el.label && props.data()?.state}>
					{(state) => <div class="sd-gallery-caption">{state().name}</div>}
				</Show>
			</Show>
		</div>
	);
}

export function HaMedia(props: RendererProps<El<"ha-media">, EntityData>) {
	const env = useDisplay();
	const second = useNow();
	const state = () => props.data()?.state;
	const attributes = () => (state()?.attributes ?? {}) as Record<string, string | number | undefined>;
	const active = () => ["playing", "paused", "buffering"].includes(state()?.state ?? "");
	const art = usePicture(
		() => props.el,
		() => 3600,
		// A new track has a new picture path.
		() => [props.el.entity, attributes().entity_picture],
	);
	const progress = () => {
		const a = attributes();
		const duration = Number(a.media_duration);
		if (!duration || a.media_position === undefined) return null;
		const since =
			state()?.state === "playing" && a.media_position_updated_at
				? (second() - Date.parse(String(a.media_position_updated_at))) / 1000
				: 0;
		return Math.min(1, Math.max(0, (Number(a.media_position) + since) / duration));
	};
	return (
		<Show when={state()} fallback={missing(props.el.entity, props.error())}>
			<Show
				when={active()}
				fallback={
					<Show when={!props.el.hideIdle || env.editing}>
						<div class="sd-empty" style={{ "font-size": px(props.el.size) }}>
							{props.el.idleText}
						</div>
					</Show>
				}
			>
				<div class="sd-media" style={{ "font-size": px(props.el.size) }}>
					<Show when={props.el.art && attributes().entity_picture && art()}>
						<div class="sd-media-art">
							<Picture src={art()} fit="cover" />
						</div>
					</Show>
					<div class="sd-media-text">
						<div class="sd-media-title">{attributes().media_title ?? state()?.name}</div>
						<div class="sd-media-artist">
							{[attributes().media_artist, attributes().media_album_name].filter(Boolean).join(" · ")}
						</div>
						<Show when={props.el.progress && progress() !== null && !env.lowColor()}>
							<div class="sd-media-progress">
								<div style={{ width: `${(progress() ?? 0) * 100}%` }} />
							</div>
						</Show>
					</div>
				</div>
			</Show>
		</Show>
	);
}

export function HaTodo(props: RendererProps<El<"ha-todo">, TodoData>) {
	const items = () =>
		(props.data()?.items ?? []).filter((item) => props.el.completed || !item.done).slice(0, props.el.max);
	return (
		<div class="sd-todo" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<Show when={props.el.entity} fallback={<Placeholder text="Choose a list" />}>
				<For
					each={items()}
					fallback={
						<Show when={props.loaded()} fallback={<Placeholder text="Loading…" error={props.error()} />}>
							<div class="sd-empty">{props.el.emptyText}</div>
						</Show>
					}
				>
					{(item) => (
						<div class="sd-todo-item" classList={{ "sd-todo-done": item.done }}>
							<span class="sd-todo-box" />
							<span>{item.summary}</span>
						</div>
					)}
				</For>
			</Show>
		</div>
	);
}

export function HaTemplate(props: RendererProps<El<"ha-template">, TemplateData>) {
	return (
		<Show when={props.data()?.text} fallback={<Placeholder text="Waiting for Home Assistant…" error={props.error()} />}>
			{(text) => (
				<Markdown
					text={text()}
					class="sd-text"
					style={{ "font-size": px(props.el.size), "text-align": props.el.align, "font-weight": "600" }}
				/>
			)}
		</Show>
	);
}
