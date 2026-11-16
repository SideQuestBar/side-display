import type * as MapLibre from "maplibre-gl";
import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	For,
	getOwner,
	type JSX,
	on,
	onCleanup,
	onMount,
	runWithOwner,
	Show,
	untrack,
} from "solid-js";
import { contrastOn } from "../../../shared/color";
import type { AirQualityData, Condition, MapData, WeatherData } from "../../../shared/data";
import type { El } from "../../../shared/elements";
import { timeFormatter } from "../../../shared/time";
import {
	AQI_FULL,
	aqiBand,
	type Band,
	convertWind,
	type PollenKind,
	pollenBand,
	WIND_LABELS,
} from "../../../shared/weather";
import { url } from "../../lib/api";
import { px, useDisplay } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";

// ------------------------------------------------------------------- weather

const cloud = "M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5a3.75 3.75 0 0 1-.5 7.5z";
const smallCloud = "M9.5 19a3.5 3.5 0 0 1-.4-6.98A4.75 4.75 0 0 1 18.2 13a3 3 0 0 1-.4 6z";
const sunRays =
	"M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8";

/**
 * Line icons drawn with the text colour, so they work on any background and in
 * 1-bit. The filled style fills the same shapes; the ones marked `fill="none"`
 * would turn into blobs and stay outlines.
 */
const ICONS: Record<Condition, () => JSX.Element> = {
	clear: () => (
		<>
			<circle cx="12" cy="12" r="4.5" />
			<path d={sunRays} />
		</>
	),
	night: () => <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z" />,
	partly: () => (
		<>
			<circle cx="8" cy="8" r="3" fill="none" />
			<path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1M12.2 3.8l-1 1" />
			<path d={smallCloud} />
		</>
	),
	cloudy: () => <path d={cloud} />,
	fog: () => (
		<>
			<path d="M7 14a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 6.5a3.75 3.75 0 0 1-.5 7.5z" />
			<path d="M4 18h16M7 21.5h10" />
		</>
	),
	drizzle: () => (
		<>
			<path d="M7 15a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 7.5a3.75 3.75 0 0 1-.5 7.5z" />
			<path d="M9 18.5v1M15 18.5v1M12 20v1" />
		</>
	),
	rain: () => (
		<>
			<path d="M7 15a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 7.5a3.75 3.75 0 0 1-.5 7.5z" />
			<path d="M8.5 18l-1 3.5M12.5 18l-1 3.5M16.5 18l-1 3.5" />
		</>
	),
	snow: () => (
		<>
			<path d="M7 15a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 7.5a3.75 3.75 0 0 1-.5 7.5z" />
			<path d="M8 19h.01M12 21h.01M16 19h.01M12 18h.01" stroke-width="2.4" />
		</>
	),
	thunder: () => (
		<>
			<path d="M7 15a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 7.5a3.75 3.75 0 0 1-.5 7.5z" />
			<path d="M13 16l-3 3.5h3.5L11.5 23" fill="none" />
		</>
	),
	wind: () => <path d="M3 9h10.5a2.75 2.75 0 1 0-2.6-3.6M3 13h15a2.75 2.75 0 1 1-2.6 3.6M3 17h7" fill="none" />,
	unknown: () => <path d={cloud} />,
};

const EMOJI: Record<Condition, string> = {
	clear: "☀️",
	night: "🌙",
	partly: "⛅",
	cloudy: "☁️",
	fog: "🌫️",
	drizzle: "🌦️",
	rain: "🌧️",
	snow: "🌨️",
	thunder: "⛈️",
	wind: "💨",
	unknown: "☁️",
};

const LABELS: Record<Condition, string> = {
	clear: "Clear",
	night: "Clear",
	partly: "Partly cloudy",
	cloudy: "Cloudy",
	fog: "Fog",
	drizzle: "Drizzle",
	rain: "Rain",
	snow: "Snow",
	thunder: "Thunderstorm",
	wind: "Windy",
	unknown: "",
};

type IconLook = El<"weather">["icons"];

function WeatherIcon(props: { condition: Condition; look?: IconLook }) {
	return (
		<Show
			when={props.look !== "emoji"}
			fallback={
				<span class="sd-weather-icon sd-weather-emoji" aria-hidden="true">
					{EMOJI[props.condition]}
				</span>
			}
		>
			<svg
				class="sd-weather-icon"
				viewBox="0 0 24 24"
				fill={props.look === "filled" ? "currentColor" : "none"}
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				{ICONS[props.condition]()}
			</svg>
		</Show>
	);
}

