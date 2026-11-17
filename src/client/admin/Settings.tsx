import { createEffect, createSignal, on, Show } from "solid-js";
import { createStore } from "solid-js/store";
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettings, type HaAccess } from "../../shared/types";
import { api } from "../lib/api";
import { refetchEntities, refetchSettings, settings } from "./state";
import { attempt, FormField, PageHeader, toast } from "./ui";

const SOURCES = {
	supervisor: "Home Assistant app (automatic)",
	settings: "the settings below",
	env: "environment variables",
	none: "",
};

export function SettingsPage(props: {
	version: string;
	/** Signed in by Home Assistant rather than with the password. */
	ingress: boolean;
	/** Running as a Home Assistant app. */
	app: boolean;
	/** May change the password and which Home Assistant users get in. */
	owner: boolean;
}) {
	const [general, setGeneral] = createStore<GeneralSettings>({ ...DEFAULT_GENERAL_SETTINGS });
	const [haUrl, setHaUrl] = createSignal("");
	const [haToken, setHaToken] = createSignal("");
	const [testResult, setTestResult] = createSignal<{ ok: boolean; message: string } | null>(null);
	const [mqttUrl, setMqttUrl] = createSignal("");
	const [mqttUser, setMqttUser] = createSignal("");
	const [mqttPassword, setMqttPassword] = createSignal("");
	const [mqttTest, setMqttTest] = createSignal<{ ok: boolean; message: string } | null>(null);
	const [current, setCurrent] = createSignal("");
	const [next, setNext] = createSignal("");
	void refetchSettings();

	// Fill the forms once the settings arrive (and again after saving).
	createEffect(
		on(settings, (s) => {
			if (!s) return;
			setGeneral(s.general);
			setHaUrl(s.ha.url);
			setMqttUrl(s.mqtt.url);
			setMqttUser(s.mqtt.username);
		}),
	);

	const saveGeneral = async () => {
		await attempt(
			() => api("api/settings/general", { method: "PUT", body: { ...general } }),
			"Settings saved. Screens are updating.",
		);
		void refetchSettings();
	};
	const locate = () =>
		navigator.geolocation?.getCurrentPosition(
			(position) => {
				setGeneral("latitude", Number(position.coords.latitude.toFixed(4)));
				setGeneral("longitude", Number(position.coords.longitude.toFixed(4)));
			},
			() => toast("The browser did not share a location.", "error"),
		);
	const saveHa = async () => {
		await attempt(
			() => api("api/settings/ha", { method: "PUT", body: { url: haUrl(), token: haToken() || undefined } }),
			"Home Assistant settings saved.",
		);
		setHaToken("");
		// Give the connection a moment before asking how it went.
		setTimeout(() => {
			void refetchSettings();
			void refetchEntities();
		}, 1500);
	};
	const testHa = async () =>
		setTestResult(
			(await attempt(() =>
				api<{ ok: boolean; message: string }>("api/ha/test", { body: { url: haUrl(), token: haToken() || undefined } }),
			)) ?? null,
		);
	const mqttBody = () => ({ url: mqttUrl(), username: mqttUser(), password: mqttPassword() || undefined });
	const saveMqtt = async () => {
		const saved = await attempt(
			() => api("api/settings/mqtt", { method: "PUT", body: mqttBody() }),
			"MQTT settings saved.",
		);
		if (!saved) return;
		setMqttPassword("");
		// Give the connection a moment before asking how it went.
		setTimeout(() => void refetchSettings(), 1500);
	};
	const testMqtt = async () =>
		setMqttTest(
			(await attempt(() => api<{ ok: boolean; message: string }>("api/mqtt/test", { body: mqttBody() }))) ?? null,
		);
	const saveAccess = async (access: HaAccess) => {
		await attempt(
			() => api("api/settings/access", { method: "PUT", body: { access } }),
			access === "everyone"
				? "Every Home Assistant user can now manage SideDisplay."
				: "Only Home Assistant administrators can manage SideDisplay now.",
		);
		void refetchSettings();
	};
	const changePassword = async () => {
		const done = await attempt(
			() => api("api/auth/password", { body: { current: current(), next: next() } }),
			"Password changed. Other browsers were signed out.",
		);
		if (done) {
			setCurrent("");
			setNext("");
		}
	};

	const status = () => settings()?.ha.status;
	const mqtt = () => settings()?.mqtt.status;

	return (
		<div class="max-w-2xl space-y-6">
			<PageHeader title="Settings" />

			<section class="card space-y-4 p-5">
				<div>
					<h2 class="text-base font-semibold">Region</h2>
					<p class="help">How dates, times and temperatures are written on every display.</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-2">
					<FormField label="Language and format" help="A locale code such as en-GB, fr-FR or hu-HU.">
						<input
							class="input"
							value={general.locale}
							placeholder="en-GB"
							onInput={(e) => setGeneral("locale", e.currentTarget.value.trim())}
						/>
					</FormField>
					<FormField label="Time zone" help="Empty = each screen's own. Otherwise e.g. Europe/Budapest.">
						<input
							class="input"
							value={general.timezone}
							placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone}
							onInput={(e) => setGeneral("timezone", e.currentTarget.value.trim())}
						/>
					</FormField>
					<FormField label="Clock">
						<select
							class="input"
							value={general.hourCycle}
							onChange={(e) => setGeneral("hourCycle", e.currentTarget.value as GeneralSettings["hourCycle"])}
						>
							<option value="auto">Follow the language</option>
							<option value="24">24-hour</option>
							<option value="12">12-hour</option>
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
							<option value="c">Celsius</option>
							<option value="f">Fahrenheit</option>
						</select>
					</FormField>
				</div>
				<div>
					<h3 class="text-sm font-semibold">Location</h3>
					<p class="help">The default place for weather and maps.</p>
				</div>
				<div class="grid gap-3 sm:grid-cols-3">
					<FormField label="Place name">
						<input
							class="input"
							value={general.locationName}
							placeholder="Budapest"
							onInput={(e) => setGeneral("locationName", e.currentTarget.value)}
						/>
					</FormField>
					<FormField label="Latitude">
						<input
							class="input"
							type="number"
							step="0.0001"
							value={general.latitude}
							onInput={(e) => setGeneral("latitude", Number(e.currentTarget.value) || 0)}
						/>
					</FormField>
					<FormField label="Longitude">
						<input
							class="input"
							type="number"
							step="0.0001"
							value={general.longitude}
							onInput={(e) => setGeneral("longitude", Number(e.currentTarget.value) || 0)}
						/>
					</FormField>
				</div>
				<div class="flex gap-2">
					<button type="button" class="btn btn-primary" onClick={saveGeneral}>
						Save
					</button>
					<button type="button" class="btn" onClick={locate}>
						Use my location
					</button>
					<div class="flex-1" />
					<a class="btn btn-ghost text-muted" href="#/setup">
						Open the setup guide
					</a>
				</div>
			</section>

			<section class="card space-y-4 p-5">
				<div class="flex items-start justify-between gap-3">
					<div>
						<h2 class="text-base font-semibold">Home Assistant</h2>
						<p class="help">Lets displays show entities, calendars, cameras, to-do lists and more.</p>
					</div>
					<Show when={status()}>
						{(s) => (
							<span
								class="badge shrink-0"
								classList={{
									"!border-ok !text-ok": s().connected,
									"!border-danger !text-danger": !s().connected && s().source !== "none",
								}}
							>
								{s().connected
									? `Connected · ${s().entities} entities`
									: s().source === "none"
										? "Not set up"
										: "Not connected"}
							</span>
						)}
					</Show>
				</div>
				<Show when={status()?.source !== "none" && status()}>
					{(s) => (
						<p class="text-sm text-muted">
							Using {SOURCES[s().source]}
							{s().version ? ` · Home Assistant ${s().version}` : ""}
							<Show when={s().error}>
								<span class="text-danger"> · {s().error}</span>
							</Show>
						</p>
					)}
				</Show>
				<Show when={status()?.source === "supervisor"}>
					<p class="help">
						Running as a Home Assistant app, the connection needs no setup. Fill in the fields below only to use a
						different Home Assistant.
					</p>
				</Show>
				<FormField label="Address">
					<input
						class="input"
						type="url"
						value={haUrl()}
						placeholder="http://homeassistant.local:8123"
						onInput={(e) => setHaUrl(e.currentTarget.value)}
					/>
				</FormField>
				<FormField
					label="Long-lived access token"
					help="Create one in Home Assistant: your profile → Security → Long-lived access tokens. It stays on this server and is never sent to displays."
				>
					<input
						class="input font-mono"
						type="password"
						autocomplete="off"
						value={haToken()}
						placeholder={settings()?.ha.hasToken ? "Saved. Leave empty to keep it." : "Paste the token"}
						onInput={(e) => setHaToken(e.currentTarget.value)}
					/>
				</FormField>
				<Show when={testResult()}>
					{(r) => (
						<p class="text-sm" classList={{ "text-ok": r().ok, "text-danger": !r().ok }}>
							{r().message}
						</p>
					)}
				</Show>
				<div class="flex gap-2">
					<button type="button" class="btn btn-primary" onClick={saveHa}>
						Save
					</button>
					<button type="button" class="btn" disabled={!haUrl()} onClick={testHa}>
						Test
					</button>
				</div>
			</section>

			<section class="card space-y-4 p-5">
				<div class="flex items-start justify-between gap-3">
					<div>
						<h2 class="text-base font-semibold">MQTT</h2>
						<p class="help">Lets displays show what devices and services publish on an MQTT broker.</p>
					</div>
					<Show when={mqtt()}>
						{(s) => (
							<span
								class="badge shrink-0"
								classList={{
									"!border-ok !text-ok": s().connected,
									"!border-danger !text-danger": !s().connected && s().source !== "none",
								}}
							>
								{s().connected
									? `Connected · ${s().topics} ${s().topics === 1 ? "topic" : "topics"}`
									: s().source === "none"
										? "Not set up"
										: "Not connected"}
							</span>
						)}
					</Show>
				</div>
				<Show when={mqtt()?.source !== "none" && mqtt()}>
					{(s) => (
						<p class="text-sm text-muted">
							Using {SOURCES[s().source]}
							{s().broker ? ` · ${s().broker}` : ""}
							<Show when={s().error}>
								<span class="text-danger"> · {s().error}</span>
							</Show>
						</p>
					)}
				</Show>
				<Show when={mqtt()?.source === "supervisor"}>
					<p class="help">
						Running as a Home Assistant app, the broker set up in Home Assistant is used. Fill in the fields below only
						to use a different one.
					</p>
				</Show>
				<FormField label="Broker address" help="mqtts:// for an encrypted connection. Clear it to stop using MQTT.">
					<input
						class="input"
						value={mqttUrl()}
						placeholder="mqtt://192.168.1.10:1883"
						onInput={(e) => setMqttUrl(e.currentTarget.value)}
					/>
				</FormField>
				<div class="grid gap-3 sm:grid-cols-2">
					<FormField label="User name" help="Empty if the broker needs none.">
						<input
							class="input"
							autocomplete="off"
							value={mqttUser()}
							onInput={(e) => setMqttUser(e.currentTarget.value)}
						/>
					</FormField>
					<FormField label="Password" help="Stays on this server; never sent to displays.">
						<input
							class="input font-mono"
							type="password"
							autocomplete="off"
							value={mqttPassword()}
							placeholder={settings()?.mqtt.hasPassword ? "Saved. Leave empty to keep it." : ""}
							onInput={(e) => setMqttPassword(e.currentTarget.value)}
						/>
					</FormField>
				</div>
				<Show when={mqttTest()}>
					{(r) => (
						<p class="text-sm" classList={{ "text-ok": r().ok, "text-danger": !r().ok }}>
							{r().message}
						</p>
					)}
				</Show>
				<div class="flex gap-2">
					<button type="button" class="btn btn-primary" onClick={saveMqtt}>
						Save
					</button>
					<button type="button" class="btn" disabled={!mqttUrl()} onClick={testMqtt}>
						Test
					</button>
				</div>
			</section>

			<Show when={props.app && props.owner}>
				<section class="card space-y-4 p-5">
					<div>
						<h2 class="text-base font-semibold">Home Assistant users</h2>
						<p class="help">
							Who can manage SideDisplay from the Home Assistant sidebar. Users who are not administrators cannot change
							this setting or the password.
						</p>
					</div>
					<FormField
						label="Open to"
						help="The sidebar entry is shown to everyone; users who are not let in only see a notice."
					>
						<select
							class="input"
							value={settings()?.access ?? "admins"}
							onChange={(e) => void saveAccess(e.currentTarget.value as HaAccess)}
						>
							<option value="admins">Administrators only</option>
							<option value="everyone">All Home Assistant users</option>
						</select>
					</FormField>
				</section>
			</Show>

			<Show when={props.owner}>
				<section class="card space-y-4 p-5">
					<div>
						<h2 class="text-base font-semibold">Password</h2>
						<p class="help">One password protects this admin interface. Displays do not need it.</p>
					</div>
					<div class="grid gap-3 sm:grid-cols-2">
						<Show when={!props.ingress}>
							<FormField label="Current password">
								<input
									class="input"
									type="password"
									autocomplete="current-password"
									value={current()}
									onInput={(e) => setCurrent(e.currentTarget.value)}
								/>
							</FormField>
						</Show>
						<FormField label="New password" help="At least 8 characters.">
							<input
								class="input"
								type="password"
								autocomplete="new-password"
								value={next()}
								onInput={(e) => setNext(e.currentTarget.value)}
							/>
						</FormField>
					</div>
					<button type="button" class="btn btn-primary" disabled={next().length < 8} onClick={changePassword}>
						Change password
					</button>
				</section>
			</Show>

			<p class="text-xs text-muted">
				SideDisplay {props.version} · free software under the GNU GPL v3 · map data © OpenStreetMap contributors, tiles
				by OpenFreeMap · weather by Open-Meteo
			</p>
		</div>
	);
}
