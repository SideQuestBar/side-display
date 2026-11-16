import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { contrastOn } from "../../../shared/color";
import type { El } from "../../../shared/elements";
import type { AnyEl } from "../../../shared/types";
import { type Slide, SlideProvider, useDisplay } from "../context";
import { ElementBox, elementGrows, Placeholder, type RendererProps } from "../ElementBox";

const JUSTIFY = { top: "flex-start", center: "center", bottom: "flex-end", spread: "space-between" } as const;

/** `"2:1"` → [2, 1]; anything missing counts as 1. */
function ratios(widths: string, count: number): number[] {
	const parts = widths.split(/[:,\s/]+/).map(Number);
	return Array.from({ length: count }, (_, i) => (parts[i] && parts[i]! > 0 ? parts[i]! : 1));
}

export function Columns(props: RendererProps<El<"columns">>) {
	const env = useDisplay();
	const gap = () => `${props.el.gap >= 0 ? props.el.gap : env.settings().spacing}px`;
	const widths = () => ratios(props.el.widths, props.el.columns.length);
	/** The background of a column, when it was given one: a colour, or the layout's panel. */
	const backdrop = (index: number): { panel: boolean; style: JSX.CSSProperties } => {
		const row = props.el.backgrounds[index];
		if (!row) return { panel: false, style: {} };
		const style: JSX.CSSProperties = { padding: `${props.el.columnPadding}px`, "border-radius": "var(--sd-radius)" };
		if (!row.color) return { panel: true, style };
		const fill = env.ink(row.color);
		style.background = fill;
		if (env.lowColor()) {
			// On ePaper the fill became a solid ink: keep what is on it readable.
			const text = contrastOn(fill);
			Object.assign(style, {
				color: text,
				"--sd-fg": text,
				"--sd-muted": text,
				"--sd-line": text,
				"--sd-accent": text,
			});
		}
		return { panel: false, style };
	};
	return (
		<div
			class="sd-columns"
			classList={{ "sd-columns-dividers": props.el.dividers, "sd-columns-stack": props.el.stack === "portrait" }}
			style={{ gap: gap(), "--sd-column-gap": gap() }}
		>
			<For each={props.el.columns}>
				{(column, i) => (
					<div
						class="sd-column"
						classList={{ "sd-box-panel": backdrop(i()).panel }}
						data-column={i()}
						style={{
							flex: `${widths()[i()]} 1 0`,
							gap: gap(),
							"justify-content": JUSTIFY[props.el.valign],
							...backdrop(i()).style,
						}}
					>
						<For each={column as AnyEl[]}>
							{(child) => (
								<ElementBox
									el={child}
									grow={elementGrows(child)}
									selected={props.selectedId === child.id}
									selectedId={props.selectedId}
									onPointerDown={props.onPointerDown}
								/>
							)}
						</For>
					</div>
				)}
			</For>
		</div>
	);
}

export function Grid(props: RendererProps<El<"grid">>) {
	const env = useDisplay();
	const equal = () => props.el.rows === "equal";
	return (
		<div
			class="sd-grid"
			style={{
				"grid-template-columns": `repeat(${Math.max(1, Math.round(props.el.cols))}, minmax(0, 1fr))`,
				"grid-auto-rows": equal() ? "minmax(0, 1fr)" : "auto",
				"grid-auto-flow": props.el.dense ? "row dense" : "row",
				gap: `${props.el.gap >= 0 ? props.el.gap : env.settings().spacing}px`,
			}}
		>
			<For each={props.el.cells} fallback={<Placeholder text="Add elements to the grid" />}>
				{(child) => (
					<ElementBox
						el={child}
						// In equal rows a cell is a box to fill; otherwise the content decides.
						grow={equal() ? child.grow !== "no" : elementGrows(child)}
						selected={props.selectedId === child.id}
						selectedId={props.selectedId}
						onPointerDown={props.onPointerDown}
					/>
				)}
			</For>
		</div>
	);
}

/**
 * Which children of a container are hidden right now by their own schedule or
 * condition, as reported by their `ElementBox`.
 */
function useHidden() {
	const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
	const report = (id: string) => {
		const set = (visible: boolean) =>
			setHidden((now) => {
				if (now.has(id) !== visible) return now;
				const next = new Set(now);
				if (visible) next.delete(id);
				else next.add(id);
				return next;
			});
		// A removed element must not linger in the set.
		onCleanup(() => set(true));
		return set;
	};
	return { hidden, report };
}

/** Shows the first of its elements that is visible by its own conditions. */
export function SwitchElement(props: RendererProps<El<"switch">>) {
	const { hidden, report } = useHidden();
	// Editor: the element being edited is shown whatever its conditions say.
	const picked = () => props.el.cases.find((child) => child.id === props.selectedId);
	const shown = createMemo(() => picked() ?? props.el.cases.find((child) => !hidden().has(child.id)));
	return (
		<div class="sd-switch" classList={{ "sd-entered": Boolean(picked()) }} data-change={props.el.transition}>
			<For each={props.el.cases} fallback={<Placeholder text="Add the elements to choose from" />}>
				{(child) => (
					<div class="sd-switch-case" classList={{ "sd-switch-on": shown() === child }}>
						<ElementBox
							el={child}
							grow={elementGrows(child)}
							selected={props.selectedId === child.id}
							onPointerDown={props.onPointerDown}
							onVisible={report(child.id)}
						/>
					</div>
				)}
			</For>
		</div>
	);
}

