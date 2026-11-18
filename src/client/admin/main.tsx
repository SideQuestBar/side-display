/**
 * Admin entry: first-run setup or sign-in, then the app shell with its pages.
 */
import { Images, LayoutDashboard, ListVideo, LogOut, Monitor, Settings } from "lucide-solid";
import { type Component, createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { Dynamic, render } from "solid-js/web";
import type { SetupInfo } from "../../shared/types";
import { api, setUnauthorizedHandler } from "../lib/api";
import { DisplaysPage } from "./Displays";
import { EditorPage } from "./Editor";
import { LayoutsPage } from "./Layouts";
import { MediaPage } from "./Media";
import { Onboarding } from "./Onboarding";
import { PlaylistsPage } from "./Playlists";
import { SettingsPage } from "./Settings";
import { navigate, route } from "./state";
import { attempt, ConfirmHost, Toasts } from "./ui";

interface Status {
	version: string;
	setup: boolean;
	setupViaIngress: boolean;
	authenticated: boolean;
	ingress: boolean;
	restricted: boolean;
	owner: boolean;
}

const NAV: { path: string; label: string; icon: Component<{ class?: string }> }[] = [
	{ path: "displays", label: "Displays", icon: Monitor },
	{ path: "playlists", label: "Playlists", icon: ListVideo },
	{ path: "layouts", label: "Layouts", icon: LayoutDashboard },
	{ path: "media", label: "Media", icon: Images },
	{ path: "settings", label: "Settings", icon: Settings },
];

function Logo() {
	return (
		<div class="flex items-center gap-2.5">
			<img src="./favicon.svg" alt="" class="size-8" />
			<span class="text-lg font-bold tracking-tight">SideDisplay</span>
		</div>
	);
}

/** Shown on the open port of a Home Assistant app before a password exists. */
function IngressOnly() {
	return (
		<div class="flex min-h-full items-center justify-center p-4">
			<div class="card w-full max-w-sm space-y-4 p-6">
				<Logo />
				<p class="text-sm text-muted">
					No password is set yet. Open SideDisplay from the Home Assistant sidebar and choose one under{" "}
					<strong class="text-ink">Settings</strong> to manage your displays from this address too.
				</p>
				<p class="text-sm text-muted">Displays work without it: their addresses are listed on the Displays page.</p>
			</div>
		</div>
	);
}

/** Shown in the Home Assistant sidebar to users the access setting keeps out. */
function AdminsOnly() {
	return (
		<div class="flex min-h-full items-center justify-center p-4">
			<div class="card w-full max-w-sm space-y-4 p-6">
				<Logo />
				<p class="text-sm text-muted">Only Home Assistant administrators can manage SideDisplay here.</p>
				<p class="text-sm text-muted">
					An administrator can open it to all users under <strong class="text-ink">Settings</strong>.
				</p>
			</div>
		</div>
	);
}

function Gate(props: { setup: boolean; onDone: () => void }) {
	const [password, setPassword] = createSignal("");
	const [repeat, setRepeat] = createSignal("");
	const [error, setError] = createSignal("");
	const [busy, setBusy] = createSignal(false);
	const submit = async (event: SubmitEvent) => {
		event.preventDefault();
		if (props.setup && password() !== repeat()) return setError("The two passwords are different.");
		setBusy(true);
		try {
			await api(props.setup ? "api/auth/setup" : "api/auth/login", { body: { password: password() } });
			props.onDone();
		} catch (err) {
			setError((err as Error).message);
		}
		setBusy(false);
	};
	return (
		<div class="flex min-h-full items-center justify-center p-4">
			<form class="card w-full max-w-sm space-y-4 p-6" onSubmit={submit}>
				<Logo />
				<p class="text-sm text-muted">
					{props.setup
						? "Welcome! Choose the password that will protect this admin interface."
						: "Enter the password to manage your displays."}
				</p>
				<input
					class="input"
					type="password"
					autofocus
					autocomplete={props.setup ? "new-password" : "current-password"}
					placeholder={props.setup ? "New password (8 characters or more)" : "Password"}
					aria-label="Password"
					value={password()}
					onInput={(e) => setPassword(e.currentTarget.value)}
				/>
				<Show when={props.setup}>
					<input
						class="input"
						type="password"
						autocomplete="new-password"
						placeholder="Repeat the password"
						aria-label="Repeat the password"
						value={repeat()}
						onInput={(e) => setRepeat(e.currentTarget.value)}
					/>
				</Show>
				<Show when={error()}>
					<p class="text-sm text-danger" role="alert">
						{error()}
					</p>
				</Show>
				<button type="submit" class="btn btn-primary w-full" disabled={busy() || !password()}>
					{props.setup ? "Set password" : "Sign in"}
				</button>
			</form>
		</div>
	);
}

function Shell(props: { status: Status; onSignOut: () => void }) {
	const page = () => route()[0] ?? "displays";
	if (!route().length) navigate("displays");
	// A new installation starts with the setup guide; Settings links back to it at `#/setup`.
	const [setupNeeded, { mutate: setSetupNeeded }] = createResource(() =>
		api<SetupInfo>("api/onboarding").then(
			(info) => info.needed,
			() => false,
		),
	);
	const guiding = () => page() === "setup" || setupNeeded() === true;
	const guideDone = () => {
		const again = page() === "setup";
		setSetupNeeded(false);
		navigate(again ? "settings" : "displays");
	};
	return (
		<Show when={!setupNeeded.loading}>
			<Show when={!guiding()} fallback={<Onboarding onDone={guideDone} />}>
				<ShellPages {...props} />
			</Show>
		</Show>
	);
}

function ShellPages(props: { status: Status; onSignOut: () => void }) {
	const page = () => route()[0] ?? "displays";
	const editorId = () => (page() === "layouts" ? route()[1] : undefined);
	return (
		<Show
			when={!editorId()}
			// The editor takes the whole window.
			fallback={
				<Show when={editorId()} keyed>
					{(id) => <EditorPage id={id} />}
				</Show>
			}
		>
			<div class="flex h-full max-md:flex-col">
				<nav class="flex shrink-0 flex-col gap-1 border-line bg-surface p-3 max-md:flex-row max-md:items-center max-md:overflow-x-auto max-md:border-b md:w-52 md:border-r">
					<div class="px-2 py-3 max-md:hidden">
						<Logo />
					</div>
					<For each={NAV}>
						{(item) => (
							<a
								href={`#/${item.path}`}
								class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium"
								classList={{
									"bg-accent-bg/25 text-ink": page() === item.path,
									"text-muted hover:bg-raised hover:text-ink": page() !== item.path,
								}}
								aria-current={page() === item.path ? "page" : undefined}
							>
								<Dynamic component={item.icon} class="size-4.5 shrink-0" />
								{item.label}
							</a>
						)}
					</For>
					<div class="flex-1" />
					<Show when={!props.status.ingress}>
						<button
							type="button"
							class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-raised hover:text-ink"
							onClick={props.onSignOut}
						>
							<LogOut class="size-4.5 shrink-0" />
							Sign out
						</button>
					</Show>
				</nav>
				<main class="min-w-0 flex-1 overflow-y-auto p-5 md:p-8">
					<Switch fallback={<DisplaysPage ingress={props.status.ingress} />}>
						<Match when={page() === "layouts"}>
							<LayoutsPage />
						</Match>
						<Match when={page() === "playlists"}>
							<PlaylistsPage />
						</Match>
						<Match when={page() === "media"}>
							<MediaPage />
						</Match>
						<Match when={page() === "settings"}>
							<SettingsPage
								version={props.status.version}
								ingress={props.status.ingress}
								app={props.status.setupViaIngress}
								owner={props.status.owner}
							/>
						</Match>
					</Switch>
				</main>
			</div>
		</Show>
	);
}

function App() {
	const [status, { refetch }] = createResource(() => api<Status>("api/auth/status"));
	// A session that expired mid-use sends the user back to the sign-in screen.
	setUnauthorizedHandler(() => void refetch());
	const signOut = async () => {
		await attempt(() => api("api/auth/logout", { method: "POST" }));
		void refetch();
	};
	return (
		<>
			<Show
				when={status()}
				keyed
				fallback={
					<Show when={status.error}>
						<div class="p-10 text-muted">The SideDisplay server cannot be reached.</div>
					</Show>
				}
			>
				{(s) => (
					<Show
						when={s.authenticated}
						fallback={
							<Show when={!s.restricted} fallback={<AdminsOnly />}>
								<Show when={!(s.setup && s.setupViaIngress)} fallback={<IngressOnly />}>
									<Gate setup={s.setup} onDone={() => void refetch()} />
								</Show>
							</Show>
						}
					>
						<Shell status={s} onSignOut={signOut} />
					</Show>
				)}
			</Show>
			<Toasts />
			<ConfirmHost />
		</>
	);
}

render(() => <App />, document.getElementById("root")!);
