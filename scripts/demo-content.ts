/**
 * Sample content for `bun run demo`: a few generated pictures, four layouts
 * and four displays that together use most element types.
 */

import { listMedia, saveUpload } from "../src/server/media";
import { setSetting } from "../src/server/settings";
import { createDisplay, createLayout, createPlaylist, listLayouts } from "../src/server/store";
import { makeElement } from "../src/shared/layout";
import { TEMPLATES } from "../src/shared/templates";

/** A stylised landscape as SVG: sky gradient, sun and three ridges. */
function landscape(sky: [string, string], sun: string, hills: [string, string, string], sunX: number): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1280" viewBox="0 0 1920 1280">
<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient></defs>
<rect width="1920" height="1280" fill="url(#sky)"/>
<circle cx="${sunX}" cy="470" r="150" fill="${sun}"/>
<path d="M0 760 L260 560 L470 700 L760 450 L1040 690 L1300 520 L1620 720 L1920 600 L1920 1280 L0 1280Z" fill="${hills[0]}"/>
<path d="M0 900 L300 740 L620 880 L900 700 L1240 900 L1540 760 L1920 900 L1920 1280 L0 1280Z" fill="${hills[1]}"/>
<path d="M0 1060 L360 920 L700 1040 L1100 900 L1480 1060 L1920 960 L1920 1280 L0 1280Z" fill="${hills[2]}"/>
</svg>`;
}

const PHOTOS: { name: string; album: string; svg: string }[] = [
	{
		name: "Golden hour",
		album: "Landscapes",
		svg: landscape(["#ff9a5a", "#ffd9a0"], "#fff3c4", ["#c8553d", "#8c3b3b", "#4a2433"], 1380),
	},
	{
		name: "Blue ridge",
		album: "Landscapes",
		svg: landscape(["#3a6ea5", "#c6e2ff"], "#ffffff", ["#5b8fb9", "#34638f", "#1b3a5c"], 520),
	},
	{
		name: "Forest dusk",
		album: "Landscapes",
		svg: landscape(["#2b2d5b", "#e07a8b"], "#ffd1a6", ["#3f6f5a", "#285244", "#16302a"], 960),
	},
	{
		name: "Desert noon",
		album: "Landscapes",
		svg: landscape(["#58b4d1", "#f6e7c1"], "#fff8d6", ["#e0a458", "#c27a3a", "#8a4f2a"], 1500),
	},
	{
		name: "Night peaks",
		album: "Landscapes",
		svg: landscape(["#0b1026", "#3b3f7a"], "#e9ecff", ["#2c3e6b", "#1c2a4d", "#0e1730"], 420),
	},
];

export async function seedDemo(sampleServer: string) {
	if (listLayouts().length) return;

	setSetting("general", {
		locale: "en-GB",
		timezone: "",
		hourCycle: "24",
		temperatureUnit: "c",
		locationName: "Budapest",
		latitude: 47.4979,
		longitude: 19.0402,
	});

	for (const photo of PHOTOS)
		await saveUpload(new File([photo.svg], `${photo.name}.svg`, { type: "image/svg+xml" }), photo.album);
	const photos = listMedia().reverse();
	const src = (name: string) => `media/${photos.find((m) => m.name === name)?.file}`;
	const template = (id: string) => TEMPLATES.find((t) => t.id === id)!.build();
	const calendar = [
		{ kind: "ical", url: `${sampleServer}/calendar.ics`, entity: "", name: "Events", color: "#ffd24a" },
	];

	// 1. A venue's welcome board.
	const welcome = createLayout({
		name: "Bar · welcome board",
		settings: { ...template("welcome").settings },
		elements: [
			makeElement("columns", {
				widths: "5:3",
				columns: [
					[
						makeElement("slideshow", {
							interval: 8,
							slides: [
								{
									title: "Quiz night",
									subtitle: "Every Thursday at 19:30 · teams of up to six",
									image: src("Forest dusk"),
								},
								{ title: "Happy hour", subtitle: "Weekdays 17:00 – 19:00", image: src("Golden hour") },
								{ title: "Board game Sunday", subtitle: "Over 200 games to borrow", image: src("Blue ridge") },
							],
						}),
						makeElement("calendar", {
							title: "What's on",
							sources: calendar,
							max: 4,
							days: 10,
							size: 30,
							box: "panel",
							location: true,
						}),
					],
					[
						makeElement("clock", { size: 150 }),
						makeElement("hours", { box: "panel", size: 42 }),
						makeElement("list", {
							title: "On tap",
							size: 30,
							items: [
								{ label: "House lager", value: "4.20", note: "" },
								{ label: "Hazy IPA", value: "5.60", note: "6.2 % · local brewery" },
								{ label: "Dry cider", value: "4.90", note: "" },
								{ label: "Ginger kombucha", value: "3.80", note: "Alcohol-free" },
							],
						}),
						makeElement("spacer"),
						makeElement("qr", {
							url: "https://example.com/menu",
							caption: "**Full menu**\nScan me",
							captionPosition: "left",
							codeSize: 15,
							captionSize: 32,
						}),
					],
				],
			}),
			makeElement("ticker", {
				text: "Free Wi-Fi: ask at the bar\nCard and cash welcome",
				feed: `${sampleServer}/feed.xml`,
				size: 32,
			}),
			makeElement("sticker", { emoji: "🎲", x: 57, y: 2, w: 7, h: 13, rotate: 14, animation: "wiggle" }),
		],
	});

	// 2. A Home Assistant dashboard.
	const dashboard = createLayout({
		name: "Home · dashboard",
		settings: { ...template("dashboard").settings },
		elements: [
			makeElement("columns", {
				widths: "4:5:4",
				columns: [
					[
						makeElement("clock", { size: 150 }),
						makeElement("weather", { source: "ha", entity: "weather.home", box: "panel", size: 30, days: 4 }),
						makeElement("ha-todo", { entity: "todo.shopping_list", title: "Shopping list", box: "panel", size: 30 }),
					],
					[
						makeElement("ha-entities", {
							variant: "tiles",
							columns: 3,
							size: 28,
							stateMap: "on=On, off=Closed, home=Home, not_home=Away",
							entities: [
								{ entity: "sensor.living_room_temperature", label: "" },
								{ entity: "sensor.bedroom_temperature", label: "" },
								{ entity: "sensor.outdoor_temperature", label: "" },
								{ entity: "binary_sensor.front_door", label: "" },
								{ entity: "person.alex", label: "" },
								{ entity: "person.sam", label: "" },
							],
						}),
						makeElement("ha-graph", {
							entity: "sensor.outdoor_temperature",
							label: "Outside, last 24 h",
							box: "panel",
							size: 28,
							graphHeight: 16,
						}),
						makeElement("map", {
							zoom: 12.5,
							style: "positron",
							fitMarkers: true,
							trackers: [
								{ entity: "person.alex", label: "", color: "#3b82f6" },
								{ entity: "person.sam", label: "", color: "#e5484d" },
							],
						}),
					],
					[
						makeElement("ha-gauge", {
							entity: "sensor.power_consumption",
							label: "Power use",
							min: 0,
							max: 1500,
							size: 34,
							thresholds: [
								{ from: 0, color: "#30a46c" },
								{ from: 800, color: "#f5a524" },
								{ from: 1200, color: "#e5484d" },
							],
						}),
						makeElement("calendar", {
							title: "Family",
							sources: [{ kind: "ha", url: "", entity: "calendar.family", name: "Family", color: "#6ee7b7" }],
							max: 3,
							size: 26,
							box: "panel",
						}),
						makeElement("ha-camera", { entity: "camera.front_door", refresh: 10, label: true }),
						makeElement("ha-media", { entity: "media_player.living_room", size: 30, box: "panel", boxPadding: 18 }),
					],
				],
			}),
		],
	});

	// 3. A portrait page for an ePaper frame.
	const epaper = createLayout({
		name: "Kitchen · ePaper",
		settings: { ...template("epaper").settings },
		elements: [
			makeElement("date", { format: "day", size: 36, align: "left" }),
			makeElement("divider", { thickness: 4, color: "#000000" }),
			makeElement("weather", { source: "ha", entity: "weather.home", variant: "forecast", days: 4, size: 24 }),
			makeElement("divider", { thickness: 4, color: "#000000" }),
			makeElement("columns", {
				widths: "3:2",
				columns: [
					[makeElement("calendar", { title: "Agenda", sources: calendar, max: 3, size: 26 })],
					[makeElement("ha-todo", { entity: "todo.shopping_list", title: "To buy", size: 26, max: 4 })],
				],
			}),
			makeElement("image", { src: src("Blue ridge"), grow: "yes", fit: "cover", rounded: false }),
		],
	});

	// 4. A photo frame.
	const frame = createLayout({
		name: "Photo frame",
		settings: { ...template("photo-frame").settings },
		elements: [
			makeElement("gallery", { album: "Landscapes", interval: 12, transition: "zoom" }),
			makeElement("clock", {
				placement: "free",
				x: 71,
				y: 74,
				w: 26,
				h: 21,
				size: 96,
				box: "solid",
				boxColor: "#00000088",
				boxPadding: 18,
			}),
		],
	});

	const rotation = createPlaylist({
		name: "Bar rotation",
		entries: [
			{ layoutId: welcome.id, seconds: 45 },
			{ layoutId: frame.id, seconds: 20 },
		],
	});
	createDisplay({ name: "Bar TV", playlistId: rotation.id });
	createDisplay({
		name: "Hallway tablet",
		playlist: [{ layoutId: dashboard.id, seconds: 60 }],
		settings: { dimFrom: "23:00", dimTo: "06:30" },
	});
	createDisplay({
		name: "Kitchen frame",
		playlist: [{ layoutId: epaper.id, seconds: 60 }],
		settings: { colorMode: "mono" },
	});
	createDisplay({
		name: "Shelf frame",
		playlist: [{ layoutId: frame.id, seconds: 60 }],
		settings: { colorMode: "color6" },
	});
}
