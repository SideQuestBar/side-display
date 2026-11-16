import {
	Archive,
	ArchiveRestore,
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Copy,
	ExternalLink,
	LayoutDashboard,
	Pencil,
	Plus,
	RefreshCw,
	ScanEye,
	Trash2,
} from "lucide-solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore, unwrap } from "solid-js/store";
import { normalizeSlug } from "../../shared/layout";
import {
	COLOR_MODES,
	DEFAULT_DISPLAY_SETTINGS,
	type Display,
	type DisplaySettings,
	type Layout,
	type PlaylistEntry,
} from "../../shared/types";
import { api, url } from "../lib/api";
import { DaysInput } from "./fields";
import { displays, layouts, navigate, refetchDisplays, refetchLayouts } from "./state";
import {
	ArchiveToggle,
	attempt,
	confirmAction,
	EmptyState,
	Fold,
	FormField,
	Modal,
	PageHeader,
	Thumbnail,
	timeAgo,
	toast,
} from "./ui";

/** The address of a display: by its short name when it has one, by its id otherwise. */
export const displayUrl = (display: Pick<Display, "id" | "slug">) => url(`d/${display.slug || display.id}`);

export function DisplaysPage(props: { ingress: boolean }) {
	const [editing, setEditing] = createSignal<Display | "new" | null>(null);
	const [showArchived, setShowArchived] = createSignal(false);
	const archivedCount = createMemo(() => (displays() ?? []).filter((d) => d.archivedAt).length);
	const shown = createMemo(() => (displays() ?? []).filter((d) => Boolean(d.archivedAt) === showArchived()));
	void refetchDisplays();
	void refetchLayouts();
	// Connection status changes without us doing anything: keep it fresh.
	const timer = setInterval(() => !editing() && refetchDisplays(), 10_000);
	onCleanup(() => clearInterval(timer));

	const layoutOf = (display: Display) => (layouts() ?? []).find((l) => l.id === display.playlist[0]?.layoutId);
	/** The layouts a display shows, in playlist order, each once. */
	const layoutsOf = (display: Display) =>
		[...new Set(display.playlist.map((entry) => entry.layoutId))].flatMap(
			(id) => (layouts() ?? []).find((l) => l.id === id) ?? [],
		);
	const copy = async (display: Display) => {
		await attempt(() => navigator.clipboard.writeText(displayUrl(display)), "Address copied.");
	};
	const send = (display: Display, action: "reload" | "identify") =>
		attempt(
			() => api(`api/displays/${display.id}/${action}`, { method: "POST" }),
			action === "reload" ? "Reload sent." : "The screen is showing its name.",
		);
	const setArchived = async (display: Display, to: boolean) => {
		await attempt(
			() => api(`api/displays/${display.id}`, { method: "PUT", body: { archived: to } }),
			to ? "Display archived." : "Display restored.",
		);
		await refetchDisplays();
		if (!archivedCount()) setShowArchived(false);
	};
	const remove = async (display: Display) => {
		if (
			!(await confirmAction("Delete this display?", `Screens opened on "${display.name}" will stop showing anything.`))
		)
			return;
		await attempt(() => api(`api/displays/${display.id}`, { method: "DELETE" }), "Display deleted.");
		void refetchDisplays();
	};

	return (
		<>
			<PageHeader title="Displays" subtitle="A display is a screen: open its address in a browser, full screen.">
				<ArchiveToggle
					count={archivedCount()}
					active={showArchived()}
					onToggle={() => setShowArchived(!showArchived())}
				/>
				<button type="button" class="btn btn-primary" onClick={() => setEditing("new")}>
					<Plus /> New display
				</button>
			</PageHeader>

			<Show when={props.ingress}>
				<div class="card mb-4 border-accent/60 p-3 text-sm text-muted">
					You are inside Home Assistant. Screens cannot sign in to Home Assistant, so open displays through the app's
					own port instead, e.g. <code class="text-ink">http://homeassistant.local:4380/d/…</code>
				</div>
			</Show>

			<Show when={showArchived()}>
				<p class="mb-4 text-sm text-muted">
					Archived displays are kept as they were, and their addresses keep working: a screen still open on one goes on
					showing it.
				</p>
			</Show>

			<Show
				when={shown().length}
				fallback={
					<Show when={displays()}>
						<EmptyState
							title={displays()?.length ? "Every display is archived" : "No displays yet"}
							text={
								displays()?.length
									? "Restore one from the archive, or create a new one."
									: "Create a display, give it one or more layouts, then open its address on the screen."
							}
						>
							<button type="button" class="btn btn-primary" onClick={() => setEditing("new")}>
								<Plus /> New display
							</button>
						</EmptyState>
					</Show>
				}
			>
				<div class="grid gap-4 lg:grid-cols-2">
					<For each={shown()}>
						{(display) => (
							<div class="card flex overflow-hidden">
								<a
									href={displayUrl(display)}
									target="_blank"
									rel="noreferrer"
									class="flex min-h-36 w-56 shrink-0 items-center justify-center bg-black/80 p-2 max-sm:hidden"
									aria-label={`Open ${display.name}`}
								>
									<Show when={layoutOf(display)} fallback={<span class="text-xs text-white/50">No layout</span>}>
										{(layout) => (
											<Thumbnail
												settings={layout().settings}
												elements={layout().elements}
												mode={display.settings.colorMode}
												class="h-full w-full"
											/>
										)}
									</Show>
								</a>
								<div class="flex min-w-0 flex-1 flex-col gap-2 p-4">
									<div class="flex items-center gap-2">
										<span
											class="size-2.5 shrink-0 rounded-full"
											classList={{ "bg-ok": Boolean(display.online), "bg-line": !display.online }}
											title={display.online ? "Connected" : "Not connected"}
										/>
										<h2 class="truncate text-base font-semibold">{display.name}</h2>
									</div>
									<div class="text-xs text-muted">
										{display.online
											? `${display.online} screen${display.online > 1 ? "s" : ""} connected`
											: `Last seen ${timeAgo(display.lastSeenAt)}`}
									</div>
									<div class="flex flex-wrap gap-1.5">
										<For each={layoutsOf(display)} fallback={<span class="badge">No layout</span>}>
											{(layout) => (
												<button
													type="button"
													class="badge max-w-full hover:border-accent hover:text-ink"
													onClick={() => navigate(`layouts/${layout.id}`)}
													title={`Edit the layout "${layout.name}"`}
												>
													<LayoutDashboard class="size-3 shrink-0" />
													<span class="truncate">{layout.name}</span>
												</button>
											)}
										</For>
										<Show when={display.settings.colorMode !== "full"}>
											<span class="badge">
												{COLOR_MODES.find((m) => m.value === display.settings.colorMode)?.label}
											</span>
										</Show>
										<Show when={display.settings.rotation}>
											<span class="badge">rotated {display.settings.rotation}°</span>
										</Show>
									</div>
									<div class="mt-auto flex flex-wrap gap-1 pt-1">
										<a class="btn" href={displayUrl(display)} target="_blank" rel="noreferrer">
											<ExternalLink /> Open
										</a>
										<button
											type="button"
											class="btn btn-icon"
											onClick={() => copy(display)}
											title="Copy the address"
											aria-label="Copy the address"
										>
											<Copy />
										</button>
										<button
											type="button"
											class="btn btn-icon"
											onClick={() => send(display, "identify")}
											title="Show the name on the screen"
											aria-label="Identify"
										>
											<ScanEye />
										</button>
										<button
											type="button"
											class="btn btn-icon"
											onClick={() => send(display, "reload")}
											title="Reload the screen"
											aria-label="Reload"
										>
											<RefreshCw />
										</button>
										<div class="flex-1" />
										<button
											type="button"
											class="btn btn-icon"
											onClick={() => setEditing(display)}
											title="Edit"
											aria-label="Edit"
										>
											<Pencil />
										</button>
										<button
											type="button"
											class="btn btn-icon"
											onClick={() => setArchived(display, !display.archivedAt)}
											title={display.archivedAt ? "Restore" : "Archive"}
											aria-label={display.archivedAt ? "Restore" : "Archive"}
										>
											<Show when={display.archivedAt} fallback={<Archive />}>
												<ArchiveRestore />
											</Show>
										</button>
										<button
											type="button"
											class="btn btn-icon btn-danger"
											onClick={() => remove(display)}
											title="Delete"
											aria-label="Delete"
										>
											<Trash2 />
										</button>
									</div>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>

			<Show when={editing()} keyed>
				{(target) => (
					<DisplayEditor
						display={target === "new" ? null : target}
						onClose={() => {
							setEditing(null);
							void refetchDisplays();
						}}
					/>
				)}
			</Show>
		</>
	);
}

function DisplayEditor(props: { display: Display | null; onClose: () => void }) {
	const [form, setForm] = createStore<{
		name: string;
		slug: string;
		playlist: PlaylistEntry[];
		settings: DisplaySettings;
	}>(
		structuredClone({
			name: props.display?.name ?? "",
			slug: props.display?.slug ?? "",
			playlist: props.display?.playlist ?? [],
			settings: props.display?.settings ?? DEFAULT_DISPLAY_SETTINGS,
		}),
	);
	const [scheduling, setScheduling] = createSignal<number | null>(null);
	const setting = <K extends keyof DisplaySettings>(key: K, value: DisplaySettings[K]) =>
		setForm("settings", key, value);

	/** The layouts a playlist entry can pick: archived ones are left out, except the one it already shows. */
	const pickable = (keep?: string) => (layouts() ?? []).filter((l) => !l.archivedAt || l.id === keep);
	const optionLabel = (l: Layout) => `${l.folder ? `${l.folder} / ` : ""}${l.name}${l.archivedAt ? " (archived)" : ""}`;
	const addLayout = (layoutId: string) =>
		layoutId && setForm("playlist", form.playlist.length, { layoutId, seconds: 30, days: [], from: "", to: "" });
	const move = (index: number, by: number) => {
		const next = [...unwrap(form.playlist)];
		const target = index + by;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target]!, next[index]!];
		setForm("playlist", next);
	};

	const save = async () => {
		if (!form.name.trim()) return toast("Give the display a name.", "error");
		const body = unwrap(form);
		const result = props.display
			? await attempt(() => api(`api/displays/${props.display!.id}`, { method: "PUT", body }), "Display saved.")
			: await attempt(() => api("api/displays", { body }), "Display created.");
		if (result) props.onClose();
	};

	return (
		<Modal
			title={props.display ? "Edit display" : "New display"}
			onClose={props.onClose}
			footer={
				<>
					<button type="button" class="btn" onClick={props.onClose}>
						Cancel
					</button>
					<button type="button" class="btn btn-primary" onClick={save}>
						Save
					</button>
				</>
			}
		>
			<FormField label="Name">
				<input
					class="input"
					value={form.name}
					placeholder="Bar TV, Kitchen frame…"
					onInput={(e) => setForm("name", e.currentTarget.value)}
				/>
			</FormField>

			<FormField
				label="Short address"
				help={
					normalizeSlug(form.slug)
						? `Opens at /d/${normalizeSlug(form.slug)}${props.display ? ` as well as /d/${props.display.id}` : ""}. Anyone who guesses it can see this display.`
						: "Optional. A name that is easy to type on a screen, used in place of the random id in the address."
				}
			>
				<input
					class="input"
					value={form.slug}
					placeholder="bar-tv"
					maxLength={48}
					autocapitalize="off"
					spellcheck={false}
					onInput={(e) => setForm("slug", e.currentTarget.value)}
					onChange={() => setForm("slug", normalizeSlug(form.slug))}
				/>
			</FormField>

			<div>
				<div class="label">Layouts</div>
				<div class="space-y-1.5">
					<For
						each={form.playlist}
						fallback={<p class="help !mt-0">Add a layout to show. With several, the display cycles through them.</p>}
					>
						{(entry, i) => (
							<div class="rounded-lg border border-line bg-raised/50 p-2">
								<div class="flex items-center gap-1.5">
									<select
										class="input"
										value={entry.layoutId}
										aria-label="Layout"
										onChange={(e) => setForm("playlist", i(), "layoutId", e.currentTarget.value)}
									>
										<For each={pickable(entry.layoutId)}>{(l) => <option value={l.id}>{optionLabel(l)}</option>}</For>
									</select>
									<Show when={form.playlist.length > 1}>
										<input
											class="input !w-20"
											type="number"
											min="3"
											value={entry.seconds}
											aria-label="Seconds"
											title="Seconds on screen"
											onInput={(e) => setForm("playlist", i(), "seconds", Number(e.currentTarget.value) || 30)}
										/>
										<span class="text-xs text-muted">s</span>
										<button
											type="button"
											class="btn btn-ghost btn-icon !p-1"
											disabled={i() === 0}
											onClick={() => move(i(), -1)}
											aria-label="Move up"
										>
											<ArrowUp />
										</button>
										<button
											type="button"
											class="btn btn-ghost btn-icon !p-1"
											disabled={i() === form.playlist.length - 1}
											onClick={() => move(i(), 1)}
											aria-label="Move down"
										>
											<ArrowDown />
										</button>
									</Show>
									<button
										type="button"
										class="btn btn-ghost btn-icon btn-danger !p-1"
										onClick={() =>
											setForm(
												"playlist",
												form.playlist.filter((_, index) => index !== i()),
											)
										}
										aria-label="Remove"
									>
										<Trash2 />
									</button>
								</div>
								<button
									type="button"
									class="mt-1.5 flex items-center gap-1 text-xs text-muted hover:text-ink"
									onClick={() => setScheduling(scheduling() === i() ? null : i())}
								>
									<Show when={scheduling() === i()} fallback={<ChevronRight class="size-3.5" />}>
										<ChevronDown class="size-3.5" />
									</Show>
									{entry.days.length || entry.from || entry.to ? "Scheduled" : "Always shown"}
								</button>
								<Show when={scheduling() === i()}>
									<div class="mt-2 space-y-2">
										<DaysInput value={entry.days} set={(days) => setForm("playlist", i(), "days", days)} />
										<div class="flex items-center gap-2 text-xs text-muted">
											from
											<input
												class="input"
												type="time"
												value={entry.from}
												onInput={(e) => setForm("playlist", i(), "from", e.currentTarget.value)}
											/>
											to
											<input
												class="input"
												type="time"
												value={entry.to}
												onInput={(e) => setForm("playlist", i(), "to", e.currentTarget.value)}
											/>
										</div>
										<p class="help !mt-0">No day selected = every day. Empty times = all day.</p>
									</div>
								</Show>
							</div>
						)}
					</For>
					<select
						class="input"
						aria-label="Add a layout"
						onChange={(e) => {
							addLayout(e.currentTarget.value);
							e.currentTarget.value = "";
						}}
					>
						<option value="">+ Add a layout…</option>
						<For each={pickable()}>{(l) => <option value={l.id}>{optionLabel(l)}</option>}</For>
					</select>
				</div>
			</div>

			<FormField label="Screen type" help={COLOR_MODES.find((m) => m.value === form.settings.colorMode)?.hint}>
				<select
					class="input"
					value={form.settings.colorMode}
					onChange={(e) => setting("colorMode", e.currentTarget.value as DisplaySettings["colorMode"])}
				>
					<For each={COLOR_MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
				</select>
			</FormField>

			<Fold label="Advanced">
				<div class="grid gap-3 sm:grid-cols-2">
					<FormField label="Rotation" help="For a screen mounted sideways whose browser cannot rotate.">
						<select
							class="input"
							value={form.settings.rotation}
							onChange={(e) => setting("rotation", Number(e.currentTarget.value) as DisplaySettings["rotation"])}
						>
							<For each={[0, 90, 180, 270]}>{(r) => <option value={r}>{r}°</option>}</For>
						</select>
					</FormField>
					<FormField label="Between layouts">
						<select
							class="input"
							value={form.settings.transition}
							onChange={(e) => setting("transition", e.currentTarget.value as DisplaySettings["transition"])}
						>
							<option value="fade">Fade</option>
							<option value="none">Cut</option>
						</select>
					</FormField>
					<FormField label="Reload every day at" help="Clears memory on screens that run for months.">
						<input
							class="input"
							type="time"
							value={form.settings.reloadAt}
							onInput={(e) => setting("reloadAt", e.currentTarget.value)}
						/>
					</FormField>
					<FormField label="Dim level" help="How dark the screen gets while dimmed.">
						<input
							class="w-full"
							type="range"
							min="10"
							max="95"
							value={form.settings.dimLevel}
							onInput={(e) => setting("dimLevel", Number(e.currentTarget.value))}
						/>
					</FormField>
					<FormField label="Dim from">
						<input
							class="input"
							type="time"
							value={form.settings.dimFrom}
							onInput={(e) => setting("dimFrom", e.currentTarget.value)}
						/>
					</FormField>
					<FormField label="Dim until">
						<input
							class="input"
							type="time"
							value={form.settings.dimTo}
							onInput={(e) => setting("dimTo", e.currentTarget.value)}
						/>
					</FormField>
					<label class="flex cursor-pointer items-center justify-between gap-3 text-sm sm:col-span-2">
						<span>
							Pixel shift{" "}
							<span class="text-xs text-muted">· moves the picture slightly every minute against burn-in</span>
						</span>
						<input
							type="checkbox"
							class="size-4 accent-[var(--accent)]"
							checked={form.settings.pixelShift}
							onChange={(e) => setting("pixelShift", e.currentTarget.checked)}
						/>
					</label>
					<label class="flex cursor-pointer items-center justify-between gap-3 text-sm sm:col-span-2">
						<span>
							White on black <span class="text-xs text-muted">· ePaper modes only</span>
						</span>
						<input
							type="checkbox"
							class="size-4 accent-[var(--accent)]"
							checked={form.settings.invert}
							onChange={(e) => setting("invert", e.currentTarget.checked)}
						/>
					</label>
					<label class="flex cursor-pointer items-center justify-between gap-3 text-sm sm:col-span-2">
						<span>
							"Offline" badge <span class="text-xs text-muted">· when the screen loses the server</span>
						</span>
						<input
							type="checkbox"
							class="size-4 accent-[var(--accent)]"
							checked={form.settings.offlineBadge}
							onChange={(e) => setting("offlineBadge", e.currentTarget.checked)}
						/>
					</label>
				</div>
			</Fold>
		</Modal>
	);
}