export function Weather(props: RendererProps<El<"weather">, WeatherData>) {
	const env = useDisplay();
	const degrees = (value: number | null) => (value === null ? "–" : `${Math.round(value)}°`);
	const weekday = (date: string) =>
		new Intl.DateTimeFormat(env.general().locale || undefined, { weekday: "short", timeZone: "UTC" }).format(
			new Date(`${date}T12:00:00Z`),
		);
	// Forecast times are wall-clock times at the place: read as UTC, shown as UTC.
	const hourFormat = createMemo(() => {
		const { locale, hourCycle } = env.general();
		const cycle = hourCycle === "auto" ? {} : { hourCycle: hourCycle === "12" ? ("h12" as const) : ("h23" as const) };
		return new Intl.DateTimeFormat(locale || undefined, { hour: "numeric", timeZone: "UTC", ...cycle });
	});
	const hourLabel = (time: string) => {
		const at = new Date(`${time}:00Z`);
		if (Number.isNaN(at.getTime())) return "";
		const label = hourFormat().format(at);
		// A bare "17" next to "7°" reads as another number; "5 pm" does not.
		return /^\d+$/.test(label) ? `${label}:00` : label;
	};
	// One-bit paper cannot show a colour glyph: the line icon takes over.
	const look = (): IconLook => (props.el.icons === "emoji" && env.mode() === "mono" ? "line" : props.el.icons);
	const rainShown = (chance: number | null): chance is number => {
		if (chance === null || props.el.rainChance === "never") return false;
		return props.el.rainChance === "always" || chance >= 20;
	};
	const wind = (weather: WeatherData) => {
		const speed = weather.current.wind;
		if (speed === null) return "";
		const unit = props.el.windUnit;
		// A source whose unit we cannot read is shown as it came.
		const converted = unit === "auto" ? null : convertWind(speed, weather.windUnit, unit);
		if (unit === "auto" || converted === null) return `${Math.round(speed)} ${weather.windUnit}`;
		const digits = unit === "ms" && converted < 10 ? 1 : 0;
		return `${converted.toFixed(digits)} ${WIND_LABELS[unit]}`;
	};
	const hours = (weather: WeatherData) => {
		if (props.el.variant === "compact" || props.el.hours <= 0) return [];
		const step = Math.max(1, Math.round(props.el.hourStep));
		// Data cached before hourly forecasts existed has no `hours`.
		return (weather.hours ?? []).slice(0, props.el.hours).filter((_, i) => (i + 1) % step === 0);
	};
	const alerts = (weather: WeatherData) => (props.el.alerts ? (weather.alerts ?? []).slice(0, 2) : []);

	return (
		<Show when={props.data()} fallback={<Placeholder text="Loading the weather…" error={props.error()} />}>
			{(weather) => (
				<div class="sd-weather" data-variant={props.el.variant} style={{ "font-size": px(props.el.size) }}>
					<For each={alerts(weather())}>
						{(alert) => (
							<div class="sd-weather-alert" style={{ "--sd-alert": env.ink("#f59e0b") }}>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
									<path d="M12 3.5 2.5 20h19zM12 10v4.5M12 17.2v.3" stroke-linecap="round" stroke-linejoin="round" />
								</svg>
								<span>
									{/* A warning we worked out is not one a weather service issued: say so. */}
									<Show when={alert.derived}>
										<span class="sd-weather-alert-tag">Forecast</span>
									</Show>
									{alert.title}
								</span>
							</div>
						)}
					</For>
					<div class="sd-weather-now">
						<WeatherIcon condition={weather().current.condition} look={look()} />
						<div class="sd-weather-temperature">
							{Math.round(weather().current.temperature)}
							<span class="sd-weather-unit">{weather().unit}</span>
						</div>
						<div class="sd-weather-summary">
							<Show when={weather().place}>
								<div class="sd-weather-place">{weather().place}</div>
							</Show>
							<div>{LABELS[weather().current.condition]}</div>
							<Show when={props.el.details && props.el.variant !== "compact"}>
								<div class="sd-weather-details">
									<Show when={props.el.feelsLike && weather().current.feelsLike !== null}>
										<span>Feels {degrees(weather().current.feelsLike)}</span>
									</Show>
									<Show when={weather().current.humidity !== null}>
										<span>{Math.round(weather().current.humidity ?? 0)}% humidity</span>
									</Show>
									<Show when={wind(weather())}>
										<span>{wind(weather())}</span>
									</Show>
									<Show when={props.el.uv && typeof weather().current.uv === "number"}>
										<span>UV {Math.round(weather().current.uv ?? 0)}</span>
									</Show>
								</div>
							</Show>
						</div>
					</div>
					<Show when={hours(weather()).length}>
						<div class="sd-weather-days sd-weather-hours">
							<For each={hours(weather())}>
								{(hour) => (
									<div class="sd-weather-day">
										<div class="sd-weather-day-name">{hourLabel(hour.time)}</div>
										<WeatherIcon condition={hour.condition} look={look()} />
										<div class="sd-weather-range">{degrees(hour.temperature)}</div>
										<Show when={rainShown(hour.rain)}>
											<div class="sd-weather-rain">{Math.round(hour.rain ?? 0)}%</div>
										</Show>
									</div>
								)}
							</For>
						</div>
					</Show>
					<Show when={props.el.variant === "forecast" && weather().days.length}>
						<div class="sd-weather-days">
							<For each={weather().days.slice(0, props.el.days)}>
								{(day) => (
									<div class="sd-weather-day">
										<div class="sd-weather-day-name">{weekday(day.date)}</div>
										<WeatherIcon condition={day.condition} look={look()} />
										<div class="sd-weather-range">
											<span>{degrees(day.max)}</span>
											<span class="sd-weather-low">{degrees(day.min)}</span>
										</div>
										<Show when={rainShown(day.rain)}>
											<div class="sd-weather-rain">{Math.round(day.rain ?? 0)}%</div>
										</Show>
									</div>
								)}
							</For>
						</div>
					</Show>
				</div>
			)}
		</Show>
	);
}

// --------------------------------------------------------------- air quality

const POLLUTANT_NAMES: Record<AirQualityData["pollutants"][number]["key"], string> = {
	pm2_5: "PM2.5",
	pm10: "PM10",
	no2: "NO₂",
	o3: "O₃",
};
const POLLEN_NAMES: Record<PollenKind, string> = {
	alder: "Alder",
	birch: "Birch",
	grass: "Grass",
	mugwort: "Mugwort",
	olive: "Olive",
	ragweed: "Ragweed",
};

/**
 * Every band is named in words next to its colour: an ePaper screen has too
 * few inks to tell "fair" from "moderate" by colour, and so do many eyes.
 */