const isYoutube = (src: unknown) => typeof src === "string" && /youtu\.?be/i.test(src);

/**
 * Shows its elements one at a time. They all stay mounted, stacked, so a map
 * or live data is ready when its turn comes; `useSlide()` tells each of them
 * whether it is the one on screen.
 */
export function Carousel(props: RendererProps<El<"carousel">>) {
	const env = useDisplay();
	const { hidden, report } = useHidden();
	const [turn, setTurn] = createSignal<string>();

	// Elements hidden by their own schedule or condition are skipped.
	const rotation = createMemo(() => {
		const list = props.el.elements.filter((child) => !hidden().has(child.id));
		if (!props.el.shuffle) return list;
		for (let i = list.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[list[i], list[j]] = [list[j]!, list[i]!];
		}
		return list;
	});
	// Editor: the element being edited stays up for as long as it is selected.
	const picked = () => props.el.elements.find((child) => child.id === props.selectedId);
	const active = createMemo(() => picked() ?? rotation().find((child) => child.id === turn()) ?? rotation()[0]);
	const seconds = (child: AnyEl) => Math.max(2, child.slideSeconds > 0 ? child.slideSeconds : props.el.interval);
	/** A video that is played to its end rather than for a set time. An embedded player cannot tell us when it ends. */
	const waits = (child: AnyEl) =>
		props.el.waitVideo &&
		child.type === "video" &&
		Boolean(child.src) &&
		!isYoutube(child.src) &&
		!env.lowColor() &&
		rotation().length > 1;
	const advance = (from: AnyEl) => {
		const list = rotation();
		const next = list[(list.indexOf(from) + 1) % list.length];
		if (next) setTurn(next.id);
	};

	createEffect(() => {
		const current = active();
		if (!current) return;
		if (picked()) {
			// Deselecting carries on from here.
			setTurn(current.id);
			return;
		}
		if (rotation().length < 2 || waits(current)) return;
		const timer = setTimeout(() => advance(current), seconds(current) * 1000);
		onCleanup(() => clearTimeout(timer));
	});

	/** How long the progress indicator runs for the element on screen; none while a video decides. */
	const run = (child: AnyEl) => (picked() || waits(child) || env.lowColor() ? undefined : `${seconds(child)}s`);

	return (
		<div
			class="sd-carousel"
			classList={{ "sd-entered": Boolean(picked()) }}
			data-change={env.lowColor() ? "none" : props.el.transition}
		>
			<For each={props.el.elements} fallback={<Placeholder text="Add the elements to rotate through" />}>
				{(child) => {
					const on = () => active() === child;
					const slide: Slide = {
						active: on,
						waits: () => waits(child),
						ended: () => {
							if (on() && !picked() && waits(child)) advance(child);
						},
					};
					return (
						<div class="sd-carousel-slide" classList={{ "sd-carousel-on": on() }}>
							<SlideProvider value={slide}>
								<ElementBox
									el={child}
									// A slide fills the carousel unless it was told to fit its content.
									grow={child.grow !== "no" && child.height <= 0}
									selected={props.selectedId === child.id}
									onPointerDown={props.onPointerDown}
									onVisible={report(child.id)}
								/>
							</SlideProvider>
						</div>
					);
				}}
			</For>
			<Show when={rotation().length > 1 && props.el.indicator === "dots"}>
				<div class="sd-carousel-progress sd-dots">
					<For each={rotation()}>
						{(child, i) => (
							<div
								class="sd-dot"
								data-state={child === active() ? "active" : i() < rotation().indexOf(active()!) ? "done" : "todo"}
							>
								{/* Keyed, so the fill restarts with every turn. */}
								<Show when={child === active() && run(child)} keyed>
									{(duration) => <div class="sd-dot-fill" style={{ "animation-duration": duration }} />}
								</Show>
							</div>
						)}
					</For>
				</div>
			</Show>
			<Show when={rotation().length > 1 && props.el.indicator === "bar" && active()} keyed>
				{(child) => (
					<Show when={run(child)} keyed>
						{(duration) => (
							<div class="sd-carousel-progress sd-carousel-bar">
								<div class="sd-dot-fill" style={{ "animation-duration": duration }} />
							</div>
						)}
					</Show>
				)}
			</Show>
		</div>
	);
}

export const Spacer = () => <div class="sd-spacer" />;

export function Divider(props: RendererProps<El<"divider">>) {
	const env = useDisplay();
	return (
		<div class="sd-divider">
			<div
				style={{
					width: `${props.el.width}%`,
					"border-top": `${props.el.thickness}px ${props.el.style} ${env.ink(props.el.color) || "var(--sd-line)"}`,
				}}
			/>
		</div>
	);
}
