import {
	Archive,
	ArchiveRestore,
	Copy,
	Download,
	Eye,
	FileUp,
	Folder,
	FolderInput,
	FolderPlus,
	FolderX,
	Pencil,
	Plus,
	Trash2,
} from "lucide-solid";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { TEMPLATES } from "../../shared/templates";
import type { Layout } from "../../shared/types";
import { api, url } from "../lib/api";
import { displays, folders, layouts, navigate, refetchDisplays, refetchFolders, refetchLayouts } from "./state";
import { ArchiveToggle, attempt, confirmAction, EmptyState, FormField, Modal, PageHeader, Thumbnail } from "./ui";

/** What the page lists: everything in use, one folder ("" = the layouts in none), or the archive. */
type Filter = { folder: string | null } | "archived";

export function LayoutsPage() {
	const [creating, setCreating] = createSignal(false);
	const [importing, setImporting] = createSignal<{ data: unknown; legacy: boolean } | null>(null);
	const [assetBase, setAssetBase] = createSignal("");
	const [filter, setFilter] = createSignal<Filter>({ folder: null });
	const [moving, setMoving] = createSignal<Layout | null>(null);
	/** The folder dialog: a new folder, or the one being renamed. */
	const [naming, setNaming] = createSignal<{ rename?: string } | null>(null);
	void refetchLayouts();
	void refetchFolders();

	const archived = createMemo(() => (layouts() ?? []).filter((l) => l.archivedAt));
	const folder = () => {
		const current = filter();
		return current === "archived" ? null : current.folder;
	};
	/** The layouts to list, under the folder each belongs to; folders first, the unfiled ones last. */
	const groups = createMemo(() => {
		const current = filter();
		const shown =
			current === "archived"
				? archived()
				: (layouts() ?? []).filter((l) => !l.archivedAt && (current.folder === null || l.folder === current.folder));
		const names = [...new Set(shown.map((l) => l.folder))].sort((a, b) =>
			a && b ? a.localeCompare(b) : a ? -1 : b ? 1 : 0,
		);
		return names.map((name) => ({ name, layouts: shown.filter((l) => l.folder === name) }));
	});

	const usedBy = (id: string) => (displays() ?? []).filter((d) => d.playlist.some((e) => e.layoutId === id)).length;

	const create = async (templateId: string) => {
		const template = TEMPLATES.find((t) => t.id === templateId)!;
		const layout = await attempt(() =>
			api<Layout>("api/layouts", {
				body: {
					name: template.id === "blank" ? "Untitled layout" : template.name,
					// A new layout lands in the folder being looked at.
					folder: folder() ?? "",
					...template.build(),
				},
			}),
		);
		if (layout) navigate(`layouts/${layout.id}`);
	};

	const duplicate = async (layout: Layout) => {
		await attempt(() => api(`api/layouts/${layout.id}/duplicate`, { method: "POST" }), "Layout duplicated.");
		void refetchLayouts();
	};

	const remove = async (layout: Layout) => {
		const used = usedBy(layout.id);
		const text = used
			? `"${layout.name}" is shown on ${used} display${used > 1 ? "s" : ""}; it will be removed from them.`
			: `"${layout.name}" will be deleted for good.`;
		if (!(await confirmAction("Delete this layout?", text))) return;
		await attempt(() => api(`api/layouts/${layout.id}`, { method: "DELETE" }), "Layout deleted.");
		void refetchLayouts();
		void refetchDisplays();
	};

	const setArchived = async (layout: Layout, to: boolean) => {
		const used = usedBy(layout.id);
		await attempt(
			() => api(`api/layouts/${layout.id}`, { method: "PUT", body: { archived: to } }),
			to ? `Layout archived.${used ? ` It stays on ${used} display${used > 1 ? "s" : ""}.` : ""}` : "Layout restored.",
		);
		await refetchLayouts();
		// Leave the archive once its last layout is gone.
		if (filter() === "archived" && !groups().length) setFilter({ folder: null });
	};

	/** Files a layout in a folder, which is created if it is new; "" takes it out of its folder. */
	const move = async (layout: Layout, to: string) => {
		await attempt(() => api(`api/layouts/${layout.id}`, { method: "PUT", body: { folder: to } }));
		setMoving(null);
		void refetchLayouts();
		void refetchFolders();
	};

	const saveFolder = async (name: string) => {
		const renamed = naming()?.rename;
		const saved = await attempt(() =>
			renamed === undefined
				? api<{ name: string }>("api/folders", { body: { name } })
				: api<{ name: string }>("api/folders/rename", { body: { from: renamed, to: name } }),
		);
		if (!saved) return;
		setNaming(null);
		await Promise.all([refetchFolders(), refetchLayouts()]);
		setFilter({ folder: saved.name });
	};

	const removeFolder = async (name: string) => {
		const inside = (layouts() ?? []).filter((l) => l.folder === name).length;
		const text = inside
			? `The ${inside === 1 ? "layout" : `${inside} layouts`} in "${name}" will be kept, in no folder.`
			: `"${name}" is empty.`;
		if (!(await confirmAction("Delete this folder?", text))) return;
		await attempt(() => api("api/folders/delete", { body: { name } }), "Folder deleted.");
		setFilter({ folder: null });
		void refetchFolders();
		void refetchLayouts();
	};

	const download = (layout: Layout) => {
		const { name, settings, elements } = layout;
		const blob = new Blob([JSON.stringify({ sidedisplay: 1, name, settings, elements }, null, "\t")], {
			type: "application/json",
		});
		const link = document.createElement("a");
		link.href = URL.createObjectURL(blob);
		link.download = `${name.replace(/[^\w-]+/g, "-").toLowerCase() || "layout"}.json`;
		link.click();
		URL.revokeObjectURL(link.href);
	};

	const readImport = async (file: File | undefined) => {
		if (!file) return;
		const data = await attempt(async () => JSON.parse(await file.text()) as { elements?: { type?: string }[] });
		if (!data) return;
		// Layouts exported from sidequest-bar use its older element names.
		const legacy =
			JSON.stringify(data.elements ?? []).includes('"type":"message"') ||
			JSON.stringify(data).includes('"shortUrl"') ||
			JSON.stringify(data).includes('"type":"events"');
		if (legacy) setImporting({ data, legacy });
		else await runImport(data);
	};
	const runImport = async (data: unknown) => {
		const layout = await attempt(
			() => api<Layout>("api/layouts/import", { body: { data, assetBase: assetBase().trim() } }),
			"Layout imported.",
		);
		setImporting(null);
		if (layout) navigate(`layouts/${layout.id}`);
	};

	return (
		<>
			<PageHeader title="Layouts" subtitle="A layout is one screenful: elements arranged on a background.">
				<label class="btn cursor-pointer">
					<FileUp /> Import
					<input
						type="file"
						class="hidden"
						accept="application/json,.json"
						onChange={(e) => {
							void readImport(e.currentTarget.files?.[0]);
							e.currentTarget.value = "";
						}}
					/>
				</label>
				<button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
					<Plus /> New layout
				</button>
			</PageHeader>

			<Show when={layouts()}>
				<div class="mb-4 flex flex-wrap gap-1.5">
					<button
						type="button"
						class="btn"
						classList={{ "!border-accent": folder() === null && filter() !== "archived" }}
						onClick={() => setFilter({ folder: null })}
					>
						All layouts
					</button>
					<For each={folders()}>
						{(name) => (
							<button
								type="button"
								class="btn"
								classList={{ "!border-accent": folder() === name }}
								onClick={() => setFilter({ folder: name })}
							>
								<Folder /> {name}
							</button>
						)}
					</For>
					<button type="button" class="btn btn-ghost" onClick={() => setNaming({})}>
						<FolderPlus /> New folder
					</button>
					<div class="flex-1" />
					<ArchiveToggle
						count={archived().length}
						active={filter() === "archived"}
						onToggle={() => setFilter(filter() === "archived" ? { folder: null } : "archived")}
					/>
				</div>
			</Show>

			<Show when={folder()}>
				{(name) => (
					<div class="mb-3 flex items-center gap-1">
						<h2 class="section-title mr-1 flex items-center gap-1.5">
							<Folder class="size-3.5" /> {name()}
						</h2>
						<button
							type="button"
							class="btn btn-ghost btn-icon"
							onClick={() => setNaming({ rename: name() })}
							title="Rename the folder"
							aria-label="Rename the folder"
						>
							<Pencil />
						</button>
						<button
							type="button"
							class="btn btn-ghost btn-icon btn-danger"
							onClick={() => removeFolder(name())}
							title="Delete the folder (its layouts are kept)"
							aria-label="Delete the folder"
						>
							<Trash2 />
						</button>
					</div>
				)}
			</Show>

			<Show
				when={groups().length}
				fallback={
					<Show when={layouts()}>
						<Switch
							fallback={
								<EmptyState title="Every layout is archived" text="Restore one from the archive, or start a new one." />
							}
						>
							<Match when={folder()}>
								<EmptyState
									title="This folder is empty"
									text="Move a layout here from its card, or start a new one: it will be filed in this folder."
								>
									<button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
										<Plus /> New layout
									</button>
								</EmptyState>
							</Match>
							<Match when={!layouts()?.length}>
								<EmptyState
									title="No layouts yet"
									text="Start from a template or a blank canvas, then assign the layout to a display."
								>
									<button type="button" class="btn btn-primary" onClick={() => setCreating(true)}>
										<Plus /> New layout
									</button>
								</EmptyState>
							</Match>
						</Switch>
					</Show>
				}
			>
				<Show when={filter() === "archived"}>
					<p class="mb-4 text-sm text-muted">
						Archived layouts are kept as they were. One that is still on a display keeps showing there.
					</p>
				</Show>
				<div class="space-y-6">
					<For each={groups()}>
						{(group) => (
							<section>
								{/* Headings only where they tell folders apart: not inside one, nor when there are none. */}
								<Show when={folder() === null && groups().some((g) => g.name)}>
									<h2 class="section-title mb-2 flex items-center gap-1.5">
										<Show when={group.name} fallback="No folder">
											<Folder class="size-3.5" /> {group.name}
										</Show>
									</h2>
								</Show>
								<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
									<For each={group.layouts}>
										{(layout) => (
											<div class="card overflow-hidden">
												<a
													href={`#/layouts/${layout.id}`}
													class="block h-48 bg-black/80 p-2"
													aria-label={`Edit ${layout.name}`}
												>
													<Thumbnail settings={layout.settings} elements={layout.elements} class="h-full w-full" />
												</a>
												<div class="px-3 pt-3">
													<div class="truncate font-semibold">{layout.name}</div>
													<div class="text-xs text-muted">
														{layout.elements.length} element{layout.elements.length === 1 ? "" : "s"} ·{" "}
														{usedBy(layout.id)
															? `on ${usedBy(layout.id)} display${usedBy(layout.id) > 1 ? "s" : ""}`
															: "not on a display"}
													</div>
												</div>
												<div class="flex items-center gap-1 p-2">
													<a
														class="btn btn-ghost btn-icon"
														href={`#/layouts/${layout.id}`}
														title="Edit"
														aria-label="Edit"
													>
														<Pencil />
													</a>
													<a
														class="btn btn-ghost btn-icon"
														href={url(`p/${layout.id}`)}
														target="_blank"
														rel="noreferrer"
														title="Preview full screen"
														aria-label="Preview"
													>
														<Eye />
													</a>
													<Show when={!layout.archivedAt}>
														<button
															type="button"
															class="btn btn-ghost btn-icon"
															onClick={() => duplicate(layout)}
															title="Duplicate"
															aria-label="Duplicate"
														>
															<Copy />
														</button>
														<button
															type="button"
															class="btn btn-ghost btn-icon"
															onClick={() => setMoving(layout)}
															title="Move to a folder"
															aria-label="Move to a folder"
														>
															<FolderInput />
														</button>
													</Show>
													<button
														type="button"
														class="btn btn-ghost btn-icon"
														onClick={() => download(layout)}
														title="Export as a file"
														aria-label="Export"
													>
														<Download />
													</button>
													<div class="flex-1" />
													<Show
														when={layout.archivedAt}
														fallback={
															<button
																type="button"
																class="btn btn-ghost btn-icon"
																onClick={() => setArchived(layout, true)}
																title="Archive"
																aria-label="Archive"
															>
																<Archive />
															</button>
														}
													>
														<button type="button" class="btn" onClick={() => setArchived(layout, false)}>
															<ArchiveRestore /> Restore
														</button>
													</Show>
													<button
														type="button"
														class="btn btn-ghost btn-icon btn-danger"
														onClick={() => remove(layout)}
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
							</section>
						)}
					</For>
				</div>
			</Show>

			<Show when={moving()} keyed>
				{(layout) => {
					const [name, setName] = createSignal("");
					const option = (to: string, label: string) => (
						<button
							type="button"
							class="flex w-full items-center gap-2 rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-accent"
							classList={{ "!border-accent bg-accent-bg/25 font-medium": layout.folder === to }}
							aria-pressed={layout.folder === to}
							onClick={() => move(layout, to)}
						>
							<Show when={to} fallback={<FolderX class="size-4 shrink-0 text-muted" />}>
								<Folder class="size-4 shrink-0 text-muted" />
							</Show>
							<span class="truncate">{label}</span>
						</button>
					);
					return (
						<Modal title={`Move "${layout.name}"`} onClose={() => setMoving(null)}>
							<div class="space-y-1.5">
								{option("", "No folder")}
								<For each={folders()}>{(f) => option(f, f)}</For>
							</div>
							<form
								class="border-t border-line pt-4"
								onSubmit={(e) => {
									e.preventDefault();
									if (name().trim()) void move(layout, name());
								}}
							>
								<FormField label="Or a new folder">
									<div class="flex gap-2">
										<input
											class="input"
											value={name()}
											placeholder="Folder name"
											maxLength={60}
											onInput={(e) => setName(e.currentTarget.value)}
										/>
										<button type="submit" class="btn btn-primary shrink-0" disabled={!name().trim()}>
											<FolderPlus /> Create and move
										</button>
									</div>
								</FormField>
							</form>
						</Modal>
					);
				}}
			</Show>

			<Show when={naming()} keyed>
				{(target) => {
					const [name, setName] = createSignal(target.rename ?? "");
					return (
						<Modal title={target.rename === undefined ? "New folder" : "Rename folder"} onClose={() => setNaming(null)}>
							<form
								class="space-y-4"
								onSubmit={(e) => {
									e.preventDefault();
									if (name().trim()) void saveFolder(name());
								}}
							>
								<FormField label="Name">
									<input
										class="input"
										autofocus
										value={name()}
										placeholder="Bar, Home, Seasonal…"
										maxLength={60}
										onInput={(e) => setName(e.currentTarget.value)}
									/>
								</FormField>
								<div class="flex justify-end gap-2">
									<button type="button" class="btn" onClick={() => setNaming(null)}>
										Cancel
									</button>
									<button type="submit" class="btn btn-primary" disabled={!name().trim()}>
										{target.rename === undefined ? "Create" : "Rename"}
									</button>
								</div>
							</form>
						</Modal>
					);
				}}
			</Show>

			<Show when={creating()}>
				<Modal title="New layout" onClose={() => setCreating(false)} wide>
					<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						<For each={TEMPLATES}>
							{(template) => {
								const built = template.build();
								return (
									<button
										type="button"
										class="card overflow-hidden text-left hover:border-accent"
										onClick={() => create(template.id)}
									>
										<div class="h-32 bg-black/80 p-2">
											<Thumbnail settings={built.settings} elements={built.elements} class="h-full w-full" />
										</div>
										<div class="p-3">
											<div class="font-semibold">{template.name}</div>
											<div class="text-xs leading-snug text-muted">{template.description}</div>
										</div>
									</button>
								);
							}}
						</For>
					</div>
				</Modal>
			</Show>

			<Show when={importing()}>
				{(pending) => (
					<Modal
						title="Import from sidequest-bar"
						onClose={() => setImporting(null)}
						footer={
							<>
								<button type="button" class="btn" onClick={() => setImporting(null)}>
									Cancel
								</button>
								<button type="button" class="btn btn-primary" onClick={() => runImport(pending().data)}>
									Import
								</button>
							</>
						}
					>
						<p class="text-sm text-muted">
							This file comes from the display manager built into the website. Its elements will be converted; the
							events list becomes a calendar for you to point at a feed.
						</p>
						<FormField
							label="Website address"
							help="Images in that layout are stored on the website. Its address lets SideDisplay keep showing them."
						>
							<input
								class="input"
								type="url"
								placeholder="https://example.com"
								value={assetBase()}
								onInput={(e) => setAssetBase(e.currentTarget.value)}
							/>
						</FormField>
					</Modal>
				)}
			</Show>
		</>
	);
}
