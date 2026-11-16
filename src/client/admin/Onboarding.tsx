/**
 * The setup guide shown on first run (and again from Settings): region and
 * formats, then the location, placed on a map. Fields start from what Home
 * Assistant and the browser can tell, so most people only have to confirm.
 */
import { LocateFixed, Search } from "lucide-solid";
import type * as MapLibre from "maplibre-gl";
import {
	batch,
	createEffect,
	createMemo,
	createResource,
	createSignal,
	For,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { createStore } from "solid-js/store";
import { timeFormatter } from "../../shared/time";
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettings, type Place, type SetupInfo } from "../../shared/types";
import { loadMapLibre, MAP_STYLES } from "../display/elements/info";
import { api } from "../lib/api";
import { refetchSettings } from "./state";
import { attempt, FormField, toast } from "./ui";

// ------------------------------------------------------------------ guesses

const LOCALES = [
	"ar-EG",
	"ar-SA",
	"bg-BG",
	"cs-CZ",
	"da-DK",
	"de-AT",
	"de-CH",
	"de-DE",
	"el-GR",
	"en-AU",
	"en-CA",
	"en-GB",
	"en-IE",
	"en-IN",
	"en-NZ",
	"en-US",
	"es-AR",
	"es-ES",
	"es-MX",
	"et-EE",
	"fi-FI",
	"fr-BE",
	"fr-CA",
	"fr-CH",
	"fr-FR",
	"he-IL",
	"hi-IN",
	"hr-HR",
	"hu-HU",
	"id-ID",
	"is-IS",
	"it-IT",
	"ja-JP",
	"ko-KR",
	"lt-LT",
	"lv-LV",
	"nb-NO",
	"nl-BE",
	"nl-NL",
	"pl-PL",
	"pt-BR",
	"pt-PT",
	"ro-RO",
	"ru-RU",
	"sk-SK",
	"sl-SI",
	"sr-RS",
	"sv-SE",
	"th-TH",
	"tr-TR",
	"uk-UA",
	"vi-VN",
	"zh-CN",
	"zh-TW",
];

/** Countries that write temperatures in Fahrenheit. */
const FAHRENHEIT = new Set(["US", "BS", "BZ", "KY", "PW", "LR", "FM", "MH"]);

const attemptOr = <T,>(read: () => T, fallback: T): T => {
	try {
		return read();
	} catch {
		return fallback;
	}
};

const localeName = (code: string) =>
	attemptOr(() => new Intl.DisplayNames(["en"], { type: "language" }).of(code), undefined) ?? code;

/** What the browser tells without asking the user anything. */
function browserGuess(): Partial<GeneralSettings> {
	const locale = attemptOr(() => Intl.getCanonicalLocales(navigator.language)[0], undefined);
	const region = locale && attemptOr(() => new Intl.Locale(locale).maximize().region, undefined);
	return {
		...(locale ? { locale } : {}),
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
		temperatureUnit: region && FAHRENHEIT.has(region) ? "f" : "c",
	};
}

const hasLocation = (at: { latitude: number; longitude: number }) => at.latitude !== 0 || at.longitude !== 0;
/** About one metre, which is as exact as a pin can be dropped. */
const round = (value: number) => Number(value.toFixed(5)) + 0;

// ---------------------------------------------------------------------- map

/**
 * A map with one pin: click to drop it, drag to adjust. Coordinates changed
 * from outside (search, typed numbers) move the pin and the view.
 */