export function AirQuality(props: RendererProps<El<"air-quality">, AirQualityData>) {
	const env = useDisplay();
	const scale = () => props.el.scale;
	const index = (air: AirQualityData) => air[scale()];
	const band = (value: number | null): Band | null => (value === null ? null : aqiBand(scale(), value));
	const share = (value: number | null) => `${Math.min(100, Math.max(4, ((value ?? 0) / AQI_FULL[scale()]) * 100))}%`;
	const chip = (band: Band | null): JSX.CSSProperties => {
		const fill = env.ink(band?.color ?? "#9aa0a6");
		return { background: fill, color: contrastOn(fill) };
	};
	const pollutants = (air: AirQualityData) =>
		props.el.pollutants ? air.pollutants.filter((pollutant) => pollutant.value !== null) : [];
	// Six tiles saying "none" all winter would be noise: only what is in the air is listed.
	const pollen = (air: AirQualityData) =>
		props.el.pollen
			? air.pollen
					.map((entry) => ({ ...entry, band: pollenBand(entry.kind, entry.value) }))
					.filter((entry) => entry.band.level > 0)
			: [];
	const quiet = (air: AirQualityData) => props.el.pollen && air.pollen.length > 0 && pollen(air).length === 0;
	const nothing = () => !props.el.aqi && !props.el.pollutants && !props.el.pollen;

	return (
		<Show when={!nothing()} fallback={<Placeholder text="Choose what to show: index, pollutants or pollen" />}>
			<Show when={props.data()} fallback={<Placeholder text="Loading the air quality…" error={props.error()} />}>
				{(air) => (
					<div class="sd-air" data-variant={props.el.variant} style={{ "font-size": px(props.el.size) }}>
						<Show when={props.el.aqi}>
							<div class="sd-air-now">
								<div class="sd-air-chip" style={chip(band(index(air())))}>
									{index(air()) === null ? "–" : Math.round(index(air()) ?? 0)}
								</div>
								<div class="sd-air-summary">
									<Show when={air().place && props.el.variant !== "compact"}>
										<div class="sd-air-place">{air().place}</div>
									</Show>
									<div>{band(index(air()))?.label ?? "No data"}</div>
									<Show when={props.el.variant !== "compact"}>
										<div class="sd-air-scale">
											{scale() === "us" ? "US air quality index" : "European air quality index"}
										</div>
									</Show>
								</div>
							</div>
						</Show>
						<Show when={pollutants(air()).length || pollen(air()).length || quiet(air())}>
							<div class="sd-air-grid">
								<For each={pollutants(air())}>
									{(pollutant) => (
										<div class="sd-air-tile">
											<div class="sd-air-name">{POLLUTANT_NAMES[pollutant.key]}</div>
											<div class="sd-air-value">
												{Math.round(pollutant.value ?? 0)}
												<span class="sd-air-unit">µg/m³</span>
											</div>
											{/* The length of the bar carries the level; the colour only repeats it. */}
											<Show when={props.el.variant !== "compact"}>
												<div class="sd-air-bar">
													<i
														style={{
															width: share(pollutant[scale()]),
															background: env.ink(band(pollutant[scale()])?.color ?? "#9aa0a6"),
														}}
													/>
												</div>
											</Show>
										</div>
									)}
								</For>
								<For each={pollen(air())}>
									{(entry) => (
										<div class="sd-air-tile">
											<div class="sd-air-name">{POLLEN_NAMES[entry.kind]}</div>
											<div class="sd-air-value sd-air-level">{entry.band.label}</div>
											<Show when={props.el.variant !== "compact"}>
												<div class="sd-air-steps">
													<For each={[1, 2, 3, 4]}>
														{(step) => (
															<i
																classList={{ "sd-air-step-on": step <= entry.band.level }}
																style={{ background: step <= entry.band.level ? env.ink(entry.band.color) : undefined }}
															/>
														)}
													</For>
												</div>
											</Show>
										</div>
									)}
								</For>
								<Show when={quiet(air())}>
									<div class="sd-air-tile">
										<div class="sd-air-name">Pollen</div>
										<div class="sd-air-value sd-air-level">None</div>
									</div>
								</Show>
							</div>
						</Show>
					</div>
				)}
			</Show>
		</Show>
	);
}

// ----------------------------------------------------------------------- map

export const MAP_STYLES: Record<string, string> = {
	liberty: "https://tiles.openfreemap.org/styles/liberty",
	bright: "https://tiles.openfreemap.org/styles/bright",
	positron: "https://tiles.openfreemap.org/styles/positron",
	dark: "https://tiles.openfreemap.org/styles/dark",
};
const styleAddress = (style: string, custom: string) =>
	(style === "custom" ? custom : MAP_STYLES[style]) || MAP_STYLES.liberty!;

type MapLibreModule = typeof MapLibre;
let library: Promise<MapLibreModule> | undefined;
/**
 * MapLibre is big, so it is not part of the bundle: the build copies it to
 * `vendor/maplibre/` and it is fetched the first time a map is shown.
 */
export function loadMapLibre(): Promise<MapLibreModule> {
	library ??= (async () => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url("vendor/maplibre/maplibre-gl.css");
		document.head.append(link);
		// A computed specifier keeps the bundler from following the import.
		const specifier = url("vendor/maplibre/maplibre-gl.mjs");
		return (await import(specifier)) as MapLibreModule;
	})();
	library.catch(() => {
		library = undefined;
	});
	return library;
}

const round = (value: number, digits: number) => Number(value.toFixed(digits)) + 0;
/** The view of a map as it is stored: rounded so that it is stable and readable in the form. */
function viewOf(map: MapLibre.Map) {
	const { lng, lat } = map.getCenter().wrap();
	return {
		latitude: round(lat, 5),
		longitude: round(lng, 5),
		zoom: round(map.getZoom(), 2),
		pitch: round(map.getPitch(), 0),
		bearing: round(map.getBearing(), 0),
	};
}

/** What both kinds of map share: a picture nobody touches unless the editor says so. */
function createMap(
	maplibre: MapLibreModule,
	container: HTMLElement,
	view: {
		style: string;
		center: [number, number];
		zoom: number;
		pitch?: number;
		bearing?: number;
		interactive: boolean;
	},
): MapLibre.Map {
	return new maplibre.Map({
		container,
		...view,
		// The editor has its own keys, and a double click adds a marker.
		keyboard: false,
		doubleClickZoom: false,
		attributionControl: { compact: true },
		// Lets the ePaper modes and screenshots read the canvas back.
		canvasContextAttributes: { preserveDrawingBuffer: true },
	});
}

