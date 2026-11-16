import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import type { AlertsData, EnergyData, EntityData, PresenceData } from "../../../shared/data";
import type { El } from "../../../shared/elements";
import type { AnyEl } from "../../../shared/types";
import { url } from "../../lib/api";
import { px, useDisplay } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";
import { Picture } from "../Picture";
import { DIAL_ARC, dialPoint, spoke, usePicture, WarningMark } from "./ha";

/** `"on=Open, off=Closed"` → { on: "Open", off: "Closed" }. */
function renames(text: string): Record<string, string> {
	const map: Record<string, string> = {};
	for (const pair of text.split(",")) {
		const [from, ...to] = pair.split("=");
		if (from?.trim() && to.length) map[from.trim().toLowerCase()] = to.join("=").trim();
	}
	return map;
}
const tidy = (state: string) => state.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

// ------------------------------------------------------------------- energy

/** Watts as a short reading: W below a kilowatt, kW above. */
export function formatPower(watts: number, locale: string): { value: string; unit: string } {
	const size = Math.abs(watts);
	const format = (n: number, digits: number) =>
		new Intl.NumberFormat(locale || undefined, { maximumFractionDigits: digits }).format(n);
	if (size >= 1_000_000) return { value: format(size / 1_000_000, 2), unit: "MW" };
	if (size >= 1000) return { value: format(size / 1000, size >= 10_000 ? 1 : 2), unit: "kW" };
	return { value: format(size, 0), unit: "W" };
}

/** Below this nothing is said to flow: inverters and meters idle at a few watts. */
const IDLE_WATTS = 10;

const ENERGY_ICONS = {
	solar:
		"M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
	grid: "M13 2 4 14h7l-1 8 9-12h-7Z",
	battery: "M10 3h4M8 6h8a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z",
	home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z",
} as const;
type EnergyRole = keyof typeof ENERGY_ICONS;

function EnergyIcon(props: { role: EnergyRole; x: number; y: number; size: number }) {
	return (
		<path
			d={ENERGY_ICONS[props.role]}
			transform={`translate(${props.x - props.size / 2} ${props.y - props.size / 2}) scale(${props.size / 24})`}
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	);
}