function LocationPicker(props: {
	latitude: number;
	longitude: number;
	/** How close to show a position that was set from outside. */
	zoom: number;
	onPick: (latitude: number, longitude: number) => void;
}) {
	let container!: HTMLDivElement;
	let library: typeof MapLibre | undefined;
	let map: MapLibre.Map | undefined;
	let marker: MapLibre.Marker | undefined;
	const [ready, setReady] = createSignal(false);
	const [failed, setFailed] = createSignal(false);

	const pin = (at: [number, number]) => {
		if (marker) return marker.setLngLat(at);
		const element = document.createElement("div");
		element.className = "sd-map-marker";
		element.style.setProperty("--sd-marker", "#e5484d");
		element.style.cursor = "grab";
		const created = new library!.Marker({ element, anchor: "bottom", draggable: true }).setLngLat(at).addTo(map!);
		created.on("dragend", () => {
			const { lat, lng } = created.getLngLat().wrap();
			props.onPick(round(lat), round(lng));
		});
		marker = created;
	};

	onMount(async () => {
		try {
			library = await loadMapLibre();
			if (!container.isConnected) return;
			const start = hasLocation(props);
			map = new library.Map({
				container,
				style: MAP_STYLES.liberty!,
				center: start ? [props.longitude, props.latitude] : [10, 25],
				zoom: start ? props.zoom : 1,
				attributionControl: { compact: true },
			});
			map.addControl(new library.NavigationControl({ showCompass: false }), "top-right");
			map.getCanvas().style.cursor = "crosshair";
			let loaded = false;
			map.on("load", () => {
				loaded = true;
			});
			map.on("error", () => {
				if (!loaded) setFailed(true);
			});
			map.on("click", (event) => {
				const { lat, lng } = event.lngLat.wrap();
				// The pin goes first, so the position coming back is not taken for an outside change.
				pin([lng, lat]);
				props.onPick(round(lat), round(lng));
			});
			setReady(true);
		} catch {
			setFailed(true);
		}
	});
	onCleanup(() => map?.remove());

	createEffect(() => {
		const { latitude, longitude, zoom } = props;
		if (!ready() || !map) return;
		if (!hasLocation({ latitude, longitude })) {
			marker?.remove();
			marker = undefined;
			return;
		}
		const at = marker?.getLngLat();
		// Our own pin, dropped or dragged by the user: the view stays where they put it.
		if (at && round(at.lat) === latitude && round(at.lng) === longitude) return;
		pin([longitude, latitude]);
		map.flyTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), zoom), duration: 1200 });
	});

	return (
		<div class="relative h-80 overflow-hidden rounded-lg border border-line bg-raised">
			{/* Sized, not pinned: MapLibre's stylesheet makes its container `position: relative`. */}
			<div ref={container} class="size-full" />
			<Show when={failed()}>
				<div class="absolute inset-0 flex items-center justify-center bg-raised p-6 text-center text-sm text-muted">
					The map could not load. You can still search for a place or type the coordinates below.
				</div>
			</Show>
		</div>
	);
}

// -------------------------------------------------------------------- guide

const STEPS = ["Region", "Location"];

