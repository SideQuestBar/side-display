import {
	ChevronLeft,
	ChevronRight,
	Download,
	FolderInput,
	FolderPlus,
	LayoutGrid,
	List,
	Pencil,
	Search,
	Trash2,
	Upload,
	X,
} from "lucide-solid";
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { MediaItem } from "../../shared/types";
import { api, mediaUrl } from "../lib/api";
import { MediaThumb, uploadFiles } from "./fields";
import { albums, media, refetchMedia } from "./state";
import { attempt, confirmAction, EmptyState, FormField, formatBytes, Modal, PageHeader } from "./ui";

// ---------------------------------------------------------------- preferences

const SORTS = {
	newest: { label: "Newest first", compare: (a: MediaItem, b: MediaItem) => b.createdAt - a.createdAt },
	oldest: { label: "Oldest first", compare: (a: MediaItem, b: MediaItem) => a.createdAt - b.createdAt },
	name: { label: "Name A–Z", compare: (a: MediaItem, b: MediaItem) => byName(a, b) },
	nameDesc: { label: "Name Z–A", compare: (a: MediaItem, b: MediaItem) => byName(b, a) },
	largest: { label: "Largest first", compare: (a: MediaItem, b: MediaItem) => b.size - a.size },
	smallest: { label: "Smallest first", compare: (a: MediaItem, b: MediaItem) => a.size - b.size },
};
type Sort = keyof typeof SORTS;
const byName = (a: MediaItem, b: MediaItem) =>
	a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

const KINDS = { all: "All types", image: "Pictures", video: "Videos", document: "PDFs" };
type Kind = keyof typeof KINDS;
const KIND_LABEL: Record<MediaItem["kind"], string> = { image: "Picture", video: "Video", document: "PDF" };

/** How the library is laid out; remembered per browser. */
interface Prefs {
	view: "grid" | "list";
	/** Least width of a tile, in px. */
	size: number;
	sort: Sort;
}
const PREFS_KEY = "sidedisplay:media";
const SIZES = { min: 90, max: 320, default: 160 };

function loadPrefs(): Prefs {
	let stored: Partial<Prefs> = {};
	try {
		stored = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") ?? {};
	} catch {
		// Unreadable preferences are as good as none.
	}
	const size = Number(stored.size);
	return {
		view: stored.view === "list" ? "list" : "grid",
		size: size >= SIZES.min && size <= SIZES.max ? size : SIZES.default,
		sort: stored.sort && stored.sort in SORTS ? stored.sort : "newest",
	};
}

/**
 * Albums made here that hold nothing yet. An album is only the name its files
 * carry, so an empty one lives in this tab until something is put in it.
 */
const [emptyAlbums, setEmptyAlbums] = createSignal<string[]>([]);

/** The choice in an album list that asks for a new name; no album can be called this, names being trimmed. */
const NEW_ALBUM = " new ";

/** Marks the data of a drag that started on a library file, to tell it from files dropped for upload. */
const DRAG_TYPE = "application/x-sidedisplay-media";

const isTyping = (event: Event) =>
	event.target instanceof HTMLElement && event.target.matches("input, textarea, select, [contenteditable]");

// ----------------------------------------------------------------------- page