export function HaEnergy(props: RendererProps<El<"ha-energy">, EnergyData>) {
	const env = useDisplay();
	const configured = () =>
		Boolean(props.el.solarEntity || props.el.gridEntity || props.el.batteryEntity || props.el.homeEntity);
	// The hub sits where the four branches meet; a node without an entity is left out.
	const HUB = { x: 160, y: 110 };
	const R = 31;
	const nodes = createMemo(() => {
		const data = props.data();
		if (!data) return [];
		const node = (role: EnergyRole, x: number, y: number, watts: number | null, color: string, toHub: number) => ({
			role,
			x,
			y,
			watts,
			color: env.ink(color) || "var(--sd-fg)",
			// +1 flows towards the hub, -1 away from it, 0 stands still.
			flow: watts === null || Math.abs(watts) < IDLE_WATTS ? 0 : Math.sign(watts) * toHub,
		});
		return [
			...(props.el.solarEntity ? [node("solar", 160, 36, data.solar, props.el.solarColor, 1)] : []),
			...(props.el.gridEntity ? [node("grid", 40, 110, data.grid, props.el.gridColor, 1)] : []),
			...(props.el.batteryEntity ? [node("battery", 160, 184, data.battery, props.el.batteryColor, 1)] : []),
			node("home", 280, 110, data.home, "", -1),
		];
	});
	const power = (watts: number | null) => (watts === null ? null : formatPower(watts, env.general().locale));
	const energy = (value: number) =>
		new Intl.NumberFormat(env.general().locale || undefined, { maximumFractionDigits: value >= 100 ? 0 : 1 }).format(
			value,
		);
	return (
		<div class="sd-energy" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<Show
				when={configured() && props.data()}
				fallback={
					<Placeholder
						text={configured() ? "Waiting for Home Assistant…" : "Choose the power sensors"}
						error={props.error()}
					/>
				}
			>
				<svg class="sd-energy-flow" viewBox="0 0 320 220" role="img" aria-label="Energy flow">
					<For each={nodes()}>
						{(n) => {
							// From the rim of the node to the hub, so a dash offset moving forward flows inwards.
							const dx = Math.sign(HUB.x - n.x);
							const dy = Math.sign(HUB.y - n.y);
							const from = { x: n.x + dx * R, y: n.y + dy * R };
							const middle = { x: (from.x + HUB.x) / 2, y: (from.y + HUB.y) / 2 };
							// The arrow is drawn pointing right, then turned to where the energy goes.
							const angle = () => (Math.atan2(dy * n.flow, dx * n.flow) * 180) / Math.PI;
							return (
								<g style={{ color: n.color }}>
									<path
										class="sd-energy-line"
										d={`M${from.x} ${from.y}L${HUB.x} ${HUB.y}`}
										classList={{ "sd-energy-idle": n.flow === 0 }}
									/>
									<Show when={n.flow !== 0}>
										<Show
											when={!env.lowColor()}
											fallback={
												<path
													d="M-7 -7 7 0 -7 7Z"
													fill="currentColor"
													transform={`translate(${middle.x} ${middle.y}) rotate(${angle()})`}
												/>
											}
										>
											<path
												class="sd-energy-dots"
												classList={{ "sd-energy-out": n.flow < 0 }}
												d={`M${from.x} ${from.y}L${HUB.x} ${HUB.y}`}
											/>
										</Show>
									</Show>
								</g>
							);
						}}
					</For>
					<circle cx={HUB.x} cy={HUB.y} r="4" fill="var(--sd-fg)" />
					<For each={nodes()}>
						{(n) => (
							<g>
								<circle class="sd-energy-node" cx={n.x} cy={n.y} r={R} style={{ stroke: n.color }} />
								<g style={{ color: n.color }}>
									<EnergyIcon role={n.role} x={n.x} y={n.y - 11} size={17} />
								</g>
								<Show
									when={power(n.watts)}
									fallback={
										<text x={n.x} y={n.y + 14} class="sd-energy-value">
											–
										</text>
									}
								>
									{(p) => (
										<text x={n.x} y={n.y + 14} class="sd-energy-value">
											{p().value}
											<tspan class="sd-energy-unit"> {p().unit}</tspan>
										</text>
									)}
								</Show>
								<Show when={n.role === "battery" && props.data()?.level !== null}>
									<text x={n.x + R + 6} y={n.y + 4} class="sd-energy-level">
										{Math.round(props.data()?.level ?? 0)} %
									</text>
								</Show>
							</g>
						)}
					</For>
				</svg>
				<Show when={props.el.totals && props.data()?.totals.length}>
					<div class="sd-energy-totals">
						<For each={props.data()?.totals}>
							{(total) => (
								<span>
									<svg viewBox="0 0 24 24" aria-hidden="true">
										<EnergyIcon
											role={total.key === "solar" ? "solar" : total.key === "home" ? "home" : "grid"}
											x={12}
											y={12}
											size={24}
										/>
									</svg>
									{total.key === "import" ? "↓ " : total.key === "export" ? "↑ " : ""}
									{energy(total.value)}
									<span class="sd-entity-unit">{total.unit}</span>
								</span>
							)}
						</For>
					</div>
				</Show>
			</Show>
		</div>
	);
}

// ------------------------------------------------------------------ climate