/** Deep equality for data that is refetched on a timer and mostly comes back the same. */
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** An emoji or a few letters for a marker: at most three characters as a reader counts them. */
function markerIcon(text: string | undefined): string {
	const icon = (text ?? "").trim();
	if (!icon) return "";
	return [...new Intl.Segmenter().segment(icon)]
		.slice(0, 3)
		.map((part) => part.segment)
		.join("");
}

/** What we draw on top of the map's style, bottom to top. */
const OVERLAYS = ["sd-traffic", "sd-overlay", "sd-trails", "sd-route"] as const;
type OverlayName = (typeof OVERLAYS)[number];
type OverlayLayer =
	Exclude<MapLibre.LayerSpecification, { type: "background" }> extends infer L
		? L extends unknown
			? Omit<L, "source">
			: never
		: never;

/**
 * On a screen the map is a picture. In the editor the selected map is the
 * control for its own settings: moving it sets the view, double-clicking adds
 * a marker and markers are dragged into place.
 */
export function MapElement(props: RendererProps<El<"map">, MapData>) {
	const env = useDisplay();
	let container!: HTMLDivElement;
	let map: MapLibre.Map | undefined;
	let markers: MapLibre.Marker[] = [];
	let gone = false;
	const [ready, setReady] = createSignal(false);
	const [failure, setFailure] = createSignal<string>();
	// Counts the styles that finished loading; 0 while one is on its way.
	const [styled, setStyled] = createSignal(0);
	const edit = env.edit && ((key: string, value: unknown) => env.edit!(props.el.id, key, value));

	const center = (): [number, number] => {
		const own = props.el.latitude !== 0 || props.el.longitude !== 0;
		return own ? [props.el.longitude, props.el.latitude] : [env.general().longitude, env.general().latitude];
	};
	const styleUrl = () => styleAddress(props.el.style, props.el.styleUrl);
	const placed = () =>
		props.el.markers
			.map((marker, index) => ({ ...marker, index }))
			.filter((m) => m.latitude !== 0 || m.longitude !== 0);
	const points = () => [...placed(), ...(props.data()?.trackers ?? []).map((tracker) => ({ ...tracker, index: -1 }))];
	const setMarker = (index: number, at: { lat: number; lng: number }) =>
		edit?.(
			"markers",
			props.el.markers.map((marker, i) =>
				i === index ? { ...marker, latitude: round(at.lat, 5), longitude: round(at.lng, 5) } : marker,
			),
		);
	// The data is refetched every minute; the lines are redrawn only when they changed.
	const trails = createMemo(
		() =>
			(props.data()?.trackers ?? []).flatMap((tracker) =>
				tracker.trail && tracker.trail.length > 1 ? [{ color: tracker.color, path: tracker.trail }] : [],
			),
		undefined,
		{ equals: sameJson },
	);
	const overlay = createMemo(() => props.data()?.overlay ?? null, undefined, { equals: sameJson });
	/**
	 * The map moves by itself only where nobody is working on it: the selected
	 * map in the editor is the control for its own view, and ePaper cannot animate.
	 */
	const motion = () => {
		if (env.lowColor() || (edit && props.selectedId === props.el.id)) return "none";
		return props.el.motion;
	};

	// Effects created after an `await` have lost their owner; keep it to restore it.
	const owner = getOwner();
	onMount(async () => {
		try {
			const maplibre = await loadMapLibre();
			if (!container.isConnected) return;
			map = createMap(maplibre, container, {
				style: styleUrl(),
				center: center(),
				zoom: props.el.zoom,
				pitch: props.el.pitch,
				bearing: props.el.bearing,
				// A display is looked at, not touched; the editor decides with CSS
				// (only the selected map takes the pointer).
				interactive: Boolean(edit),
			});
			map.on("load", () => setReady(true));
			map.on("error", (event) => {
				if (!ready()) setFailure(event.error?.message ?? "the map could not load");
			});

			// True while the map is moved by us, to tell it from the user moving it.
			let applying = false;
			const apply = (move: () => void) => {
				if (gone) return;
				applying = true;
				try {
					move();
				} finally {
					applying = false;
				}
			};
			// Set while the map turns or travels by itself. Those movements arrive
			// over many frames, long after `apply` returned.
			let moving = false;
			let touring = false;
			/** The bearing the slow rotation has reached; undefined when the map does not turn. */
			let spin: number | undefined;

			const placeMarkers = () => {
				for (const marker of markers) marker.remove();
				markers = points().map((point) => {
					const element = document.createElement("div");
					element.className = "sd-map-marker";
					element.style.setProperty("--sd-marker", env.ink(point.color) || "#e5484d");
					if (props.el.labels && point.label) element.dataset.label = point.label;
					// Rows saved before markers had icons have none.
					const icon = markerIcon(point.icon);
					if (icon) {
						element.dataset.icon = "";
						const badge = document.createElement("span");
						badge.textContent = icon;
						element.append(badge);
					}
					// Trackers are placed by Home Assistant; only our own markers move.
					const draggable = Boolean(edit) && point.index >= 0;
					if (draggable) element.dataset.draggable = "";
					// A pin points at its place; a badge sits on it.
					const marker = new maplibre.Marker({ element, anchor: icon ? "center" : "bottom", draggable })
						.setLngLat([point.longitude, point.latitude])
						.addTo(map!);
					if (draggable) marker.on("dragend", () => setMarker(point.index, marker.getLngLat().wrap()));
					return marker;
				});
			};
			const frame = () => {
				// The tour decides where the map looks until it is stopped.
				if (touring) return;
				const all = points();
				const bearing = spin ?? props.el.bearing;
				if (props.el.fitMarkers && all.length > 1) {
					const bounds = new maplibre.LngLatBounds();
					for (const point of all) bounds.extend([point.longitude, point.latitude]);
					map!.fitBounds(bounds, {
						padding: 90,
						maxZoom: 16,
						animate: false,
						pitch: props.el.pitch,
						bearing,
					});
				} else if (props.el.fitMarkers && all.length === 1) {
					map!.jumpTo({ center: [all[0]!.longitude, all[0]!.latitude], zoom: props.el.zoom });
				} else {
					const [longitude, latitude] = center();
					const { zoom, pitch } = props.el;
					// Already there, as when the user's own movement comes back from
					// the editor: jumping to the rounded values would make the map twitch.
					const now = viewOf(map!);
					if (
						now.latitude === round(latitude, 5) &&
						now.longitude === round(longitude, 5) &&
						now.zoom === round(zoom, 2) &&
						now.pitch === round(pitch, 0) &&
						now.bearing === round(bearing, 0)
					)
						return;
					map!.jumpTo({ center: [longitude, latitude], zoom, pitch, bearing });
				}
			};
			// The stage is resized with a CSS transform, which MapLibre cannot see.
			const observer = new ResizeObserver(() =>
				apply(() => {
					map?.resize();
					// "Fit the markers" depends on the size of the map.
					frame();
				}),
			);
			observer.observe(container);

			// A new style takes everything we added to the old one with it. `drawn`
			// is what the current style holds; the effects below put it all back.
			const drawn = new Map<OverlayName, string[]>();
			map.on("style.load", () => {
				drawn.clear();
				setStyled((count) => count + 1);
			});
			const draw = (name: OverlayName, source: MapLibre.SourceSpecification | null, layers: OverlayLayer[] = []) => {
				try {
					for (const id of drawn.get(name) ?? []) if (map!.getLayer(id)) map!.removeLayer(id);
					if (map!.getSource(name)) map!.removeSource(name);
					drawn.delete(name);
					if (!source) return;
					// Kept under whatever is already drawn and belongs above it.
					const above = OVERLAYS.slice(OVERLAYS.indexOf(name) + 1).flatMap((other) => drawn.get(other) ?? [])[0];
					map!.addSource(name, source);
					for (const layer of layers) map!.addLayer({ ...layer, source: name } as MapLibre.AddLayerObject, above);
					drawn.set(
						name,
						layers.map((layer) => layer.id),
					);
				} catch (err) {
					// A tile address or a file MapLibre refuses must not take the map down.
					console.warn(`Map: ${name} could not be drawn`, err);
				}
			};
			const lineString = (coordinates: [number, number][], properties: Record<string, unknown> = {}) => ({
				type: "Feature" as const,
				properties,
				geometry: { type: "LineString" as const, coordinates },
			});

			if (edit) {
				map.on("move", () => {
					if (applying || moving || props.el.fitMarkers) return;
					const view = viewOf(map!);
					const [longitude, latitude] = center();
					// A map that follows the location from the settings keeps doing so
					// until it is moved away from it.
					const moved = view.latitude !== round(latitude, 5) || view.longitude !== round(longitude, 5);
					batch(() => {
						if (moved) {
							edit("latitude", view.latitude);
							edit("longitude", view.longitude);
						}
						edit("zoom", view.zoom);
						edit("pitch", view.pitch);
						edit("bearing", view.bearing);
					});
				});
				map.on("dblclick", (event) => {
					if ((event.originalEvent.target as Element).closest(".sd-map-marker")) return;
					const { lat, lng } = event.lngLat.wrap();
					edit("markers", [
						...props.el.markers,
						{ label: "", latitude: round(lat, 5), longitude: round(lng, 5), color: "#e5484d", icon: "" },
					]);
				});
			}

			runWithOwner(owner, () => {
				createEffect(placeMarkers);
				createEffect(() => apply(frame));
				createEffect(
					on(
						styleUrl,
						(style) => {
							setStyled(0);
							// Without the diff the style is loaded afresh and says when it is
							// there, which is when the overlays are drawn again.
							map!.setStyle(style, { diff: false });
						},
						{ defer: true },
					),
				);

				// A raster layer of the user's choosing, meant for traffic.
				createEffect(() => {
					if (!styled()) return;
					const tiles = props.el.trafficUrl.trim();
					const usable = /^https?:\/\//i.test(tiles) && ["{z}", "{x}", "{y}"].every((part) => tiles.includes(part));
					if (!usable) return draw("sd-traffic", null);
					draw("sd-traffic", { type: "raster", tiles: [tiles], tileSize: 256 }, [
						{
							id: "sd-traffic",
							type: "raster",
							paint: { "raster-opacity": untrack(() => props.el.trafficOpacity) / 100 },
						},
					]);
				});
				// Its own effect, so that the slider does not fetch every tile again.
				createEffect(() => {
					const opacity = props.el.trafficOpacity / 100;
					if (styled() && map!.getLayer("sd-traffic")) map!.setPaintProperty("sd-traffic", "raster-opacity", opacity);
				});

				createEffect(() => {
					if (!styled()) return;
					const data = overlay();
					if (!data) return draw("sd-overlay", null);
					const color = env.ink(props.el.geojsonColor) || "#e5484d";
					draw("sd-overlay", { type: "geojson", data: data as never }, [
						{
							id: "sd-overlay-fill",
							type: "fill",
							filter: ["==", ["geometry-type"], "Polygon"],
							// On paper a tint would dither into noise: outlines only.
							paint: { "fill-color": color, "fill-opacity": env.lowColor() ? 0 : 0.22 },
						},
						{
							id: "sd-overlay-line",
							type: "line",
							filter: ["!=", ["geometry-type"], "Point"],
							layout: { "line-join": "round", "line-cap": "round" },
							paint: { "line-color": color, "line-width": 3 },
						},
						{
							id: "sd-overlay-point",
							type: "circle",
							filter: ["==", ["geometry-type"], "Point"],
							paint: {
								"circle-radius": 7,
								"circle-color": color,
								"circle-stroke-color": "#ffffff",
								"circle-stroke-width": 2,
							},
						},
					]);
				});

				createEffect(() => {
					if (!styled()) return;
					const paths = trails();
					if (!paths.length) return draw("sd-trails", null);
					draw(
						"sd-trails",
						{
							type: "geojson",
							data: {
								type: "FeatureCollection",
								features: paths.map((t) => lineString(t.path, { color: env.ink(t.color) || "#3b82f6" })),
							},
						},
						[
							{
								id: "sd-trails",
								type: "line",
								layout: { "line-join": "round", "line-cap": "round" },
								paint: { "line-color": ["get", "color"], "line-width": 4, "line-opacity": env.lowColor() ? 1 : 0.75 },
							},
						],
					);
				});

				createEffect(() => {
					if (!styled()) return;
					const stops = placed().map((marker): [number, number] => [marker.longitude, marker.latitude]);
					if (!props.el.route || stops.length < 2) return draw("sd-route", null);
					draw("sd-route", { type: "geojson", data: lineString(stops) }, [
						{
							id: "sd-route",
							type: "line",
							// Dashes need flat ends, or they run into each other.
							layout: { "line-join": "round", "line-cap": props.el.routeDashed ? "butt" : "round" },
							paint: {
								"line-color": env.ink(props.el.routeColor) || "#3b82f6",
								"line-width": Math.max(1, props.el.routeWidth),
								...(props.el.routeDashed ? { "line-dasharray": [2, 1.5] } : {}),
							},
						},
					]);
				});

				createEffect(() => {
					const kind = motion();
					if (kind === "rotate") {
						const speed = props.el.rotateSpeed;
						if (!speed) return;
						moving = true;
						spin = map!.getBearing();
						let last = performance.now();
						let request = 0;
						const turn = (time: number) => {
							request = requestAnimationFrame(turn);
							// Thirty steps a second are smooth at these speeds and spare the device.
							if (time - last < 33) return;
							spin = (spin ?? 0) + ((time - last) / 60_000) * speed;
							last = time;
							apply(() => map!.setBearing(spin!));
						};
						request = requestAnimationFrame(turn);
						onCleanup(() => {
							cancelAnimationFrame(request);
							spin = undefined;
							moving = false;
							apply(frame);
						});
					}
					if (kind === "tour") {
						const seconds = Math.max(3, props.el.tourSeconds);
						moving = true;
						touring = true;
						let index = -1;
						const next = () => {
							const all = points();
							if (!all.length || gone) return;
							index = (index + 1) % all.length;
							map!.flyTo({
								center: [all[index]!.longitude, all[index]!.latitude],
								zoom: props.el.zoom,
								pitch: props.el.pitch,
								bearing: props.el.bearing,
								// Travelling takes part of each stop, never all of it.
								duration: Math.min(4000, seconds * 400),
							});
						};
						// Untracked: fresh tracker positions must not send the tour back to its start.
						untrack(next);
						const timer = setInterval(next, seconds * 1000);
						onCleanup(() => {
							clearInterval(timer);
							apply(() => map!.stop());
							touring = false;
							moving = false;
							apply(frame);
						});
					}
				});

				if (edit) {
					// When the view follows the markers there is nothing to navigate.
					createEffect(() => {
						const action = props.el.fitMarkers ? "disable" : "enable";
						for (const handler of [
							map!.dragPan,
							map!.scrollZoom,
							map!.dragRotate,
							map!.touchZoomRotate,
							map!.touchPitch,
						])
							handler[action]();
					});
					// A marker added in the form has no position yet (and 0 / 0 is not
					// drawn): start it in the middle of the view, ready to be dragged.
					createEffect(
						on(
							() => props.el.markers.length,
							(count, before) => {
								const added = props.el.markers[count - 1];
								if (before === undefined || count <= before || !added) return;
								if (added.latitude === 0 && added.longitude === 0) setMarker(count - 1, map!.getCenter().wrap());
							},
						),
					);
				}
				onCleanup(() => observer.disconnect());
			});
		} catch (err) {
			setFailure((err as Error).message);
		}
	});
	onCleanup(() => {
		gone = true;
		for (const marker of markers) marker.remove();
		map?.remove();
	});

	return (
		<div class="sd-map sd-media-frame">
			{/* The editor leaves a pointer that starts here to the element. */}
			<div ref={container} class="sd-map-canvas" data-own-pointer />
			<Show when={edit}>
				<div class="sd-map-hint">
					{props.el.fitMarkers
						? "The view follows the markers. Double-click to add a marker, drag a marker to move it."
						: "Drag to move, scroll to zoom, right-drag to rotate and tilt. Double-click to add a marker, drag a marker to move it."}
				</div>
			</Show>
			<Show when={failure()}>
				<Placeholder text="" error={`Map: ${failure()}`} />
			</Show>
			{/* A file that cannot be read is the editor's business, not the room's. */}
			<Show when={env.editing && !failure() && props.data()?.overlayError}>
				<Placeholder text="" error={`GeoJSON overlay: ${props.data()?.overlayError}`} />
			</Show>
		</div>
	);
}