export function MediaPage() {
	/** null = everything, "" = the files in no album. */
	const [album, setAlbum] = createSignal<string | null>(null);
	const [query, setQuery] = createSignal("");
	const [kind, setKind] = createSignal<Kind>("all");
	const [prefs, setPrefsSignal] = createSignal(loadPrefs());
	const setPrefs = (change: Partial<Prefs>) => {
		setPrefsSignal({ ...prefs(), ...change });
		localStorage.setItem(PREFS_KEY, JSON.stringify(prefs()));
	};

	const [uploading, setUploading] = createSignal(false);
	const [over, setOver] = createSignal(false);
	const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
	/** Where a shift-click range starts. */
	let anchor: string | null = null;
	const [dragIds, setDragIds] = createSignal<string[] | null>(null);
	const [dropOn, setDropOn] = createSignal<string | undefined>();
	const [openId, setOpenId] = createSignal<string | null>(null);
	const [naming, setNaming] = createSignal<"new" | "rename" | null>(null);
	void refetchMedia();

	const all = () => media() ?? [];
	const albumNames = createMemo(() => [...new Set([...albums(), ...emptyAlbums()])].sort((a, b) => a.localeCompare(b)));
	const counts = createMemo(() => {
		const map = new Map<string, number>();
		for (const m of all()) map.set(m.album, (map.get(m.album) ?? 0) + 1);
		return map;
	});
	const shown = createMemo(() => {
		const words = query().toLowerCase().split(/\s+/).filter(Boolean);
		return all()
			.filter((m) => album() === null || m.album === album())
			.filter((m) => kind() === "all" || m.kind === kind())
			.filter((m) => {
				const text = `${m.name} ${m.album}`.toLowerCase();
				return words.every((word) => text.includes(word));
			})
			.sort(SORTS[prefs().sort].compare);
	});
	const filtered = () => query().trim() !== "" || kind() !== "all";
	const opened = createMemo(() => all().find((m) => m.id === openId()) ?? null);

	// Leave an album once its last file is gone.
	createEffect(() => {
		const current = album();
		if (!media()) return;
		if (current && !albumNames().includes(current)) setAlbum(null);
		if (current === "" && !counts().get("")) setAlbum(null);
	});

	// ------------------------------------------------------------- selection
	const clearSelection = () => {
		setSelected(new Set<string>());
		anchor = null;
	};
	const toggle = (item: MediaItem, range: boolean) => {
		const next = new Set(selected());
		const ids = shown().map((m) => m.id);
		const from = anchor ? ids.indexOf(anchor) : -1;
		const to = ids.indexOf(item.id);
		if (range && from >= 0 && to >= 0) {
			for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(id);
		} else if (next.has(item.id)) next.delete(item.id);
		else next.add(item.id);
		anchor = item.id;
		setSelected(next);
	};
	/** A click on a file: opens it, or picks it while a selection is being made. */
	const activate = (item: MediaItem, event: MouseEvent) => {
		if (event.shiftKey || event.ctrlKey || event.metaKey || selected().size) toggle(item, event.shiftKey);
		else setOpenId(item.id);
	};
	const selectedItems = () => all().filter((m) => selected().has(m.id));

	onMount(() => {
		const onKey = (event: KeyboardEvent) => {
			if (isTyping(event) || naming()) return;
			const current = opened();
			if (current) {
				const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
				const next = shown()[shown().indexOf(current) + step];
				if (step && next) setOpenId(next.id);
			} else if (event.key === "Escape") clearSelection();
			else if (event.key === "a" && (event.ctrlKey || event.metaKey) && shown().length) {
				event.preventDefault();
				setSelected(new Set(shown().map((m) => m.id)));
			}
		};
		window.addEventListener("keydown", onKey);
		onCleanup(() => window.removeEventListener("keydown", onKey));
	});

	// --------------------------------------------------------------- actions
	const upload = async (files: FileList | File[] | null | undefined) => {
		if (!files?.length) return;
		setUploading(true);
		// New files land in the album being looked at.
		await uploadFiles(files, album() ?? "");
		setUploading(false);
	};
	const move = async (ids: string[], to: string) => {
		const name = to.trim();
		const moving = all().filter((m) => ids.includes(m.id) && m.album !== name);
		if (moving.length) {
			const files = moving.length === 1 ? `"${moving[0]!.name}"` : `${moving.length} files`;
			await attempt(
				() => api("api/media", { method: "PATCH", body: { ids: moving.map((m) => m.id), album: name } }),
				name
					? `${files} moved to "${name}".`
					: `${files} taken out of ${moving.length === 1 ? "its album" : "their albums"}.`,
			);
			await refetchMedia();
		}
		clearSelection();
	};
	const remove = async (items: MediaItem[]) => {
		if (!items.length) return;
		const one = items.length === 1 ? items[0]! : null;
		if (
			!(await confirmAction(
				one ? "Delete this file?" : `Delete ${items.length} files?`,
				`${one ? `"${one.name}"` : "They"} will be removed from the library and from any layout using ${one ? "it" : "them"}.`,
			))
		)
			return;
		await attempt(
			async () => {
				for (const item of items) await api(`api/media/${item.id}`, { method: "DELETE" });
			},
			one ? "File deleted." : `${items.length} files deleted.`,
		);
		setOpenId(null);
		clearSelection();
		void refetchMedia();
	};
	const patch = async (item: MediaItem, change: { name?: string; album?: string }) => {
		await attempt(() => api(`api/media/${item.id}`, { method: "PATCH", body: change }));
		void refetchMedia();
	};
	const createAlbum = async (name: string) => {
		if (selected().size) await move([...selected()], name);
		else if (!albumNames().includes(name)) setEmptyAlbums([...emptyAlbums(), name]);
		setAlbum(name);
	};
	const renameAlbum = async (from: string, to: string) => {
		if (to === from) return;
		const ids = all()
			.filter((m) => m.album === from)
			.map((m) => m.id);
		setEmptyAlbums([...emptyAlbums().filter((a) => a !== from), to]);
		setAlbum(to);
		if (ids.length) {
			await attempt(() => api("api/media", { method: "PATCH", body: { ids, album: to } }), "Album renamed.");
			await refetchMedia();
		}
	};

	// ------------------------------------------------------------ drag source
	const dragProps = (item: MediaItem) => ({
		draggable: true,
		onDragStart: (event: DragEvent) => {
			event.dataTransfer?.setData(DRAG_TYPE, item.id);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
			// Dragging one of the selected files takes the whole selection along.
			setDragIds(selected().has(item.id) ? [...selected()] : [item.id]);
		},
		onDragEnd: () => {
			setDragIds(null);
			setDropOn(undefined);
		},
	});

	const AlbumChip = (chip: { value: string | null; label: string; count: number }) => {
		const droppable = () => dragIds() !== null && chip.value !== null;
		return (
			<button
				type="button"
				class="btn"
				classList={{
					"!border-accent": album() === chip.value,
					"border-dashed": droppable(),
					"!border-accent !bg-accent-bg/30": droppable() && dropOn() === chip.value,
				}}
				aria-pressed={album() === chip.value}
				onClick={() => setAlbum(chip.value)}
				onDragOver={(event) => {
					if (!droppable()) return;
					event.preventDefault();
					setDropOn(chip.value ?? undefined);
				}}
				onDragLeave={() => dropOn() === chip.value && setDropOn(undefined)}
				onDrop={(event) => {
					const ids = dragIds();
					if (!ids || chip.value === null) return;
					event.preventDefault();
					event.stopPropagation();
					void move(ids, chip.value);
				}}
			>
				{chip.label}
				<span class="text-xs text-muted">{chip.count}</span>
			</button>
		);
	};

	const Checkbox = (box: { item: MediaItem; class?: string }) => (
		<input
			type="checkbox"
			class={`size-4 cursor-pointer ${box.class ?? ""}`}
			checked={selected().has(box.item.id)}
			aria-label={`Select ${box.item.name}`}
			onClick={(event) => {
				event.stopPropagation();
				toggle(box.item, event.shiftKey);
			}}
		/>
	);

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: whole-page drop target for uploads
		<div
			class="min-h-full"
			onDragOver={(e) => {
				if (!e.dataTransfer?.types.includes("Files")) return;
				e.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				e.preventDefault();
				setOver(false);
				void upload(e.dataTransfer?.files);
			}}
		>
			<PageHeader title="Media" subtitle="Pictures, videos and PDFs for your layouts. Albums feed gallery elements.">
				<button type="button" class="btn" onClick={() => setNaming("new")}>
					<FolderPlus /> New album
				</button>
				<label class="btn btn-primary cursor-pointer">
					<Upload /> {uploading() ? "Uploading…" : "Upload"}
					<input
						type="file"
						class="hidden"
						multiple
						accept="image/*,video/mp4,video/webm,video/quicktime,application/pdf"
						onChange={(e) => {
							void upload(e.currentTarget.files);
							e.currentTarget.value = "";
						}}
					/>
				</label>
			</PageHeader>

			<Show when={albumNames().length}>
				<div class="mb-3 flex flex-wrap items-center gap-1.5">
					<AlbumChip value={null} label="Everything" count={all().length} />
					<For each={albumNames()}>
						{(name) => <AlbumChip value={name} label={name} count={counts().get(name) ?? 0} />}
					</For>
					<Show when={counts().get("") || dragIds()}>
						<AlbumChip value="" label="No album" count={counts().get("") ?? 0} />
					</Show>
					<Show when={album()}>
						<button
							type="button"
							class="btn btn-ghost btn-icon"
							onClick={() => setNaming("rename")}
							title="Rename this album"
							aria-label="Rename this album"
						>
							<Pencil />
						</button>
					</Show>
				</div>
			</Show>

			<Show when={all().length}>
				<div class="mb-2 flex flex-wrap items-center gap-2">
					<div class="relative min-w-40 flex-1">
						<Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
						<input
							class="input !bg-surface !pl-8"
							type="search"
							placeholder="Search by name or album"
							aria-label="Search"
							value={query()}
							onInput={(e) => setQuery(e.currentTarget.value)}
						/>
					</div>
					<select
						class="input !w-auto !bg-surface"
						aria-label="Type of file"
						value={kind()}
						onChange={(e) => setKind(e.currentTarget.value as Kind)}
					>
						<For each={Object.entries(KINDS)}>{([value, label]) => <option value={value}>{label}</option>}</For>
					</select>
					<select
						class="input !w-auto !bg-surface"
						aria-label="Sort"
						value={prefs().sort}
						onChange={(e) => setPrefs({ sort: e.currentTarget.value as Sort })}
					>
						<For each={Object.entries(SORTS)}>{([value, sort]) => <option value={value}>{sort.label}</option>}</For>
					</select>
					<Show when={prefs().view === "grid"}>
						<input
							type="range"
							class="w-24"
							min={SIZES.min}
							max={SIZES.max}
							step="10"
							value={prefs().size}
							title="Tile size"
							aria-label="Tile size"
							onInput={(e) => setPrefs({ size: Number(e.currentTarget.value) })}
						/>
					</Show>
					<div class="flex">
						<button
							type="button"
							class="btn btn-icon rounded-r-none"
							classList={{ "!border-accent z-1": prefs().view === "grid" }}
							aria-pressed={prefs().view === "grid"}
							onClick={() => setPrefs({ view: "grid" })}
							title="Tiles"
							aria-label="Show as tiles"
						>
							<LayoutGrid />
						</button>
						<button
							type="button"
							class="btn btn-icon -ml-px rounded-l-none"
							classList={{ "!border-accent z-1": prefs().view === "list" }}
							aria-pressed={prefs().view === "list"}
							onClick={() => setPrefs({ view: "list" })}
							title="List"
							aria-label="Show as a list"
						>
							<List />
						</button>
					</div>
				</div>
				<Show when={shown().length}>
					<div class="mb-3 flex items-center gap-3 text-xs text-muted">
						<span>
							{shown().length} file{shown().length === 1 ? "" : "s"} ·{" "}
							{formatBytes(shown().reduce((sum, m) => sum + m.size, 0))}
						</span>
						<Show when={selected().size < shown().length}>
							<button
								type="button"
								class="font-medium hover:text-ink"
								onClick={() => setSelected(new Set(shown().map((m) => m.id)))}
							>
								Select all
							</button>
						</Show>
					</div>
				</Show>
			</Show>

			<Show
				when={shown().length}
				fallback={
					<Show when={media()}>
						<Show
							when={filtered() && all().length}
							fallback={
								<EmptyState
									title={over() ? "Drop to upload" : album() ? `"${album()}" is empty` : "Nothing here yet"}
									text={
										album()
											? "Drop files here or use the Upload button to add them to this album, or drag files from the library onto its name. An album is kept as long as a file is in it."
											: "Drop files anywhere on this page, or use the Upload button. JPEG, PNG, WebP, GIF, SVG, MP4, WebM and PDF are supported."
									}
								/>
							}
						>
							<EmptyState title="Nothing matches" text="No file here fits the search and the type chosen.">
								<button
									type="button"
									class="btn"
									onClick={() => {
										setQuery("");
										setKind("all");
									}}
								>
									Clear the filters
								</button>
							</EmptyState>
						</Show>
					</Show>
				}
			>
				<Show
					when={prefs().view === "grid"}
					fallback={
						<div class="card overflow-x-auto" classList={{ "opacity-50": over() }}>
							<table class="w-full text-left text-sm">
								<thead class="border-b border-line text-xs text-muted">
									<tr>
										<th class="w-8 py-2 pl-3" />
										<th class="px-2 py-2 font-semibold">Name</th>
										<th class="px-2 py-2 font-semibold">Album</th>
										<th class="hidden px-2 py-2 font-semibold sm:table-cell">Type</th>
										<th class="hidden px-2 py-2 font-semibold md:table-cell">Dimensions</th>
										<th class="px-2 py-2 text-right font-semibold">Size</th>
										<th class="hidden py-2 pr-3 pl-2 text-right font-semibold sm:table-cell">Added</th>
									</tr>
								</thead>
								<tbody>
									<For each={shown()}>
										{(item) => (
											<tr
												class="cursor-pointer border-b border-line last:border-0 hover:bg-raised"
												classList={{
													"bg-accent-bg/15": selected().has(item.id),
													"opacity-40": dragIds()?.includes(item.id),
												}}
												onClick={(event) => activate(item, event)}
												{...dragProps(item)}
											>
												<td class="py-1.5 pl-3">
													<Checkbox item={item} class="block" />
												</td>
												<td class="max-w-0 w-1/2 px-2 py-1.5">
													<button type="button" class="flex w-full min-w-0 items-center gap-2.5 text-left">
														<span class="block w-9 shrink-0 overflow-hidden rounded">
															<MediaThumb item={item} width={40} />
														</span>
														<span class="truncate font-medium">{item.name}</span>
													</button>
												</td>
												<td class="max-w-0 w-1/4 truncate px-2 py-1.5 text-muted">{item.album || "–"}</td>
												<td class="hidden px-2 py-1.5 text-muted sm:table-cell">{KIND_LABEL[item.kind]}</td>
												<td class="hidden px-2 py-1.5 whitespace-nowrap text-muted md:table-cell">
													{item.width ? `${item.width} × ${item.height}` : "–"}
												</td>
												<td class="px-2 py-1.5 text-right whitespace-nowrap text-muted">{formatBytes(item.size)}</td>
												<td class="hidden py-1.5 pr-3 pl-2 text-right whitespace-nowrap text-muted sm:table-cell">
													{new Date(item.createdAt).toLocaleDateString()}
												</td>
											</tr>
										)}
									</For>
								</tbody>
							</table>
						</div>
					}
				>
					<div
						class="grid gap-3"
						classList={{ "opacity-50": over() }}
						style={{ "grid-template-columns": `repeat(auto-fill, minmax(min(${prefs().size}px, 45%), 1fr))` }}
					>
						<For each={shown()}>
							{(item) => (
								// biome-ignore lint/a11y/noStaticElementInteractions: drag source; the button inside handles the keyboard
								// biome-ignore lint/a11y/useKeyWithClickEvents: as above
								<div
									class="group card relative cursor-pointer overflow-hidden hover:border-accent"
									classList={{
										"!border-accent ring-2 ring-accent/60": selected().has(item.id),
										"opacity-40": dragIds()?.includes(item.id),
									}}
									onClick={(event) => activate(item, event)}
									{...dragProps(item)}
								>
									<MediaThumb item={item} width={prefs().size} />
									<Checkbox
										item={item}
										class={`absolute top-2 left-2 focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100 ${
											selected().size ? "" : "opacity-0"
										}`}
									/>
									<button type="button" class="block w-full px-2 py-1.5 text-left">
										<div class="truncate text-xs font-medium">{item.name}</div>
										<Show when={prefs().size >= 130}>
											<div class="truncate text-[11px] text-muted">
												{item.album || "No album"} · {formatBytes(item.size)}
											</div>
										</Show>
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
			</Show>

			<Show when={selected().size}>
				<div class="pointer-events-none sticky bottom-0 z-10 mt-4 flex justify-center pb-1">
					<div class="card pointer-events-auto flex flex-wrap items-center gap-2 px-3 py-2 shadow-xl">
						<span class="px-1 text-sm font-semibold">{selected().size} selected</span>
						<AlbumMenu names={albumNames()} onPick={(name) => move([...selected()], name)} />
						<button type="button" class="btn btn-danger" onClick={() => remove(selectedItems())}>
							<Trash2 /> Delete
						</button>
						<button
							type="button"
							class="btn btn-ghost btn-icon"
							onClick={clearSelection}
							title="Clear the selection"
							aria-label="Clear the selection"
						>
							<X />
						</button>
					</div>
				</div>
			</Show>

			<Show when={naming()} keyed>
				{(mode) => {
					const from = mode === "rename" ? (album() ?? "") : "";
					const [name, setName] = createSignal(from);
					const submit = async () => {
						const value = name().trim();
						if (!value) return;
						setNaming(null);
						if (mode === "rename") await renameAlbum(from, value);
						else await createAlbum(value);
					};
					return (
						<Modal
							title={mode === "rename" ? "Rename the album" : "New album"}
							onClose={() => setNaming(null)}
							footer={
								<>
									<button type="button" class="btn" onClick={() => setNaming(null)}>
										Cancel
									</button>
									<button type="button" class="btn btn-primary" disabled={!name().trim()} onClick={submit}>
										{mode === "rename"
											? "Rename"
											: selected().size
												? `Create with ${selected().size} selected`
												: "Create"}
									</button>
								</>
							}
						>
							<FormField
								label="Name"
								help={
									mode === "rename"
										? "Gallery elements that show this album by name have to be pointed at the new name."
										: selected().size
											? "The selected files move into the new album."
											: "Then upload into it, or drag files onto its name. An album is kept as long as a file is in it."
								}
							>
								<input
									class="input"
									maxLength={60}
									value={name()}
									ref={(el) => requestAnimationFrame(() => el.select())}
									onInput={(e) => setName(e.currentTarget.value)}
									onKeyDown={(e) => e.key === "Enter" && void submit()}
								/>
							</FormField>
						</Modal>
					);
				}}
			</Show>

			<Show when={opened()} keyed>
				{(item) => {
					const [name, setName] = createSignal(item.name);
					const [itemAlbum, setItemAlbum] = createSignal(item.album);
					// "New album…" in the list swaps the choice for a name to type.
					const [creating, setCreating] = createSignal(false);
					const [newAlbum, setNewAlbum] = createSignal("");
					const chosenAlbum = () => (creating() ? newAlbum().trim() || item.album : itemAlbum());
					const src = `media/${item.file}`;
					const neighbour = (step: number) => shown()[shown().indexOf(item) + step];
					const Step = (arrow: { by: number }) => (
						<Show when={neighbour(arrow.by)}>
							{(next) => (
								<button
									type="button"
									class="btn btn-icon absolute top-1/2 -translate-y-1/2 shadow"
									classList={{ "left-2": arrow.by < 0, "right-2": arrow.by > 0 }}
									onClick={() => setOpenId(next().id)}
									title={arrow.by < 0 ? "Previous" : "Next"}
									aria-label={arrow.by < 0 ? "Previous file" : "Next file"}
								>
									<Show when={arrow.by < 0} fallback={<ChevronRight />}>
										<ChevronLeft />
									</Show>
								</button>
							)}
						</Show>
					);
					return (
						<Modal
							title="File details"
							wide
							onClose={() => setOpenId(null)}
							footer={
								<>
									<button type="button" class="btn btn-danger mr-auto" onClick={() => remove([item])}>
										<Trash2 /> Delete
									</button>
									<a
										class="btn"
										href={mediaUrl(src)}
										download={`${item.name}${item.file.slice(item.file.lastIndexOf("."))}`}
									>
										<Download /> Download
									</a>
									<button type="button" class="btn" onClick={() => setOpenId(null)}>
										Cancel
									</button>
									<button
										type="button"
										class="btn btn-primary"
										onClick={async () => {
											await patch(item, { name: name(), album: chosenAlbum() });
											setOpenId(null);
										}}
									>
										Save
									</button>
								</>
							}
						>
							<div class="relative flex min-h-40 items-center justify-center overflow-hidden rounded-lg bg-black/10">
								<Show
									when={item.kind !== "document"}
									fallback={<div class="py-16 text-lg font-semibold text-muted">PDF</div>}
								>
									<Show
										when={item.kind === "image"}
										fallback={
											// biome-ignore lint/a11y/useMediaCaption: an uploaded file has no captions
											<video src={mediaUrl(src)} controls preload="metadata" class="max-h-[65vh] max-w-full" />
										}
									>
										{/* The whole picture, in its own shape; the size reserves the room while it loads. */}
										<img
											src={mediaUrl(src, 1920)}
											alt={item.name}
											width={item.width ?? undefined}
											height={item.height ?? undefined}
											class="h-auto max-h-[65vh] w-auto max-w-full object-contain"
										/>
									</Show>
								</Show>
								<Step by={-1} />
								<Step by={1} />
							</div>
							<p class="text-center text-xs text-muted">
								{item.mime} · {formatBytes(item.size)}
								{item.width ? ` · ${item.width} × ${item.height}` : ""} · added{" "}
								{new Date(item.createdAt).toLocaleDateString()}
							</p>
							<div class="grid gap-4 sm:grid-cols-2">
								<FormField label="Name">
									<input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} />
								</FormField>
								<FormField label="Album">
									<select
										class="input"
										onChange={(e) => {
											setCreating(e.currentTarget.value === NEW_ALBUM);
											if (!creating()) setItemAlbum(e.currentTarget.value);
										}}
									>
										<option value="" selected={!creating() && itemAlbum() === ""}>
											No album
										</option>
										<For each={albumNames()}>
											{(a) => (
												<option value={a} selected={!creating() && itemAlbum() === a}>
													{a}
												</option>
											)}
										</For>
										<option value={NEW_ALBUM} selected={creating()}>
											New album…
										</option>
									</select>
									<Show when={creating()}>
										<input
											class="input mt-2"
											maxLength={60}
											placeholder="Name of the new album"
											aria-label="Name of the new album"
											value={newAlbum()}
											ref={(el) => requestAnimationFrame(() => el.focus())}
											onInput={(e) => setNewAlbum(e.currentTarget.value)}
										/>
									</Show>
								</FormField>
							</div>
						</Modal>
					);
				}}
			</Show>
		</div>
	);
}