export function HaClimate(props: RendererProps<El<"ha-climate">, EntityData>) {
	const env = useDisplay();
	const state = () => props.data()?.state;
	const attribute = (key: string) => {
		const value = state()?.attributes[key];
		const n =
			typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
		return Number.isFinite(n) ? n : null;
	};
	const degrees = (value: number) => {
		const precision = Math.max(0, props.el.precision);
		return `${new Intl.NumberFormat(env.general().locale || undefined, {
			minimumFractionDigits: precision,
			maximumFractionDigits: precision,
		}).format(value)}°`;
	};
	const current = () => attribute("current_temperature");
	const off = () => state()?.state === "off" || state()?.state === "unavailable";
	/** One set point, or the two of a heat/cool range. */
	const target = () => {
		if (off()) return null;
		const single = attribute("temperature");
		if (single !== null) return degrees(single);
		const low = attribute("target_temp_low");
		const high = attribute("target_temp_high");
		return low !== null && high !== null ? `${degrees(low)} – ${degrees(high)}` : null;
	};
	/** What the device is doing right now; thermostats that do not say fall back to their mode. */
	const action = () => {
		const s = state();
		if (!s) return "";
		const reported = s.attributes.hvac_action;
		return typeof reported === "string" && reported ? reported : s.state;
	};
	const actionColor = () => {
		const a = action();
		if (a === "heating" || a === "preheating" || a === "heat") return env.ink(props.el.heatColor);
		if (a === "cooling" || a === "cool") return env.ink(props.el.coolColor);
		return "";
	};
	const actionText = () => renames(props.el.stateMap)[action().toLowerCase()] ?? tidy(action());
	const dial = createMemo(() => {
		const min = attribute("min_temp") ?? 7;
		const max = attribute("max_temp") ?? 35;
		const along = (v: number | null) =>
			v === null || max <= min ? null : Math.min(1, Math.max(0, (v - min) / (max - min)));
		const set = off() ? null : (attribute("temperature") ?? attribute("target_temp_high"));
		return { target: along(set), current: along(current()) };
	});
	const details = () => (
		<div class="sd-climate-details">
			<Show when={target()}>
				<span class="sd-climate-target">→ {target()}</span>
			</Show>
			<Show when={props.el.mode && action()}>
				<span class="sd-climate-action" style={{ color: actionColor() || undefined }}>
					{actionText()}
				</span>
			</Show>
			<Show when={props.el.humidity && attribute("current_humidity") !== null}>
				<span>{Math.round(attribute("current_humidity") ?? 0)} %</span>
			</Show>
		</div>
	);
	return (
		<Show
			when={state()}
			fallback={
				<Placeholder
					text={props.el.entity ? `Waiting for ${props.el.entity}…` : "Choose a thermostat"}
					error={props.error()}
				/>
			}
		>
			{(s) => (
				<div class="sd-climate" style={{ "font-size": px(props.el.size) }} data-dial={props.el.dial ? "" : undefined}>
					<Show
						when={props.el.dial}
						fallback={
							<>
								<div class="sd-climate-label">{props.el.label || s().name}</div>
								<div class="sd-climate-current">{current() === null ? "–" : degrees(current() ?? 0)}</div>
								{details()}
							</>
						}
					>
						<div class="sd-gauge-dial sd-climate-dial">
							<svg viewBox="0 0 100 78" role="img" aria-label="Thermostat">
								<g transform="rotate(150 50 50)" fill="none" stroke-width="7" stroke-linecap="round">
									<circle
										class="sd-dial-track"
										cx="50"
										cy="50"
										r="40"
										stroke="var(--sd-line)"
										stroke-dasharray={`${DIAL_ARC} 400`}
									/>
									<Show when={dial().target !== null}>
										<circle
											cx="50"
											cy="50"
											r="40"
											stroke={actionColor() || "var(--sd-muted)"}
											stroke-dasharray={`${DIAL_ARC * (dial().target ?? 0)} 400`}
										/>
									</Show>
								</g>
								<Show when={dial().current !== null}>
									{/* A dot in colour; on ePaper, where it would vanish into the black arc, a line across it. */}
									<Show
										when={!env.lowColor()}
										fallback={
											<path
												d={spoke(dial().current ?? 0, 28, 48)}
												stroke="var(--sd-fg)"
												stroke-width="3"
												stroke-linecap="round"
											/>
										}
									>
										<circle
											cx={dialPoint(dial().current ?? 0, 40)[0]}
											cy={dialPoint(dial().current ?? 0, 40)[1]}
											r="5.5"
											fill="var(--sd-fg)"
											stroke="var(--sd-line)"
											stroke-width="1.5"
										/>
									</Show>
								</Show>
							</svg>
							<div class="sd-gauge-reading">
								<div class="sd-climate-current">{current() === null ? "–" : degrees(current() ?? 0)}</div>
							</div>
						</div>
						{details()}
						<div class="sd-climate-label">{props.el.label || s().name}</div>
					</Show>
				</div>
			)}
		</Show>
	);
}

// ----------------------------------------------------------------- presence