// --------------------------------------------------------------------- radar

interface RadarIndex {
	host: string;
	radar?: { past?: RadarFrame[]; nowcast?: RadarFrame[] };
}
interface RadarFrame {
	/** Unix seconds. */
	time: number;
	path: string;
}
interface RadarLayer extends RadarFrame {
	id: string;
	tiles: string;
	forecast: boolean;
}

const RADAR_INDEX = "https://api.rainviewer.com/public/weather-maps.json";
/** RainViewer's free tiles stop at zoom 7; MapLibre stretches them beyond. */
const RADAR_MAX_ZOOM = 7;
/**
 * RainViewer allows 100 requests a minute from one address. Frames are fetched
 * one after the other at a rate that stays well below it, so that a second
 * screen behind the same router still gets its share.
 */
const RADAR_TILES_PER_MINUTE = 50;
/** Views of a frame fetched before: the browser has those tiles, so they cost RainViewer nothing. */
const radarFetched = new Set<string>();
let radarFreeAt = 0;
/**
 * Books the next turn to fetch a frame and returns how long to wait for it.
 * The queue is shared by every radar on the page: the limit is per address.
 */
function radarTurn(view: string, tiles: number): number {
	if (radarFetched.has(view)) return 0;
	radarFetched.add(view);
	const at = Math.max(Date.now(), radarFreeAt);
	radarFreeAt = at + (tiles / RADAR_TILES_PER_MINUTE) * 60_000;
	return at - Date.now();
}
/** The colours of RainViewer's only scheme, light rain to hail, for the legend. */
const RADAR_COLORS = [
	"#88ddee",
	"#00a3e0",
	"#0077aa",
	"#005588",
	"#ffee00",
	"#ffaa00",
	"#ff4400",
	"#c10000",
	"#ffaaff",
];
/**
 * RainViewer serves one colour scheme and lets its users restyle the tiles;
 * these do so with MapLibre's raster adjustments, and the legend with the
 * matching CSS filter.
 */
