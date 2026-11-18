/**
 * Playlists: named lists of layouts that any number of displays can show.
 * `EntryList` is the list editor itself, which the display form uses too for
 * the layouts a display keeps to itself.
 */
import {
	ArrowDown,
	ArrowUp,
	ChevronDown,
	ChevronRight,
	Copy,
	LayoutDashboard,
	Monitor,
	Pencil,
	Plus,
	Trash2,
} from "lucide-solid";
import { createSignal, For, Show } from "solid-js";
import { createStore, type SetStoreFunction, unwrap } from "solid-js/store";
import type { Layout, Playlist, PlaylistEntry } from "../../shared/types";
import { api } from "../lib/api";
import { DaysInput } from "./fields";
import { displays, layouts, navigate, playlists, refetchDisplays, refetchLayouts, refetchPlaylists } from "./state";
import { attempt, confirmAction, EmptyState, FormField, Modal, PageHeader, toast } from "./ui";

const layoutLabel = (l: Layout) => `${l.folder ? `${l.folder} / ` : ""}${l.name}${l.archivedAt ? " (archived)" : ""}`;
const isScheduled = (entry: PlaylistEntry) => Boolean(entry.days.length || entry.from || entry.to);

/** Edits a list of layouts in place: which ones, in what order, for how long and when. */
export function EntryList(props: { entries: PlaylistEntry[]; set: SetStoreFunction<PlaylistEntry[]>; empty: string }) {
	const [scheduling, setScheduling] = createSignal<number | null>(null);
	/** The layouts an entry can pick: archived ones are left out, except the one it already shows. */
	const pickable = (keep?: string) => (layouts() ?? []).filter((l) => !l.archivedAt || l.id === keep);
	const add = (layoutId: string) =>
		layoutId && props.set(props.entries.length, { layoutId, seconds: 30, days: [], from: "", to: "" });
	const move = (index: number, by: number) => {
		const next = [...unwrap(props.entries)];
		const target = index + by;
		if (target < 0 || target >= next.length) return;
		[next[index], next[target]] = [next[target]!, next[index]!];
		setScheduling(null);
		props.set(next);
	};
	const remove = (index: number) => {
		setScheduling(null);
		props.set(unwrap(props.entries).filter((_, i) => i !== index));
	};

	return (
		<div class="space-y-1.5">
			<For each={props.entries} fallback={<p class="help !mt-0">{props.empty}</p>}>
				{(entry, i) => (
					<div class="rounded-lg border border-line bg-raised/50 p-2">
						<div class="flex items-center gap-1.5">
							<select
								class="input"
								value={entry.layoutId}
								aria-label="Layout"
								onChange={(e) => props.set(i(), "layoutId", e.currentTarget.value)}
							>
								<For each={pickable(entry.layoutId)}>{(l) => <option value={l.id}>{layoutLabel(l)}</option>}</For>
							</select>
							<Show when={props.entries.length > 1}>
								<input
									class="input !w-20"
									type="number"
									min="3"
									value={entry.seconds}
									aria-label="Seconds"
									title="Seconds on screen"
									onInput={(e) => props.set(i(), "seconds", Number(e.currentTarget.value) || 30)}
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
									disabled={i() === props.entries.length - 1}
									onClick={() => move(i(), 1)}
									aria-label="Move down"
								>
									<ArrowDown />
								</button>
							</Show>
							<button
								type="button"
								class="btn btn-ghost btn-icon btn-danger !p-1"
								onClick={() => remove(i())}
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
							{isScheduled(entry) ? "Scheduled" : "Always shown"}
						</button>
						<Show when={scheduling() === i()}>
							<div class="mt-2 space-y-2">
								<DaysInput value={entry.days} set={(days) => props.set(i(), "days", days)} />
								<div class="flex items-center gap-2 text-xs text-muted">
									from
									<input
										class="input"
										type="time"
										value={entry.from}
										onInput={(e) => props.set(i(), "from", e.currentTarget.value)}
									/>
									to
									<input
										class="input"
										type="time"
										value={entry.to}
										onInput={(e) => props.set(i(), "to", e.currentTarget.value)}
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
					add(e.currentTarget.value);
					e.currentTarget.value = "";
				}}
			>
				<option value="">+ Add a layout…</option>
				<For each={pickable()}>{(l) => <option value={l.id}>{layoutLabel(l)}</option>}</For>
			</select>
		</div>
	);
}

/** A list of layouts, read-only: what a playlist holds, at a glance. */
export function EntrySummary(props: { entries: PlaylistEntry[] }) {
	const layoutOf = (entry: PlaylistEntry) => (layouts() ?? []).find((l) => l.id === entry.layoutId);
	return (
		<div class="flex flex-wrap gap-1.5">
			<For each={props.entries} fallback={<span class="badge">No layout</span>}>
				{(entry) => (
					<Show when={layoutOf(entry)}>
						{(layout) => (
							<button
								type="button"
								class="badge max-w-full hover:border-accent hover:text-ink"
								onClick={() => navigate(`layouts/${layout().id}`)}
								title={`Edit the layout "${layout().name}"`}
							>
								<LayoutDashboard class="size-3 shrink-0" />
								<span class="truncate">{layout().name}</span>
								<Show when={props.entries.length > 1}>
									<span class="text-muted">{entry.seconds} s</span>
								</Show>
								<Show when={isScheduled(entry)}>
									<span class="text-muted">· scheduled</span>
								</Show>
							</button>
						)}
					</Show>
				)}
			</For>
		</div>
	);
}

