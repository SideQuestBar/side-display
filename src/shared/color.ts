/**
 * Colour helpers for the low-colour (ePaper) modes: the palette of each mode,
 * nearest-colour mapping for user-chosen colours, and Floyd–Steinberg
 * dithering for pictures.
 */
import type { ColorMode } from "./types";

export type Rgb = [number, number, number];

/** The inks of each low-colour mode. `gray` is 16 evenly spaced greys. */
export const PALETTES: Record<Exclude<ColorMode, "full">, Rgb[]> = {
	mono: [
		[0, 0, 0],
		[255, 255, 255],
	],
	gray: Array.from({ length: 16 }, (_, i): Rgb => [i * 17, i * 17, i * 17]),
	color6: [
		[0, 0, 0],
		[255, 255, 255],
		[200, 30, 30],
		[240, 205, 0],
		[30, 70, 190],
		[40, 130, 70],
	],
};

export function parseColor(input: string): [number, number, number, number] | null {
	const hex = /^#?([0-9a-f]{3,8})$/i.exec(input.trim())?.[1];
	if (!hex || ![3, 4, 6, 8].includes(hex.length)) return null;
	const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
	const n = (i: number) => Number.parseInt(full.slice(i, i + 2), 16);
	return [n(0), n(2), n(4), full.length === 8 ? n(6) / 255 : 1];
}

const toHex = ([r, g, b]: Rgb) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
export const luminance = ([r, g, b]: Rgb | number[]) => 0.299 * r! + 0.587 * g! + 0.114 * b!;
/** Black or white, whichever reads better on the given colour. */
export const contrastOn = (color: string) => {
	const rgb = parseColor(color);
	return rgb && luminance(rgb) < 140 ? "#ffffff" : "#000000";
};

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

function nearest(palette: Rgb[], r: number, g: number, b: number): Rgb {
	let best = palette[0]!;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const p of palette) {
		// Weighted distance: the eye is most sensitive to green, least to blue.
		const d = 2 * (p[0] - r) ** 2 + 4 * (p[1] - g) ** 2 + 3 * (p[2] - b) ** 2;
		if (d < bestDistance) {
			bestDistance = d;
			best = p;
		}
	}
	return best;
}

/**
 * Maps a colour chosen in the editor to what the screen can show. In `mono`
 * the result is forced away from the paper colour so text never disappears.
 */
export function inkColor(color: string, mode: ColorMode, invert = false): string {
	if (mode === "full" || !color) return color;
	const rgba = parseColor(color);
	if (!rgba) return color;
	// Translucent colours are composited on the paper first.
	const paper = invert ? 0 : 255;
	const [r, g, b] = rgba.slice(0, 3).map((c) => Math.round(c * rgba[3] + paper * (1 - rgba[3]))) as Rgb;
	if (mode === "mono") {
		// One ink: anything that is not (nearly) the paper colour is drawn in ink,
		// so a yellow accent becomes black instead of vanishing into white.
		const nearPaper = invert ? luminance([r, g, b]) < 24 : luminance([r, g, b]) > 232;
		return nearPaper === invert ? "#000000" : "#ffffff";
	}
	return toHex(nearest(PALETTES[mode], r, g, b));
}

/** Dithers RGBA pixels in place to a mode's palette (Floyd–Steinberg, serpentine). */
export function dither(pixels: Uint8ClampedArray, width: number, height: number, mode: Exclude<ColorMode, "full">) {
	const palette = PALETTES[mode];
	const errors = new Float32Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		const reverse = y % 2 === 1;
		for (let i = 0; i < width; i++) {
			const x = reverse ? width - 1 - i : i;
			const p = (y * width + x) * 4;
			const e = (y * width + x) * 3;
			// Fully transparent pixels stay transparent, so the paper shows through.
			if (pixels[p + 3]! < 8) {
				pixels[p + 3] = 0;
				continue;
			}
			const alpha = pixels[p + 3]! / 255;
			// Partly transparent ones are blended onto white first.
			// Clamping keeps the carried error bounded: colours the inks cannot
			// reproduce would otherwise pile it up and smear ghost bands downwards.
			const r = clamp(pixels[p]! * alpha + 255 * (1 - alpha) + errors[e]!);
			const g = clamp(pixels[p + 1]! * alpha + 255 * (1 - alpha) + errors[e + 1]!);
			const b = clamp(pixels[p + 2]! * alpha + 255 * (1 - alpha) + errors[e + 2]!);
			const [nr, ng, nb] = nearest(palette, r, g, b);
			pixels[p] = nr;
			pixels[p + 1] = ng;
			pixels[p + 2] = nb;
			pixels[p + 3] = 255;
			const er = r - nr;
			const eg = g - ng;
			const eb = b - nb;
			const spread = (dx: number, dy: number, factor: number) => {
				const nx = x + (reverse ? -dx : dx);
				const ny = y + dy;
				if (nx < 0 || nx >= width || ny >= height) return;
				const t = (ny * width + nx) * 3;
				errors[t] = errors[t]! + er * factor;
				errors[t + 1] = errors[t + 1]! + eg * factor;
				errors[t + 2] = errors[t + 2]! + eb * factor;
			};
			spread(1, 0, 7 / 16);
			spread(-1, 1, 3 / 16);
			spread(0, 1, 5 / 16);
			spread(1, 1, 1 / 16);
		}
	}
}