/** "Move to album": the albums there are, filtered as a name is typed, and a way to make a new one from that name. */
function AlbumMenu(props: { names: string[]; onPick: (album: string) => void }) {
	const [open, setOpen] = createSignal(false);
	const [text, setText] = createSignal("");
	const typed = () => text().trim();
	const matches = () => props.names.filter((name) => name.toLowerCase().includes(typed().toLowerCase()));
	const isNew = () => typed() !== "" && !props.names.some((name) => name.toLowerCase() === typed().toLowerCase());
	const pick = (album: string) => {
		setOpen(false);
		setText("");
		props.onPick(album);
	};
	const row = "block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-raised";
	return (
		<div class="relative">
			<button type="button" class="btn" aria-expanded={open()} onClick={() => setOpen(!open())}>
				<FolderInput /> Move to album
			</button>
			<Show when={open()}>
				<div class="fixed inset-0 z-20" onPointerDown={() => setOpen(false)} />
				<div class="card absolute bottom-full left-0 z-30 mb-2 w-60 p-1.5 shadow-2xl">
					<input
						class="input mb-1"
						placeholder="Find or name a new album"
						aria-label="Album"
						maxLength={60}
						value={text()}
						ref={(el) => requestAnimationFrame(() => el.focus())}
						onInput={(e) => setText(e.currentTarget.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								e.stopPropagation();
								setOpen(false);
							}
							if (e.key !== "Enter" || !typed()) return;
							// The album typed if there is one, whatever its case; otherwise a new one.
							pick(props.names.find((name) => name.toLowerCase() === typed().toLowerCase()) ?? typed());
						}}
					/>
					<div class="max-h-56 overflow-y-auto">
						<Show when={isNew()}>
							<button type="button" class={`${row} font-medium`} onClick={() => pick(typed())}>
								<FolderPlus class="mr-1.5 inline size-4 align-text-bottom" />
								Create "{typed()}"
							</button>
						</Show>
						<For each={matches()}>
							{(name) => (
								<button type="button" class={row} onClick={() => pick(name)}>
									{name}
								</button>
							)}
						</For>
						<Show when={!typed()}>
							<button type="button" class={`${row} text-muted`} onClick={() => pick("")}>
								No album
							</button>
						</Show>
					</div>
				</div>
			</Show>
		</div>
	);
}
