/**
 * Renders one layout. The layout is drawn on a "stage" that is always 1080
 * units tall and then scaled to whatever box it is given, so a design looks
 * the same on a phone-sized preview and on a 4K TV.
 */
import { type Accessor, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { luminance, parseColor } from "../../shared/color";
import type { AnyEl, LayoutSettings } from "../../shared/types";
import { mediaUrl } from "../lib/api";
import { type DisplayEnv, DisplayProvider, layoutEnv } from "./context";
import { ElementBox, elementGrows } from "./ElementBox";
import { FONTS } from "./fonts";

export const STAGE_HEIGHT = 1080;

const JUSTIFY = { top: "flex-start", center: "center", bottom: "flex-end", spread: "space-between" } as const;
const BACKGROUND_FIT = {
	cover: { size: "cover", repeat: "no-repeat" },
	contain: { size: "contain", repeat: "no-repeat" },
	fill: { size: "100% 100%", repeat: "no-repeat" },
	repeat: { size: "auto", repeat: "repeat" },
} as const;

export interface CanvasProps {
	settings: LayoutSettings;
	elements: AnyEl[];
	env: DisplayEnv;
	/** Editor only: drawn inside the stage, above the elements (selection handles). */
	overlay?: (stage: { scale: Accessor<number>; width: Accessor<number> }) => JSX.Element;
	onElementPointerDown?: (el: AnyEl, event: PointerEvent) => void;
	selectedId?: string | null;
}

export function Canvas(props: CanvasProps) {
	let viewport!: HTMLDivElement;
	const [scale, setScale] = createSignal(0);
	const [width, setWidth] = createSignal(1920);
	const env = layoutEnv(props.env, () => props.settings);

	const fit = () => {
		const box = viewport.getBoundingClientRect();
		if (!box.width || !box.height) return;
		const ratio = props.settings.aspectRatio;
		if (!ratio || ratio === "auto") {
			// The stage takes the shape of the screen and fills it.
			setScale(box.height / STAGE_HEIGHT);
			setWidth(Math.round(box.width / (box.height / STAGE_HEIGHT)));
			return;
		}
		const [w, h] = ratio.split(":").map(Number);
		const stageWidth = Math.round(STAGE_HEIGHT * ((w || 16) / (h || 9)));
		setWidth(stageWidth);
		setScale(Math.min(box.width / stageWidth, box.height / STAGE_HEIGHT));
	};
	onMount(() => {
		fit();
		const observer = new ResizeObserver(fit);
		observer.observe(viewport);
		onCleanup(() => observer.disconnect());
	});
	// Refit when the ratio is changed in the editor.
	createMemo(() => {
		props.settings.aspectRatio;
		queueMicrotask(() => viewport && fit());
	});

	const paper = () => (env.invert() ? "#000000" : "#ffffff");
	const ink = () => (env.invert() ? "#ffffff" : "#000000");

	const viewportStyle = createMemo((): JSX.CSSProperties => {
		const s = props.settings;
		// ePaper modes ignore the designed background: paper is paper.
		if (env.lowColor()) return { background: paper() };
		const style: JSX.CSSProperties = { "background-color": s.background };
		const layers: string[] = [];
		if (s.backgroundImage) {
			if (s.backgroundDim > 0) {
				const dim = `rgba(0,0,0,${s.backgroundDim / 100})`;
				layers.push(`linear-gradient(${dim}, ${dim})`);
			}
			layers.push(`url("${mediaUrl(s.backgroundImage, 1920)}")`);
			const mode = BACKGROUND_FIT[s.backgroundFit] ?? BACKGROUND_FIT.cover;
			style["background-size"] = s.backgroundDim > 0 ? `auto, ${mode.size}` : mode.size;
			style["background-repeat"] = mode.repeat;
			style["background-position"] = s.backgroundPosition || "center";
		} else if (s.backgroundTo) {
			layers.push(`linear-gradient(${s.backgroundAngle}deg, ${s.background}, ${s.backgroundTo})`);
		}
		if (layers.length) style["background-image"] = layers.join(", ");
		return style;
	});

	const stageStyle = createMemo((): JSX.CSSProperties => {
		const s = props.settings;
		const low = env.lowColor();
		const text = low ? ink() : s.textColor;
		const rgb = parseColor(text);
		return {
			width: `${width()}px`,
			height: `${STAGE_HEIGHT}px`,
			transform: `scale(${scale()})`,
			visibility: scale() ? "visible" : "hidden",
			color: text,
			"font-family": FONTS[s.fontFamily] ?? FONTS.sans,
			"--sd-text-scale": String(s.textScale / 100),
			"--sd-fg": text,
			"--sd-accent": low ? env.ink(s.accentColor) : s.accentColor,
			"--sd-panel": low ? "transparent" : s.panelColor,
			"--sd-radius": `${s.radius}px`,
			"--sd-gap": `${s.spacing}px`,
			// Soft colours derived from the text colour, for secondary text and hairlines.
			"--sd-muted": low ? text : `color-mix(in srgb, ${text} 68%, transparent)`,
			"--sd-line": low ? text : `color-mix(in srgb, ${text} 22%, transparent)`,
			"--sd-shadow": !low && rgb && luminance(rgb) > 140 ? "0 2px 8px rgba(0,0,0,.28)" : "none",
		};
	});

	const flow = () => props.elements.filter((el) => el.placement !== "free");
	const free = () => props.elements.filter((el) => el.placement === "free");

	return (
		<DisplayProvider value={env}>
			<div
				ref={viewport}
				class="sd-viewport"
				data-mode={env.mode()}
				data-editing={env.editing ? "" : undefined}
				style={viewportStyle()}
			>
				<div class="sd-stage" style={stageStyle()}>
					<div
						class="sd-flow"
						style={{
							padding: `${props.settings.padding}px`,
							gap: `${props.settings.spacing}px`,
							"justify-content": JUSTIFY[props.settings.verticalAlign] ?? "flex-start",
						}}
					>
						<For each={flow()}>
							{(el) => (
								<ElementBox
									el={el}
									grow={elementGrows(el)}
									selected={props.selectedId === el.id}
									selectedId={props.selectedId}
									onPointerDown={props.onElementPointerDown}
								/>
							)}
						</For>
					</div>
					<For each={free()}>
						{(el) => (
							<ElementBox
								el={el}
								free
								selected={props.selectedId === el.id}
								selectedId={props.selectedId}
								onPointerDown={props.onElementPointerDown}
							/>
						)}
					</For>
					<Show when={props.overlay}>{(overlay) => overlay()({ scale, width })}</Show>
				</div>
			</div>
		</DisplayProvider>
	);
}