function initials(name: string): string {
	const words = name.trim().split(/\s+/).filter(Boolean);
	const letters = words.length > 1 ? [words[0]!, words.at(-1)!] : words;
	return letters.map((w) => [...w][0]?.toUpperCase() ?? "").join("") || "?";
}

function Avatar(props: { el: El<"ha-presence">; person: PresenceData["people"][number] }) {
	const source = usePicture(
		() => props.el,
		() => 3600,
		() => [props.person.entity, props.person.picture],
		() => props.person.entity,
	);
	// Shown only once it has loaded: a person without a (reachable) picture keeps their initials.
	const [ready, setReady] = createSignal("");
	createEffect(() => {
		const src = props.person.picture ? source() : "";
		if (!src) return setReady("");
		const probe = new Image();
		probe.onload = () => setReady(src);
		probe.onerror = () => setReady("");
		probe.src = src;
		onCleanup(() => {
			probe.onload = null;
			probe.onerror = null;
		});
	});
	return (
		<div class="sd-presence-avatar">
			<Show when={ready()} fallback={<span>{initials(props.person.name)}</span>}>
				<Picture src={ready()} fit="cover" />
			</Show>
		</div>
	);
}

export function HaPresence(props: RendererProps<El<"ha-presence">, PresenceData>) {
	const people = createMemo(() => (props.data()?.people ?? []).filter((p) => !props.el.onlyHome || p.home));
	const where = (state: string) => {
		const renamed = renames(props.el.stateMap)[state.toLowerCase()];
		if (renamed !== undefined) return renamed;
		if (state === "home") return "Home";
		if (state === "not_home") return "Away";
		if (state === "unknown" || state === "unavailable") return "–";
		// Anything else is the name of the zone the person is in.
		return state;
	};
	return (
		<div class="sd-presence" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<div
				class="sd-presence-list"
				data-layout={props.el.layout}
				style={{
					"grid-template-columns":
						props.el.layout === "grid" ? `repeat(${Math.max(1, props.el.perRow)}, minmax(0, 1fr))` : undefined,
				}}
			>
				<For
					each={people()}
					fallback={
						<Placeholder
							text={
								!props.el.entities.length
									? "Add a person"
									: props.data()?.people.length
										? "Nobody is home"
										: "Waiting for Home Assistant…"
							}
							error={props.error()}
						/>
					}
				>
					{(person) => (
						<div class="sd-presence-person" classList={{ "sd-presence-away": props.el.dimAway && !person.home }}>
							<Avatar el={props.el} person={person} />
							<Show when={props.el.names}>
								<div class="sd-presence-name">{person.name}</div>
							</Show>
							<Show when={props.el.states}>
								<div class="sd-presence-state">{where(person.state)}</div>
							</Show>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

// ------------------------------------------------------------------- alerts

export function HaAlerts(props: RendererProps<El<"ha-alerts">, AlertsData>) {
	const env = useDisplay();
	const alerts = () => (props.data()?.alerts ?? []).slice(0, Math.max(1, props.el.max));
	const configured = () => props.el.entities.length > 0 || props.el.batteryBelow > 0;
	const color = (severity: string) => env.ink(severity === "critical" ? props.el.criticalColor : props.el.warningColor);
	return (
		<Show
			when={alerts().length}
			fallback={
				// Nothing wrong: one calm line, or nothing at all (the box hides with it).
				<Show
					when={props.el.clearText && props.loaded() && configured()}
					fallback={
						<Placeholder
							text={configured() ? "No problems right now" : "Add an entity to watch"}
							error={props.error()}
						/>
					}
				>
					<div class="sd-alerts sd-alerts-clear" style={{ "font-size": px(props.el.size) }}>
						{props.el.clearText}
					</div>
				</Show>
			}
		>
			<div class="sd-alerts" style={{ "font-size": px(props.el.size) }}>
				<Show when={props.el.title}>
					<div class="sd-title">{props.el.title}</div>
				</Show>
				<For each={alerts()}>
					{(alert) => (
						<div class="sd-alerts-row" data-severity={alert.severity}>
							<span class="sd-alerts-icon" style={{ color: color(alert.severity) || undefined }}>
								<Show when={alert.severity === "critical"} fallback={<WarningMark />}>
									{/* An octagon: told apart from the warning triangle by shape, not only by colour. */}
									<svg class="sd-mark" viewBox="0 0 24 24" aria-hidden="true">
										<path
											d="M8.2 2.5h7.6l5.7 5.7v7.6l-5.7 5.7H8.2l-5.7-5.7V8.2Z"
											fill="none"
											stroke="currentColor"
											stroke-width="2.8"
											stroke-linejoin="round"
										/>
										<path d="M12 7v6M12 16.6v.4" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" />
									</svg>
								</Show>
							</span>
							<span class="sd-alerts-label">{alert.label}</span>
							<span class="sd-alerts-text" style={{ color: color(alert.severity) || undefined }}>
								{alert.text}
							</span>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
}

// ------------------------------------------------------------------- stream

/**
 * Where an element's live stream is served, worked out from where its picture
 * is: a display addresses it by display and element id, the editor (whose
 * pictures arrive as blobs) by the camera entity.
 */
function streamAddress(picture: string, entity: string): string {
	const stamp = Date.now();
	const view = /^(.*\/api\/view\/[^/]+)\/picture\/([^/?#]+)/.exec(picture);
	if (view) return `${view[1]}/live/${view[2]}?t=${stamp}`;
	return url(`api/preview/live?entity=${encodeURIComponent(entity)}&t=${stamp}`);
}

/** How often a stream is reopened: one that stalled recovers, and a camera that had none is asked again. */
const STREAM_RETRY_MS = 5 * 60_000;

function Snapshots(props: { el: El<"ha-stream">; seconds: number; fallback: JSX.Element }) {
	const source = usePicture(
		() => props.el,
		() => props.seconds,
		() => props.el.entity,
	);
	return (
		<Show when={source()} fallback={props.fallback}>
			<Picture src={source()} fit={props.el.fit} />
		</Show>
	);
}

export function HaStream(props: RendererProps<El<"ha-stream">, EntityData>) {
	const env = useDisplay();
	const [live, setLive] = createSignal("");
	// A camera without MJPEG answers the stream request with an error: snapshots take over, silently.
	const [failed, setFailed] = createSignal(false);
	const [attempt, setAttempt] = createSignal(0);
	const streaming = () => Boolean(props.el.entity) && !env.lowColor() && !failed();
	const retry = setInterval(() => {
		setFailed(false);
		setAttempt((n) => n + 1);
	}, STREAM_RETRY_MS);
	onCleanup(() => clearInterval(retry));
	createEffect(
		on([() => props.el.entity, env.refreshKey], () => {
			setFailed(false);
			setAttempt((n) => n + 1);
		}),
	);
	createEffect(
		on([attempt, () => env.lowColor()], () => {
			const entity = props.el.entity;
			if (!entity || env.lowColor()) return setLive("");
			let current = true;
			onCleanup(() => {
				current = false;
			});
			env
				.pictureUrl(props.el as unknown as AnyEl)
				.then((picture) => {
					if (picture.startsWith("blob:")) URL.revokeObjectURL(picture);
					if (current) setLive(streamAddress(picture, entity));
				})
				.catch(() => current && setFailed(true));
		}),
	);
	const waiting = () => (
		<Placeholder text={props.el.entity ? "Waiting for the camera…" : "Choose a camera"} error={props.error()} />
	);
	return (
		<div class="sd-camera sd-media-frame">
			<Show
				when={streaming()}
				fallback={
					<Show when={props.el.entity} fallback={waiting()}>
						{/* ePaper gets a slow slideshow of stills; a camera without a stream a fast one. */}
						<Snapshots
							el={props.el}
							seconds={env.lowColor() ? props.el.epaperRefresh : props.el.fallbackRefresh}
							fallback={waiting()}
						/>
					</Show>
				}
			>
				<Show when={live()} fallback={waiting()}>
					<img
						class="sd-picture"
						src={live()}
						alt=""
						style={{ "object-fit": props.el.fit }}
						draggable={false}
						onError={() => setFailed(true)}
					/>
				</Show>
			</Show>
			<Show when={props.el.label && props.data()?.state}>
				{(state) => <div class="sd-gallery-caption">{state().name}</div>}
			</Show>
		</div>
	);
}
