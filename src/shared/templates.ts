/**
 * Starter layouts offered when creating a layout. They only use elements that
 * work out of the box; anything needing an address or an entity is left for
 * the user to fill in.
 */
import { makeElement } from "./layout";
import { type AnyEl, DEFAULT_LAYOUT_SETTINGS, type LayoutSettings } from "./types";

export interface Template {
	id: string;
	name: string;
	description: string;
	build: () => { settings: LayoutSettings; elements: AnyEl[] };
}

const settings = (overrides: Partial<LayoutSettings>): LayoutSettings => ({ ...DEFAULT_LAYOUT_SETTINGS, ...overrides });

export const TEMPLATES: Template[] = [
	{
		id: "blank",
		name: "Blank",
		description: "An empty canvas.",
		build: () => ({ settings: settings({}), elements: [] }),
	},
	{
		id: "welcome",
		name: "Welcome board",
		description: "For a bar, shop or office: what's on, opening hours, a QR code.",
		build: () => ({
			settings: settings({ background: "#16323f", backgroundTo: "#3a2356", accentColor: "#ffd24a" }),
			elements: [
				makeElement("columns", {
					widths: "5:3",
					columns: [
						[
							makeElement("text", {
								text: "# Welcome!\nGrab a seat, we'll be right with you.",
								align: "left",
								size: 52,
							}),
							makeElement("slideshow", {
								slides: [
									{ title: "Quiz night", subtitle: "Every Thursday at 19:30", image: "" },
									{ title: "Happy hour", subtitle: "Weekdays 17:00 – 19:00", image: "" },
									{ title: "Board game Sunday", subtitle: "Over 200 games to borrow", image: "" },
								],
							}),
						],
						[
							makeElement("clock", { size: 150 }),
							makeElement("hours", { box: "panel", size: 44 }),
							makeElement("hours", { variant: "week", size: 28 }),
							makeElement("spacer"),
							makeElement("qr", {
								caption: "**Menu & events**\nScan me",
								captionPosition: "left",
								codeSize: 17,
								captionSize: 34,
							}),
						],
					],
				}),
				makeElement("ticker", {
					text: "Free Wi-Fi: ask at the bar\nFollow us for this week's events\nCard and cash welcome",
					size: 34,
				}),
				makeElement("sticker", { emoji: "🎲", x: 55, y: 3, w: 8, h: 14, rotate: 14, animation: "wiggle" }),
			],
		}),
	},
	{
		id: "dashboard",
		name: "Home dashboard",
		description: "Clock, weather and calendar, ready for Home Assistant tiles.",
		build: () => ({
			settings: settings({ background: "#0f1d2b", backgroundTo: "#1f3a4d", accentColor: "#6ee7b7" }),
			elements: [
				makeElement("columns", {
					widths: "1:1",
					columns: [
						[
							makeElement("clock", { size: 190, seconds: false }),
							makeElement("weather", { box: "panel", size: 38, days: 5 }),
						],
						[
							makeElement("calendar", { title: "Coming up", box: "panel", size: 32, max: 7 }),
							makeElement("ha-entities", { title: "Home", variant: "tiles", box: "none", size: 30, columns: 3 }),
						],
					],
				}),
			],
		}),
	},
	{
		id: "photo-frame",
		name: "Photo frame",
		description: "An album in full screen with a small clock in the corner.",
		build: () => ({
			settings: settings({ background: "#000000", padding: 0, spacing: 0, radius: 0 }),
			elements: [
				makeElement("gallery", { interval: 20, transition: "zoom", shuffle: true }),
				makeElement("clock", {
					placement: "free",
					x: 72,
					y: 78,
					w: 25,
					h: 18,
					size: 90,
					box: "solid",
					boxColor: "#00000088",
					boxPadding: 18,
				}),
			],
		}),
	},
	{
		id: "epaper",
		name: "ePaper agenda",
		description: "A calm, high-contrast portrait page for an ePaper frame.",
		build: () => ({
			settings: settings({
				aspectRatio: "3:4",
				background: "#ffffff",
				textColor: "#000000",
				accentColor: "#c81e1e",
				panelColor: "#0000000f",
				fontFamily: "serif",
				padding: 48,
				spacing: 30,
				radius: 0,
			}),
			elements: [
				makeElement("date", { format: "day", size: 62, align: "left" }),
				makeElement("divider", { thickness: 4, color: "#000000" }),
				makeElement("weather", { variant: "forecast", days: 4, size: 34 }),
				makeElement("divider", { thickness: 4, color: "#000000" }),
				makeElement("calendar", { title: "Agenda", size: 34, max: 6 }),
				makeElement("spacer"),
				makeElement("text", { text: "*Updated automatically · SideDisplay*", size: 22, weight: "400", shadow: false }),
			],
		}),
	},
];
