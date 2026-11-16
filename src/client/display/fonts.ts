import type { LayoutSettings } from "../../shared/types";

/** The font stacks behind the font choices of a layout or an element: system fonts only, nothing to download. */
export const FONTS: Record<LayoutSettings["fontFamily"], string> = {
	sans: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", sans-serif',
	serif: 'Georgia, "Iowan Old Style", "Palatino Linotype", "Noto Serif", serif',
	mono: 'ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, monospace',
	rounded: 'ui-rounded, "SF Pro Rounded", "Nunito", "Varela Round", system-ui, sans-serif',
	condensed: '"Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif',
};