const RADAR_SCHEMES: Record<El<"radar">["scheme"], { paint: [saturation: number, contrast: number]; filter: string }> =
	{
		original: { paint: [0, 0], filter: "none" },
		vivid: { paint: [0.5, 0.2], filter: "saturate(1.6) contrast(1.2)" },
		muted: { paint: [-0.5, 0], filter: "saturate(0.5)" },
		grey: { paint: [-1, 0.1], filter: "grayscale(1) contrast(1.1)" },
	};

let radarIndex: { at: number; value: Promise<RadarIndex> } | undefined;
/** The list of frames, shared by every radar on the page and asked for at most every four minutes. */
function loadRadarIndex(): Promise<RadarIndex> {
	if (radarIndex && Date.now() - radarIndex.at < 240_000) return radarIndex.value;
	const value = fetch(RADAR_INDEX, { signal: AbortSignal.timeout(15_000) }).then(async (response) => {
		if (!response.ok) throw new Error(`RainViewer answered ${response.status}`);
		const index = (await response.json()) as RadarIndex;
		if (!/^https:\/\//.test(index.host ?? "")) throw new Error("RainViewer sent an unexpected answer");
		return index;
	});
	radarIndex = { at: Date.now(), value };
	value.catch(() => {
		radarIndex = undefined;
	});
	return value;
}

/**
 * The rain of the last hours, played in a loop over a map. The frames come
 * straight from RainViewer: they are public, so there is nothing for the
 * server to keep secret. On ePaper only the latest frame is shown.
 */
export function Radar(props: RendererProps<El<"radar">>) {
	const env = useDisplay();
	let container!: HTMLDivElement;
	let map: MapLibre.Map | undefined;
	let gone = false;
	const [failure, setFailure] = createSignal<string>();
	const [styled, setStyled] = createSignal(0);
	const [index, setIndex] = createSignal<RadarIndex>();
	/** Ids of the frames whose tiles have arrived. */
	const [loaded, setLoaded] = createSignal<string[]>([]);
	const [shown, setShown] = createSignal<RadarLayer>();

	const located = () =>
		props.el.latitude !== 0 ||
		props.el.longitude !== 0 ||
		env.general().latitude !== 0 ||
		env.general().longitude !== 0;
	const center = (): [number, number] => {
		const own = props.el.latitude !== 0 || props.el.longitude !== 0;
		return own ? [props.el.longitude, props.el.latitude] : [env.general().longitude, env.general().latitude];
	};
	const styleUrl = () => styleAddress(props.el.style, props.el.styleUrl);

	const frames = createMemo((): RadarLayer[] => {
		const data = index();
		const past = data?.radar?.past ?? [];
		const latest = past.at(-1);
		if (!data || !latest) return [];
		const options = `${props.el.smooth ? 1 : 0}_${props.el.snow ? 1 : 0}`;
		const layer = (frame: RadarFrame, forecast: boolean): RadarLayer => ({
			...frame,
			forecast,
			// The options are part of the id: changing them makes new layers.
			id: `sd-radar-${frame.path.replace(/[^a-z0-9]+/gi, "-")}-${options}`,
			tiles: `${data.host}${frame.path}/512/{z}/{x}/{y}/2/${options}.png`,
		});
		// Paper shows one picture: the latest, and nothing is fetched to animate.
		if (env.lowColor()) return [layer(latest, false)];
		const since = latest.time - Math.max(0, props.el.past) * 60;
		return [
			...past.filter((frame) => frame.time >= since).map((frame) => layer(frame, false)),
			...(props.el.forecast ? (data.radar?.nowcast ?? []).map((frame) => layer(frame, true)) : []),
		];
	});
	const scheme = () => RADAR_SCHEMES[props.el.scheme] ?? RADAR_SCHEMES.original;
	const timeLabel = () => {
		const frame = shown();
		if (!frame) return "";
		const { locale, hourCycle, timezone } = env.general();
		return timeFormatter(locale, hourCycle, timezone).format(frame.time * 1000);
	};

	const refresh = () =>
		loadRadarIndex().then(
			(data) => {
				setFailure(undefined);
				setIndex(data);
			},
			// A failed refresh keeps the frames that are on screen.
			(err: Error) => {
				if (!index()) setFailure(err.message);
			},
		);
	void refresh();
	const poll = setInterval(refresh, 300_000);
	onCleanup(() => clearInterval(poll));

	const owner = getOwner();
	onMount(async () => {
		try {
			const maplibre = await loadMapLibre();
			if (!container.isConnected) return;
			map = createMap(maplibre, container, {
				style: styleUrl(),
				center: center(),
				zoom: props.el.zoom,
				interactive: false,
			});
			map.on("error", (event) => {
				if (!styled()) setFailure(event.error?.message ?? "the map could not load");
			});
			const observer = new ResizeObserver(() => map?.resize());
			observer.observe(container);

			/** The frames the current style holds. */
			const onMap = new Set<string>();
			let run = 0;
			map.on("style.load", () => {
				onMap.clear();
				setLoaded([]);
				setStyled((count) => count + 1);
			});

			/** How many tiles one frame takes at this size and zoom, generously. */
			const tilesPerFrame = () => {
				const zoom = map!.getZoom();
				const size = 512 * 2 ** (zoom - Math.min(RADAR_MAX_ZOOM, Math.floor(zoom)));
				return (Math.ceil(container.clientWidth / size) + 1) * (Math.ceil(container.clientHeight / size) + 1);
			};
			const arrived = (id: string) =>
				new Promise<void>((resolve) => {
					const done = () => {
						clearTimeout(timer);
						map?.off("sourcedata", check);
						resolve();
					};
					const check = () => {
						if (gone || !map!.getSource(id) || map!.isSourceLoaded(id)) done();
					};
					// A frame that never arrives must not hold up the others.
					const timer = setTimeout(done, 20_000);
					map!.on("sourcedata", check);
				});
			const add = async (queue: RadarLayer[], mine: number) => {
				for (const frame of queue) {
					const view = `${frame.tiles}|${center()}|${props.el.zoom}|${container.clientWidth}x${container.clientHeight}`;
					const wait = radarTurn(view, tilesPerFrame());
					if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
					if (gone || mine !== run || !styled()) return;
					const [saturation, contrast] = scheme().paint;
					map!.addSource(frame.id, {
						type: "raster",
						tiles: [frame.tiles],
						tileSize: 512,
						maxzoom: RADAR_MAX_ZOOM,
						// RainViewer asks for this credit, with the link.
						attribution: '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>',
					});
					map!.addLayer({
						id: frame.id,
						type: "raster",
						source: frame.id,
						paint: {
							// Hidden, yet loading: the animation only switches frames that are complete.
							"raster-opacity": 0,
							"raster-opacity-transition": { duration: 0, delay: 0 },
							"raster-fade-duration": 0,
							"raster-saturation": saturation,
							"raster-contrast": contrast,
						},
					});
					onMap.add(frame.id);
					await arrived(frame.id);
					if (gone) return;
					if (onMap.has(frame.id)) setLoaded((ids) => [...ids, frame.id]);
				}
			};

			runWithOwner(owner, () => {
				createEffect(() => {
					const [longitude, latitude] = center();
					map!.jumpTo({ center: [longitude, latitude], zoom: props.el.zoom });
				});
				createEffect(
					on(
						styleUrl,
						(style) => {
							setStyled(0);
							map!.setStyle(style, { diff: false });
						},
						{ defer: true },
					),
				);

				// Keeps the layers on the map in step with the frames that are wanted.
				createEffect(() => {
					if (!styled()) return;
					const wanted = frames();
					const mine = ++run;
					for (const id of [...onMap]) {
						if (wanted.some((frame) => frame.id === id)) continue;
						if (map!.getLayer(id)) map!.removeLayer(id);
						if (map!.getSource(id)) map!.removeSource(id);
						onMap.delete(id);
					}
					setLoaded((ids) => ids.filter((id) => onMap.has(id)));
					// The newest first: it is the one to show while the others arrive.
					void add(wanted.filter((frame) => !onMap.has(frame.id)).reverse(), mine).catch((err: Error) =>
						console.warn("Radar: a frame could not be added", err),
					);
				});

				// Plays the frames that have arrived, oldest to newest, and rests on the last.
				createEffect(() => {
					const ids = loaded();
					const playable = frames().filter((frame) => ids.includes(frame.id));
					if (!playable.length) return setShown(undefined);
					const last = playable.length - 1;
					if (env.lowColor() || !last) return setShown(playable[last]);
					const every = Math.max(100, props.el.frameMs);
					let at = untrack(() => playable.findIndex((frame) => frame.id === shown()?.id));
					if (at < 0) at = last;
					setShown(playable[at]);
					let timer: ReturnType<typeof setTimeout>;
					const step = () => {
						at = (at + 1) % playable.length;
						setShown(playable[at]);
						timer = setTimeout(step, at === last ? every + 1500 : every);
					};
					timer = setTimeout(step, at === last ? every + 1500 : every);
					onCleanup(() => clearTimeout(timer));
				});

				createEffect(() => {
					if (!styled()) return;
					const current = shown()?.id;
					// Ink is either there or not: no half-transparent rain on paper.
					const opacity = env.lowColor() ? 1 : Math.min(100, Math.max(5, props.el.radarOpacity)) / 100;
					const [saturation, contrast] = scheme().paint;
					for (const id of loaded()) {
						if (!map!.getLayer(id)) continue;
						map!.setPaintProperty(id, "raster-opacity", id === current ? opacity : 0);
						map!.setPaintProperty(id, "raster-saturation", saturation);
						map!.setPaintProperty(id, "raster-contrast", contrast);
					}
				});
				onCleanup(() => observer.disconnect());
			});
		} catch (err) {
			setFailure((err as Error).message);
		}
	});
	onCleanup(() => {
		gone = true;
		map?.remove();
	});

	return (
		<div class="sd-map sd-radar sd-media-frame">
			<div ref={container} class="sd-map-canvas" />
			<Show when={props.el.showTime && timeLabel()}>
				<div class="sd-radar-time">
					{timeLabel()}
					<Show when={shown()?.forecast}>
						<span class="sd-radar-note">forecast</span>
					</Show>
				</div>
			</Show>
			<Show when={props.el.legend}>
				<div class="sd-radar-legend">
					<span>Light</span>
					<i
						style={{
							background: `linear-gradient(to right, ${RADAR_COLORS.join(", ")})`,
							filter: env.lowColor() ? "grayscale(1)" : scheme().filter,
						}}
					/>
					<span>Heavy</span>
				</div>
			</Show>
			<Show when={!located()}>
				<Placeholder text="Set a location here or in the settings" />
			</Show>
			<Show when={failure()}>
				<Placeholder text="" error={`Radar: ${failure()}`} />
			</Show>
		</div>
	);
}