export function PlaylistsPage() {
	const [editing, setEditing] = createSignal<Playlist | "new" | null>(null);
	void refetchPlaylists();
	void refetchLayouts();
	void refetchDisplays();

	const followers = (playlist: Playlist) => (displays() ?? []).filter((d) => d.playlistId === playlist.id);
	const duplicate = async (playlist: Playlist) => {
		await attempt(
			() => api("api/playlists", { body: { name: `${playlist.name} (copy)`, entries: playlist.entries } }),
			"Playlist duplicated.",
		);
		void refetchPlaylists();
	};
	const remove = async (playlist: Playlist) => {
		const used = followers(playlist).length;
		const text = used
			? `"${playlist.name}" is shown on ${used} display${used > 1 ? "s" : ""}. ${used > 1 ? "They keep" : "It keeps"} showing the same layouts, as ${used > 1 ? "their" : "its"} own list.`
			: `"${playlist.name}" will be deleted for good. Its layouts are kept.`;
		if (!(await confirmAction("Delete this playlist?", text))) return;
		await attempt(() => api(`api/playlists/${playlist.id}`, { method: "DELETE" }), "Playlist deleted.");
		void refetchPlaylists();
		void refetchDisplays();
	};

	return (
		<>
			<PageHeader
				title="Playlists"
				subtitle="A playlist is a list of layouts to cycle through. Change it once, and every display showing it follows."
			>
				<button type="button" class="btn btn-primary" onClick={() => setEditing("new")}>
					<Plus /> New playlist
				</button>
			</PageHeader>

			<Show
				when={playlists()?.length}
				fallback={
					<Show when={playlists()}>
						<EmptyState
							title="No playlists yet"
							text="Pick the layouts to show in turn, then choose the playlist on each display that should show them. A display can also keep a list of layouts of its own."
						>
							<button type="button" class="btn btn-primary" onClick={() => setEditing("new")}>
								<Plus /> New playlist
							</button>
						</EmptyState>
					</Show>
				}
			>
				<div class="grid gap-4 lg:grid-cols-2">
					<For each={playlists()}>
						{(playlist) => (
							<div class="card flex flex-col gap-2 p-4">
								<h2 class="truncate text-base font-semibold">{playlist.name}</h2>
								<EntrySummary entries={playlist.entries} />
								<div class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
									<Show when={followers(playlist).length} fallback="Not on any display">
										<span>Shown on</span>
										<For each={followers(playlist)}>
											{(display) => (
												<span class="badge max-w-40">
													<Monitor class="size-3 shrink-0" />
													<span class="truncate">{display.name}</span>
												</span>
											)}
										</For>
									</Show>
								</div>
								<div class="mt-auto flex gap-1 pt-1">
									<button type="button" class="btn" onClick={() => setEditing(playlist)}>
										<Pencil /> Edit
									</button>
									<div class="flex-1" />
									<button
										type="button"
										class="btn btn-icon"
										onClick={() => duplicate(playlist)}
										title="Duplicate"
										aria-label="Duplicate"
									>
										<Copy />
									</button>
									<button
										type="button"
										class="btn btn-icon btn-danger"
										onClick={() => remove(playlist)}
										title="Delete"
										aria-label="Delete"
									>
										<Trash2 />
									</button>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>

			<Show when={editing()} keyed>
				{(target) => (
					<PlaylistEditor
						playlist={target === "new" ? null : target}
						onClose={() => {
							setEditing(null);
							void refetchPlaylists();
						}}
					/>
				)}
			</Show>
		</>
	);
}

function PlaylistEditor(props: { playlist: Playlist | null; onClose: () => void }) {
	const [name, setName] = createSignal(props.playlist?.name ?? "");
	const [entries, setEntries] = createStore<PlaylistEntry[]>(structuredClone(props.playlist?.entries ?? []));

	const save = async () => {
		if (!name().trim()) return toast("Give the playlist a name.", "error");
		const body = { name: name(), entries: unwrap(entries) };
		const result = props.playlist
			? await attempt(() => api(`api/playlists/${props.playlist!.id}`, { method: "PUT", body }), "Playlist saved.")
			: await attempt(() => api("api/playlists", { body }), "Playlist created.");
		if (result) props.onClose();
	};

	return (
		<Modal
			title={props.playlist ? "Edit playlist" : "New playlist"}
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
					value={name()}
					placeholder="Evening rotation, Weekend specials…"
					onInput={(e) => setName(e.currentTarget.value)}
				/>
			</FormField>
			<div>
				<div class="label">Layouts</div>
				<EntryList
					entries={entries}
					set={setEntries}
					empty="Add the layouts to show, in order. Each stays up for its number of seconds."
				/>
			</div>
		</Modal>
	);
}