export function Onboarding(props: { onDone: () => void }) {
	const [info] = createResource(() => api<SetupInfo>("api/onboarding"));
	const [general, setGeneral] = createStore<GeneralSettings>({ ...DEFAULT_GENERAL_SETTINGS });
	const [started, setStarted] = createSignal(false);
	const [step, setStep] = createSignal(0);
	const [busy, setBusy] = createSignal(false);
	const [otherLocale, setOtherLocale] = createSignal(false);
	const [zoom, setZoom] = createSignal(13);
	/** Where the pre-filled location came from, when it is only a starting point. */
	const [hint, setHint] = createSignal("");
	/** Time zone of the place last chosen, to offer it when it differs from step one. */
	const [placeZone, setPlaceZone] = createSignal("");
	const firstRun = () => info()?.needed ?? false;
	const fromHa = () => firstRun() && Object.keys(info()?.suggested ?? {}).length > 0;

	const moveTo = (latitude: number, longitude: number, closeness: number) =>
		batch(() => {
			setZoom(closeness);
			setGeneral({ latitude: round(latitude), longitude: round(longitude) });
		});

	// ------------------------------------------------------------ pre-filling
	createEffect(
		on(info, (data) => {
			if (!data || started()) return;
			// A first run starts from guesses; a later visit from what is saved.
			setGeneral(data.needed ? { ...data.general, ...browserGuess(), ...data.suggested } : data.general);
			setOtherLocale(!LOCALES.includes(general.locale));
			setStarted(true);
			if (hasLocation(general)) {
				if (data.needed)
					setHint("This is the location of your Home Assistant. Drag the pin if the screens are elsewhere.");
			} else void guessLocation();
		}),
	);
	// An unreachable server must not leave the guide blank.
	createEffect(() => {
		if (info.error && !started()) {
			setGeneral(browserGuess());
			setStarted(true);
		}
	});

	const search = (query: string, signal?: AbortSignal) =>
		api<Place[]>(`api/places?q=${encodeURIComponent(query)}&language=${encodeURIComponent(general.locale)}`, {
			signal,
		});

	/** Without a known location: the browser's if it was already allowed, else the city the time zone is named after. */
	async function guessLocation() {
		const permission = await navigator.permissions?.query({ name: "geolocation" }).catch(() => null);
		if (permission?.state === "granted") return locate(true);
		const zone = general.timezone;
		const city = zone.includes("/") && !zone.startsWith("Etc/") ? zone.split("/").pop()!.replaceAll("_", " ") : "";
		if (!city) return;
		const match = (await search(city).catch(() => [])).find((place) => place.timezone === zone);
		// The user may have placed the pin while this was looked up.
		if (!match || hasLocation(general)) return;
		moveTo(match.latitude, match.longitude, 10);
		setGeneral("locationName", match.name);
		setHint(`Guessed from your time zone (${zone}). Search, or drag the pin to where the screens are.`);
	}

	function locate(quiet = false) {
		navigator.geolocation?.getCurrentPosition(
			(position) => {
				moveTo(position.coords.latitude, position.coords.longitude, 15);
				setHint("");
			},
			() => quiet || toast("The browser did not share a location.", "error"),
			{ enableHighAccuracy: true, timeout: 10_000 },
		);
	}

	// ----------------------------------------------------------- step: region
	const [now, setNow] = createSignal(new Date());
	const ticker = setInterval(() => setNow(new Date()), 1000);
	onCleanup(() => clearInterval(ticker));

	const regionValid = createMemo(() =>
		attemptOr(() => {
			new Intl.DateTimeFormat(general.locale || undefined, { timeZone: general.timezone || undefined });
			return true;
		}, false),
	);
	const dateIn = (style: "full" | "short") =>
		new Intl.DateTimeFormat(general.locale || undefined, {
			dateStyle: style,
			timeZone: general.timezone || undefined,
		}).format(now());
	const sample = createMemo(() =>
		attemptOr(
			() => ({
				time: timeFormatter(general.locale, general.hourCycle, general.timezone).format(now()),
				date: dateIn("full"),
				short: dateIn("short"),
				temperature: new Intl.NumberFormat(general.locale || undefined, { maximumFractionDigits: 0 }).format(
					general.temperatureUnit === "f" ? 70 : 21,
				),
			}),
			null,
		),
	);

	const locales = createMemo(() =>
		[...new Set([...LOCALES, ...(otherLocale() ? [] : [general.locale])])]
			.filter(Boolean)
			.map((code) => ({ code, name: localeName(code) }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	);
	const zones = createMemo(() => {
		const all = attemptOr(() => Intl.supportedValuesOf("timeZone"), [] as string[]);
		// The list has no plain UTC, and may not know a zone that was saved earlier.
		return [...new Set(["UTC", ...all, ...(general.timezone ? [general.timezone] : [])])].sort();
	});
	const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

	// --------------------------------------------------------- step: location
	const [query, setQuery] = createSignal("");
	const [results, setResults] = createSignal<Place[] | null>(null);
	let pending: AbortController | undefined;
	let debounce: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => {
		clearTimeout(debounce);
		pending?.abort();
	});

	const lookUp = async () => {
		clearTimeout(debounce);
		pending?.abort();
		if (query().trim().length < 2) return setResults(null);
		const request = new AbortController();
		pending = request;
		try {
			const found = await search(query(), request.signal);
			if (!request.signal.aborted) setResults(found);
		} catch (err) {
			if (!request.signal.aborted) toast((err as Error).message, "error");
		}
	};
	const typed = (text: string) => {
		setQuery(text);
		clearTimeout(debounce);
		debounce = setTimeout(lookUp, 350);
	};
	const choose = (place: Place) => {
		moveTo(place.latitude, place.longitude, 12);
		setGeneral("locationName", place.name);
		setPlaceZone(place.timezone);
		setHint("Drag the pin, or click the map, to mark the exact spot.");
		setQuery("");
		setResults(null);
	};
	const coordinate = (key: "latitude" | "longitude", text: string, limit: number) => {
		const value = Number(text);
		if (!Number.isFinite(value) || Math.abs(value) > limit) return;
		batch(() => {
			setZoom(13);
			setGeneral(key, round(value));
		});
		setHint("");
	};

	// ----------------------------------------------------------------- ending
	const finish = async () => {
		setBusy(true);
		const saved = await attempt(
			() => api("api/settings/general", { method: "PUT", body: { ...general } }),
			firstRun() ? "All set. Create your first display to get started." : "Settings saved. Screens are updating.",
		);
		setBusy(false);
		if (!saved) return;
		void refetchSettings();
		props.onDone();
	};
	const leave = async () => {
		if (firstRun()) await attempt(() => api("api/onboarding/skip", { method: "POST" }));
		props.onDone();
	};

	return (
		<div class="flex min-h-full items-start justify-center overflow-y-auto p-4 md:items-center">
			<Show when={started()}>
				<div class="card w-full max-w-2xl space-y-5 p-6">
					<div class="flex items-center justify-between gap-4">
						<div class="flex items-center gap-2.5">
							<img src="./favicon.svg" alt="" class="size-8" />
							<span class="text-lg font-bold tracking-tight">SideDisplay</span>
						</div>
						<ol class="flex items-center gap-3 text-xs font-semibold text-muted">
							<For each={STEPS}>
								{(name, index) => (
									<li
										class="flex items-center gap-1.5"
										classList={{ "text-ink": step() === index() }}
										aria-current={step() === index() ? "step" : undefined}
									>
										<span
											class="flex size-5 items-center justify-center rounded-full border border-line"
											classList={{ "!border-transparent bg-accent-bg text-accent-ink": step() >= index() }}
										>
											{index() + 1}
										</span>
										{name}
									</li>
								)}
							</For>
						</ol>
					</div>

					<Show when={step() === 0}>
						<div>
							<h1 class="text-xl font-semibold">
								{firstRun() ? "Welcome! Let's set up your displays" : "Region and formats"}
							</h1>
							<p class="mt-1 text-sm text-muted">
								How dates, times and temperatures are written on every screen.
								<Show when={firstRun()}>
									{" "}
									We filled this in from {fromHa() ? "your Home Assistant and " : ""}this browser; change anything that
									is not right.
								</Show>
							</p>
						</div>

						<div class="rounded-lg border border-line bg-raised px-4 py-3" aria-live="off">
							<div class="section-title">How it will look</div>
							<Show when={sample()} fallback={<p class="mt-1 text-sm text-danger">This language code is not known.</p>}>
								{(s) => (
									<>
										<div class="mt-1 text-3xl font-semibold tabular-nums">{s().time}</div>
										<div class="text-sm">{s().date}</div>
										<div class="mt-0.5 text-xs text-muted">
											{s().short} · {s().temperature} °{general.temperatureUnit.toUpperCase()}
										</div>
									</>
								)}
							</Show>
						</div>

						<div class="grid gap-3 sm:grid-cols-2">
							<FormField label="Language and format" help="Sets the names of days and months and the order of dates.">
								<select
									class="input"
									value={otherLocale() ? "" : general.locale}
									onChange={(e) => {
										setOtherLocale(!e.currentTarget.value);
										if (e.currentTarget.value) setGeneral("locale", e.currentTarget.value);
									}}
								>
									<For each={locales()}>
										{(locale) => (
											<option value={locale.code}>
												{locale.name} ({locale.code})
											</option>
										)}
									</For>
									<option value="">Other…</option>
								</select>
								<Show when={otherLocale()}>
									<input
										class="input mt-2"
										value={general.locale}
										placeholder="A locale code such as en-GB"
										aria-label="Locale code"
										onInput={(e) => setGeneral("locale", e.currentTarget.value.trim())}
									/>
								</Show>
							</FormField>
							<FormField
								label="Time zone"
								help={
									general.timezone && general.timezone !== browserZone
										? `This browser is in ${browserZone}.`
										: "Screens show this time even if their own clock is set differently."
								}
							>
								<select
									class="input"
									value={general.timezone}
									onChange={(e) => setGeneral("timezone", e.currentTarget.value)}
								>
									<option value="">Each screen's own time zone</option>
									<For each={zones()}>{(zone) => <option value={zone}>{zone.replaceAll("_", " ")}</option>}</For>
								</select>
							</FormField>
							<FormField label="Clock">
								<select
									class="input"
									value={general.hourCycle}
									onChange={(e) => setGeneral("hourCycle", e.currentTarget.value as GeneralSettings["hourCycle"])}
								>
									<option value="auto">Follow the language</option>
									<option value="24">24-hour (16:30)</option>
									<option value="12">12-hour (4:30 PM)</option>
								</select>
							</FormField>
							<FormField label="Temperature">
								<select
									class="input"
									value={general.temperatureUnit}
									onChange={(e) =>
										setGeneral("temperatureUnit", e.currentTarget.value as GeneralSettings["temperatureUnit"])
									}
								>
									<option value="c">Celsius (°C)</option>
									<option value="f">Fahrenheit (°F)</option>
								</select>
							</FormField>
						</div>
					</Show>

					<Show when={step() === 1}>
						<div>
							<h1 class="text-xl font-semibold">Where are your screens?</h1>
							<p class="mt-1 text-sm text-muted">
								The default place for weather and maps. Search for your town, then click the map or drag the pin to the
								exact spot.
							</p>
						</div>

						<div class="space-y-2">
							<div class="flex gap-2">
								<div class="relative min-w-0 flex-1">
									<Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
									<input
										class="input !pl-8"
										type="search"
										placeholder="Search for a town or postcode"
										aria-label="Search for a place"
										value={query()}
										onInput={(e) => typed(e.currentTarget.value)}
										onKeyDown={(e) => {
											if (e.key !== "Enter") return;
											const first = results()?.[0];
											if (first) choose(first);
											else void lookUp();
										}}
									/>
								</div>
								<Show when={window.isSecureContext && "geolocation" in navigator}>
									<button type="button" class="btn shrink-0" onClick={() => locate()}>
										<LocateFixed />
										Use my location
									</button>
								</Show>
							</div>
							<Show when={results()}>
								{(found) => (
									<ul class="overflow-hidden rounded-lg border border-line">
										<For each={found()} fallback={<li class="px-3 py-2 text-sm text-muted">No place by that name.</li>}>
											{(place) => (
												<li class="border-line not-last:border-b">
													<button
														type="button"
														class="flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-raised"
														onClick={() => choose(place)}
													>
														<span class="font-medium">{place.name}</span>
														<span class="truncate text-xs text-muted">
															{[place.region, place.country].filter(Boolean).join(", ")}
														</span>
													</button>
												</li>
											)}
										</For>
									</ul>
								)}
							</Show>
						</div>

						<LocationPicker
							latitude={general.latitude}
							longitude={general.longitude}
							zoom={zoom()}
							onPick={(latitude, longitude) => {
								setGeneral({ latitude, longitude });
								setHint("");
							}}
						/>
						<p class="help !mt-2">
							{hasLocation(general)
								? hint() || "Click the map or drag the pin to adjust."
								: "No location yet. Search above, or click the map to drop a pin."}
						</p>

						<Show when={placeZone() && general.timezone && placeZone() !== general.timezone}>
							<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-raised px-3 py-2 text-sm">
								<span>
									This place is in {placeZone().replaceAll("_", " ")}, but the time zone is set to{" "}
									{general.timezone.replaceAll("_", " ")}.
								</span>
								<button type="button" class="btn" onClick={() => setGeneral("timezone", placeZone())}>
									Use {placeZone().replaceAll("_", " ")}
								</button>
							</div>
						</Show>

						<div class="grid gap-3 sm:grid-cols-3">
							<FormField label="Place name" help="Shown with the weather.">
								<input
									class="input"
									value={general.locationName}
									placeholder="Budapest"
									maxLength={120}
									onInput={(e) => setGeneral("locationName", e.currentTarget.value)}
								/>
							</FormField>
							<FormField label="Latitude">
								<input
									class="input"
									type="number"
									step="0.00001"
									min="-90"
									max="90"
									value={general.latitude}
									onChange={(e) => coordinate("latitude", e.currentTarget.value, 90)}
								/>
							</FormField>
							<FormField label="Longitude">
								<input
									class="input"
									type="number"
									step="0.00001"
									min="-180"
									max="180"
									value={general.longitude}
									onChange={(e) => coordinate("longitude", e.currentTarget.value, 180)}
								/>
							</FormField>
						</div>
					</Show>

					<div class="flex items-center gap-2 border-t border-line pt-4">
						<button type="button" class="btn btn-ghost text-muted" onClick={leave}>
							{firstRun() ? "Skip for now" : "Cancel"}
						</button>
						<div class="flex-1" />
						<Show when={step() > 0}>
							<button type="button" class="btn" onClick={() => setStep(step() - 1)}>
								Back
							</button>
						</Show>
						<Show
							when={step() === STEPS.length - 1}
							fallback={
								<button
									type="button"
									class="btn btn-primary"
									disabled={!regionValid()}
									onClick={() => setStep(step() + 1)}
								>
									Continue
								</button>
							}
						>
							<button type="button" class="btn btn-primary" disabled={busy()} onClick={finish}>
								{hasLocation(general) ? "Finish" : "Finish without a location"}
							</button>
						</Show>
					</div>
				</div>
			</Show>
		</div>
	);
}
