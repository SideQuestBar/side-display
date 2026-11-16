/**
 * The wrapper around every element: decides whether it is visible right now,
 * loads its server data, draws its box (panel, padding, colours) and then
 * hands over to the renderer of its type.
 */
import { type Component, createEffect, createMemo, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { contrastOn } from "../../shared/color";
import { definition } from "../../shared/elements";
import { childLists, entitiesOf, needsData } from "../../shared/layout";
import { inSchedule, zoned } from "../../shared/time";
import type { AnyEl } from "../../shared/types";
import { type ElementDataState, useDisplay, useElementData, useMinute } from "./context";
import { renderers } from "./elements";
import { FONTS } from "./fonts";

const SHADOWS = { none: "", soft: "0 8px 30px rgba(0, 0, 0, 0.3)", strong: "0 16px 56px rgba(0, 0, 0, 0.6)" } as const;
const pad = (n: number) => String(n).padStart(2, "0");

export interface RendererProps<E = AnyEl, D = unknown> {
	el: E;
	data: ElementDataState<D>["data"];
	error: ElementDataState<D>["error"];
	loaded: ElementDataState<D>["loaded"];
	/** Editor: id of the selected element, for containers to pass down. */
	selectedId?: string | null;
	onPointerDown?: (el: AnyEl, event: PointerEvent) => void;
}

/** Does a flow element take the leftover height of its column? */
export function elementGrows(el: AnyEl): boolean {
	if (el.grow === "yes") return true;
	if (el.grow === "no" || el.height > 0) return false;
	// Columns and switches are as tall as what they hold.
	if (el.type === "columns" || el.type === "switch") return childLists(el).some((list) => list.some(elementGrows));
	return Boolean(definition(el.type).grows);
}

export function ElementBox(props: {
	el: AnyEl;
	grow?: boolean;
	free?: boolean;
	selected?: boolean;
	selectedId?: string | null;
	onPointerDown?: (el: AnyEl, event: PointerEvent) => void;
	/** Told whether the element is shown right now (schedule, entity condition, colour mode). */
	onVisible?: (visible: boolean) => void;
}) {
	const env = useDisplay();
	const minute = useMinute();
	// Solid tracks property reads, so this element re-renders only when one of
	// its own properties changes.
	const el = () => props.el;
	const state = useElementData(
		el,
		() => entitiesOf(el()),
		() => needsData(el()),
	);

	const scheduled = createMemo(() => {
		const e = el();
		if (!e.showDays.length && !e.showFrom && !e.showTo && !e.showSince && !e.showUntil) return true;
		const now = zoned(minute(), env.general().timezone);
		// Same shape as a `datetime` field, so the two compare as text.
		const stamp = `${now.year}-${pad(now.month)}-${pad(now.day)}T${pad(now.hour)}:${pad(now.minute)}`;
		if (e.showSince && stamp < e.showSince) return false;
		if (e.showUntil && stamp >= e.showUntil) return false;
		return inSchedule(now, e.showDays, e.showFrom, e.showTo);
	});
	const visible = createMemo(() => {
		const e = el();
		if (e.showMode === "color" && env.lowColor()) return false;
		if (e.showMode === "epaper" && !env.lowColor()) return false;
		return scheduled() && state.show();
	});

	createEffect(() => props.onVisible?.(visible()));

	const style = createMemo((): JSX.CSSProperties => {
		const e = el();
		const low = env.lowColor();
		const css: JSX.CSSProperties = {};
		if (props.free) {
			css.left = `${e.x}%`;
			css.top = `${e.y}%`;
			css.width = `${e.w}%`;
			css.height = `${e.h}%`;
			if (e.rotate) css.transform = `rotate(${e.rotate}deg)`;
			if (e.layer) css["z-index"] = String(e.layer);
		} else if (e.height > 0) {
			css.height = `${e.height}cqh`;
			css.flex = "0 0 auto";
		}
		// Only a grid looks at these.
		if (e.spanCols > 1) css["grid-column"] = `span ${e.spanCols}`;
		if (e.spanRows > 1) css["grid-row"] = `span ${e.spanRows}`;
		if (e.textColor) css.color = env.ink(e.textColor);
		if (e.font && FONTS[e.font]) css["font-family"] = FONTS[e.font];
		// Set as the variable too, so pictures and panels inside follow.
		if (e.radius >= 0) Object.assign(css, { "--sd-radius": `${e.radius}px` });
		if (e.boxShadow !== "none" && !low) css["box-shadow"] = SHADOWS[e.boxShadow];
		if (e.opacity < 100 && !low) css.opacity = String(e.opacity / 100);
		if (e.box !== "none") {
			css.padding = `${e.boxPadding}px`;
			if (e.box === "solid" && e.boxColor) {
				const fill = env.ink(e.boxColor);
				css.background = fill;
				if (low) {
					// On ePaper the box became a solid ink: make its content readable on it.
					const text = contrastOn(fill);
					Object.assign(css, {
						color: text,
						"--sd-fg": text,
						"--sd-muted": text,
						"--sd-line": text,
						"--sd-accent": text,
					});
				}
			}
			if (e.box === "outline") css.border = `3px solid ${e.boxColor ? env.ink(e.boxColor) : "currentColor"}`;
		}
		if (e.borderWidth > 0)
			css.border = `${e.borderWidth}px solid ${e.borderColor ? env.ink(e.borderColor) : "currentColor"}`;
		return css;
	});

	return (
		// In the editor a hidden element stays (dimmed) so it can still be selected.
		<Show when={visible() || env.editing}>
			<div
				class="sd-el"
				classList={{
					"sd-el-grow": props.grow && !props.free,
					"sd-el-fixed": !props.free && el().height > 0,
					"sd-free": props.free,
					[`sd-box-${el().box}`]: el().box !== "none",
					"sd-el-hidden": !visible(),
					"sd-el-selected": props.selected,
					[`sd-enter-${el().enter}`]: el().enter !== "none" && !env.lowColor(),
				}}
				data-type={el().type}
				data-el={el().id}
				style={style()}
				onPointerDown={(event) => {
					if (!props.onPointerDown) return;
					event.stopPropagation();
					props.onPointerDown(el(), event);
				}}
			>
				<Dynamic
					component={renderers[el().type] as Component<RendererProps>}
					el={el()}
					data={state.data}
					error={state.error}
					loaded={state.loaded}
					selectedId={props.selectedId}
					onPointerDown={props.onPointerDown}
				/>
			</div>
		</Show>
	);
}

/** Shown in place of an element that has nothing to display yet. */
export function Placeholder(props: { text: string; error?: string }) {
	const env = useDisplay();
	return (
		<Show when={env.editing || props.error}>
			<div class="sd-placeholder" classList={{ "sd-placeholder-error": Boolean(props.error) }}>
				{props.error ?? props.text}
			</div>
		</Show>
	);
}
