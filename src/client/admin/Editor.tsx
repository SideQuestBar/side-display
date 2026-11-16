/**
 * The layout editor: element tree on the left, live preview in the middle,
 * properties on the right. The preview is the real renderer, so what you see
 * is what the screen shows, including the ePaper colour modes.
 */
import {
	ArrowLeft,
	Copy,
	Eye,
	GripVertical,
	Plus,
	Redo2,
	RefreshCw,
	Save,
	Settings2,
	Trash2,
	Undo2,
} from "lucide-solid";
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, produce, reconcile, unwrap } from "solid-js/store";
import {
	CATEGORIES,
	CHILD_FIELDS,
	COMMON_FIELDS,
	definition,
	ELEMENT_TYPES,
	ELEMENTS,
	type ElementType,
	type Field,
} from "../../shared/elements";
import { canHold, childLists, cloneElement, findElement, locate, makeElement, walk } from "../../shared/layout";
import {
	type AnyEl,
	COLOR_MODES,
	type ColorMode,
	DEFAULT_GENERAL_SETTINGS,
	type ElementData,
	type Layout,
	type LayoutSettings,
} from "../../shared/types";
import { Canvas } from "../display/Canvas";
import type { DisplayEnv } from "../display/context";
import { api, url } from "../lib/api";
import { displayUrl } from "./Displays";
import { Advanced, Fields } from "./fields";
import { ElementIcon } from "./icons";
import { displays, navigate, refetchDisplays, refetchLayouts, settings } from "./state";
import { attempt, confirmAction, Modal, toast } from "./ui";

interface Draft {
	name: string;
	settings: LayoutSettings;
	elements: AnyEl[];
}
/** Where an element sits: at the top level (`parent` null) or in one of a container's lists. */
interface Slot {
	parent: string | null;
	column: number;
	index: number;
}

const RATIOS = ["16:9", "9:16", "16:10", "4:3", "3:4", "21:9", "1:1", "5:3", "3:5"];
const ratioOptions = [{ value: "auto", label: "Fill any screen" }, ...RATIOS.map((r) => ({ value: r, label: r }))];
const select = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

const LAYOUT_FIELDS: Field[] = [
	{
		key: "aspectRatio",
		label: "Screen shape",
		kind: "select",
		options: ratioOptions,
		help: "A fixed shape keeps the design identical everywhere and letterboxes on other screens.",
	},
	{ key: "background", label: "Background", kind: "color" },
	{ key: "backgroundTo", label: "Gradient to", kind: "color", help: "Leave empty for a plain colour." },
	{ key: "backgroundImage", label: "Background image", kind: "media", media: "image" },
	{ key: "textColor", label: "Text colour", kind: "color" },
	{ key: "accentColor", label: "Accent colour", kind: "color", help: "Highlights: today, prices, icons." },
	{
		key: "fontFamily",
		label: "Font",
		kind: "select",
		options: select(
			["sans", "Sans-serif"],
			["rounded", "Rounded"],
			["condensed", "Condensed"],
			["serif", "Serif"],
			["mono", "Monospace"],
		),
	},
	{
		key: "verticalAlign",
		label: "Vertical alignment",
		kind: "select",
		options: select(["top", "Top"], ["center", "Centre"], ["bottom", "Bottom"], ["spread", "Spread out"]),
	},
	{
		key: "backgroundAngle",
		label: "Gradient angle",
		kind: "range",
		min: 0,
		max: 360,
		unit: "°",
		advanced: true,
		when: (s) => Boolean(s.backgroundTo) && !s.backgroundImage,
	},
	{
		key: "backgroundFit",
		label: "Image fit",
		kind: "select",
		advanced: true,
		options: select(["cover", "Cover"], ["contain", "Contain"], ["fill", "Stretch"], ["repeat", "Tile"]),
		when: (s) => Boolean(s.backgroundImage),
	},
	{
		key: "backgroundPosition",
		label: "Image position",
		kind: "select",
		advanced: true,
		options: select(["center", "Centre"], ["top", "Top"], ["bottom", "Bottom"], ["left", "Left"], ["right", "Right"]),
		when: (s) => Boolean(s.backgroundImage),
	},
	{
		key: "backgroundDim",
		label: "Darken the image",
		kind: "range",
		min: 0,
		max: 90,
		unit: "%",
		advanced: true,
		when: (s) => Boolean(s.backgroundImage),
	},
	{
		key: "panelColor",
		label: "Panel colour",
		kind: "color",
		advanced: true,
		help: "Behind elements with a translucent panel. #rrggbbaa sets the transparency.",
	},
	{ key: "textScale", label: "Text scale", kind: "range", min: 50, max: 200, unit: "%", advanced: true },
	{ key: "padding", label: "Edge padding", kind: "range", min: 0, max: 200, unit: "px", advanced: true },
	{ key: "spacing", label: "Spacing between elements", kind: "range", min: 0, max: 120, unit: "px", advanced: true },
	{ key: "radius", label: "Corner radius", kind: "range", min: 0, max: 60, unit: "px", advanced: true },
];

/** One line describing an element in the tree. */
function summary(el: AnyEl): string {
	if (el.name) return el.name;
	for (const key of ["title", "text", "label", "caption", "entity", "url", "album", "emoji", "template"]) {
		const value = el[key];
		if (typeof value === "string" && value.trim())
			return value
				.replace(/[#*_`]/g, "")
				.trim()
				.split("\n")[0]!
				.slice(0, 40);
	}
	return "";
}

export function EditorPage(props: { id: string }) {
	const [draft, setDraft] = createStore<Draft>({ name: "", settings: {} as LayoutSettings, elements: [] });
	const [loaded, setLoaded] = createSignal(false);
	const [saved, setSaved] = createSignal("");
	const [saving, setSaving] = createSignal(false);
	const [selected, setSelected] = createSignal<string | null>(null);
	const [adding, setAdding] = createSignal(false);
	const [mode, setMode] = createSignal<ColorMode>("full");
	const [shape, setShape] = createSignal(localStorage.getItem("sidedisplay:shape") ?? "16:9");
	const [refreshKey, setRefreshKey] = createSignal(0);
	const [historyVersion, setHistoryVersion] = createSignal(0);

	const serialized = createMemo(() => JSON.stringify(draft));
	const dirty = () => loaded() && serialized() !== saved();
	const selectedEl = createMemo(() => (selected() ? findElement(draft.elements, selected()!) : null));

	// Saving a layout changes every screen that shows it: say which ones.
	void refetchDisplays();
	const usedBy = createMemo(() => (displays() ?? []).filter((d) => d.playlist.some((e) => e.layoutId === props.id)));

	onMount(async () => {
		const layout = await attempt(() => api<Layout>(`api/layouts/${props.id}`));
		if (!layout) return navigate("layouts");
		setDraft({ name: layout.name, settings: layout.settings, elements: layout.elements });
		setSaved(JSON.stringify(unwrap(draft)));
		last = saved();
		setLoaded(true);
	});

	// ---------------------------------------------------------------- history
	// Snapshots of the whole draft: small, simple and impossible to get subtly wrong.
	const past: string[] = [];
	const future: string[] = [];
	let last = "";
	let restoring = false;
	let pending: ReturnType<typeof setTimeout> | undefined;
	const commit = () => {
		clearTimeout(pending);
		pending = undefined;
		const now = serialized();
		if (now === last) return;
		past.push(last);
		if (past.length > 100) past.shift();
		future.length = 0;
		last = now;
		setHistoryVersion((v) => v + 1);
	};
	createEffect(
		on(
			serialized,
			() => {
				if (!loaded()) return;
				if (restoring) {
					restoring = false;
					return;
				}
				// A drag or a burst of typing becomes one undo step.
				clearTimeout(pending);
				pending = setTimeout(commit, 450);
			},
			{ defer: true },
		),
	);
	const restore = (json: string) => {
		restoring = true;
		last = json;
		setDraft(reconcile(JSON.parse(json) as Draft, { key: "id" }));
		setHistoryVersion((v) => v + 1);
		if (selected() && !findElement(draft.elements, selected()!)) setSelected(null);
	};
	const undo = () => {
		if (pending) commit();
		const previous = past.pop();
		if (previous === undefined) return;
		future.push(last);
		restore(previous);
	};
	const redo = () => {
		const next = future.pop();
		if (next === undefined) return;
		past.push(last);
		restore(next);
	};
	const canUndo = () => historyVersion() >= 0 && (past.length > 0 || pending !== undefined);
	const canRedo = () => historyVersion() >= 0 && future.length > 0;

	// -------------------------------------------------------------- mutations
	const updateEl = (id: string, key: string, value: unknown) =>
		setDraft(
			produce((d) => {
				const el = findElement(d.elements, id);
				if (el) el[key] = value;
			}),
		);

	const slotList = (d: Draft, slot: Pick<Slot, "parent" | "column">): AnyEl[] | null => {
		if (!slot.parent) return d.elements;
		const parent = findElement(d.elements, slot.parent);
		return (parent && childLists(parent)[slot.column]) ?? null;
	};

	/** The slot right after an element: where "add" and "duplicate" put things. */
	const slotAfter = (id: string | null): Slot => {
		let found = null as Slot | null;
		const search = (list: AnyEl[], parent: string | null, column: number) => {
			for (const [index, el] of list.entries()) {
				if (el.id === id) found = { parent, column, index: index + 1 };
				for (const [c, children] of childLists(el).entries()) search(children, el.id, c);
			}
		};
		if (id) search(draft.elements, null, 0);
		return found ?? { parent: null, column: 0, index: draft.elements.length };
	};

	const insert = (el: AnyEl, slot: Slot) => {
		// What a container cannot hold (another container, a freely placed element)
		// lands right after it instead.
		let target = slot;
		while (target.parent) {
			const parent = findElement(draft.elements, target.parent);
			if (parent && el.placement !== "free" && canHold(parent.type, el.type)) break;
			target = slotAfter(target.parent);
		}
		setDraft(
			produce((d) => {
				const list = slotList(d, target) ?? d.elements;
				list.splice(Math.min(target.index, list.length), 0, el);
			}),
		);
		setSelected(el.id);
	};

	const addElement = (type: ElementType) => {
		const current = selectedEl();
		// With a container selected, new elements go into it (its first column).
		const inside = current ? childLists(current)[0] : undefined;
		const slot: Slot =
			current && inside && canHold(current.type, type)
				? { parent: current.id, column: 0, index: inside.length }
				: slotAfter(selected());
		insert(makeElement(type), slot);
		setAdding(false);
	};

	const removeEl = (id: string) => {
		setDraft(
			produce((d) => {
				const at = locate(d.elements, id);
				if (at) at.list.splice(at.index, 1);
			}),
		);
		if (selected() === id || (selected() && !findElement(draft.elements, selected()!))) setSelected(null);
	};

	const duplicateEl = (id: string) => {
		const source = findElement(draft.elements, id);
		if (!source) return;
		const copy = cloneElement(unwrap(source));
		if (copy.placement === "free") {
			copy.x += 3;
			copy.y += 3;
		}
		insert(copy, slotAfter(id));
	};

	const moveEl = (id: string, slot: Slot) =>
		setDraft(
			produce((d) => {
				const from = locate(d.elements, id);
				const target = slotList(d, slot);
				if (!from || !target) return;
				const el = from.list[from.index]!;
				const holder = slot.parent ? findElement(d.elements, slot.parent) : null;
				if (slot.parent && (!holder || slot.parent === id || !canHold(holder.type, el.type))) return;
				let index = slot.index;
				const same = unwrap(from.list) === unwrap(target);
				from.list.splice(from.index, 1);
				if (same && from.index < index) index--;
				if (slot.parent) el.placement = "flow";
				target.splice(Math.min(index, target.length), 0, el);
			}),
		);

	const setColumnCount = (id: string, count: number) =>
		setDraft(
			produce((d) => {
				const columns = findElement(d.elements, id)?.columns as AnyEl[][] | undefined;
				if (!columns) return;
				while (columns.length < count) columns.push([]);
				// Removing a column keeps its elements: they move to the one before.
				while (columns.length > count && columns.length > 1) columns.at(-2)!.push(...columns.pop()!);
			}),
		);

	// ------------------------------------------------------------------- save
	const save = async () => {
		if (!draft.name.trim()) return toast("Give the layout a name first.", "error");
		setSaving(true);
		const body = JSON.parse(serialized()) as Draft;
		const result = await attempt(
			() => api<Layout>(`api/layouts/${props.id}`, { method: "PUT", body }),
			"Saved. Screens showing this layout are updating.",
		);
		setSaving(false);
		if (!result) return;
		// The server may have tidied values; the draft we sent is what counts as saved.
		setSaved(JSON.stringify(body));
		void refetchLayouts();
	};

	const leave = async () => {
		if (dirty() && !(await confirmAction("Discard changes?", "This layout has changes that are not saved.", "Discard")))
			return;
		navigate("layouts");
	};

	onMount(() => {
		const onKey = (event: KeyboardEvent) => {
			const typing = ["INPUT", "TEXTAREA", "SELECT"].includes((event.target as HTMLElement)?.tagName);
			const command = event.ctrlKey || event.metaKey;
			if (command && event.key.toLowerCase() === "s") {
				event.preventDefault();
				void save();
			} else if (command && event.key.toLowerCase() === "z" && !typing) {
				event.preventDefault();
				event.shiftKey ? redo() : undo();
			} else if (command && event.key.toLowerCase() === "d" && selected() && !typing) {
				event.preventDefault();
				duplicateEl(selected()!);
			} else if ((event.key === "Delete" || event.key === "Backspace") && selected() && !typing) {
				event.preventDefault();
				removeEl(selected()!);
			} else if (event.key === "Escape" && !typing) {
				setSelected(null);
			} else if (event.key.startsWith("Arrow") && !typing) {
				// Nudge a freely placed element; Shift moves it further.
				const el = selectedEl();
				if (el?.placement !== "free") return;
				event.preventDefault();
				const step = event.shiftKey ? 2 : 0.25;
				if (event.key === "ArrowLeft") updateEl(el.id, "x", el.x - step);
				if (event.key === "ArrowRight") updateEl(el.id, "x", el.x + step);
				if (event.key === "ArrowUp") updateEl(el.id, "y", el.y - step);
				if (event.key === "ArrowDown") updateEl(el.id, "y", el.y + step);
			}
		};
		const onUnload = (event: BeforeUnloadEvent) => dirty() && event.preventDefault();
		window.addEventListener("keydown", onKey);
		window.addEventListener("beforeunload", onUnload);
		onCleanup(() => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("beforeunload", onUnload);
			clearTimeout(pending);
		});
	});

	// ---------------------------------------------------------------- preview
	const env: DisplayEnv = {
		mode,
		invert: () => false,
		general: () => settings()?.general ?? DEFAULT_GENERAL_SETTINGS,
		editing: true,
		edit: (id, key, value) => updateEl(id, key, value),
		refreshKey,
		loadData: (el, signal) => api<ElementData>("api/preview/data", { body: { element: unwrap(el) }, signal }),
		pictureUrl: async (el) => {
			const response = await fetch(url("api/preview/picture"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ element: unwrap(el) }),
			});
			if (!response.ok) throw new Error("no picture");
			return URL.createObjectURL(await response.blob());
		},
		onEntities: () => () => {},
	};

	const ratio = () => {
		const value = draft.settings.aspectRatio === "auto" ? shape() : draft.settings.aspectRatio;
		const [w, h] = value.split(":").map(Number);
		return (w || 16) / (h || 9);
	};

	/** Drags a free element (move) or its corner handle (resize) in stage percent. */
	const dragFree = (el: AnyEl, event: PointerEvent, resize: boolean) => {
		const stage = (event.currentTarget as HTMLElement).closest(".sd-stage")?.getBoundingClientRect();
		if (!stage) return;
		event.preventDefault();
		const start = { px: event.clientX, py: event.clientY, x: el.x, y: el.y, w: el.w, h: el.h };
		const round = (n: number) => Math.round(n * 4) / 4;
		const onMove = (move: PointerEvent) => {
			const dx = ((move.clientX - start.px) / stage.width) * 100;
			const dy = ((move.clientY - start.py) / stage.height) * 100;
			batch(() => {
				if (resize) {
					updateEl(el.id, "w", Math.max(2, round(start.w + dx)));
					updateEl(el.id, "h", Math.max(2, round(start.h + dy)));
				} else {
					updateEl(el.id, "x", round(start.x + dx));
					updateEl(el.id, "y", round(start.y + dy));
				}
			});
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	};

	// -------------------------------------------------------- tree drag & drop
	const [dragging, setDragging] = createSignal<string | null>(null);
	const [drop, setDrop] = createSignal<Slot | null>(null);
	const isDrop = (parent: string | null, column: number, index: number) => {
		const d = drop();
		return dragging() !== null && d !== null && d.parent === parent && d.column === column && d.index === index;
	};
	const finishDrag = () => {
		const id = dragging();
		const slot = drop();
		setDragging(null);
		setDrop(null);
		if (id && slot) moveEl(id, slot);
	};

	const TreeList = (list: { items: AnyEl[]; parent: string | null; column: number }) => (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target of the element tree
		<div
			class="space-y-0.5"
			// Dropping on the empty part of a list appends to it.
			onDragOver={(event) => {
				if (!dragging()) return;
				event.preventDefault();
				event.stopPropagation();
				if (event.target === event.currentTarget)
					setDrop({ parent: list.parent, column: list.column, index: list.items.length });
			}}
			onDrop={(event) => {
				event.preventDefault();
				event.stopPropagation();
				finishDrag();
			}}
		>
			<For each={list.items}>
				{(el, i) => (
					<div
						classList={{
							"border-t-2 border-accent": isDrop(list.parent, list.column, i()),
							"border-b-2 border-b-accent": isDrop(list.parent, list.column, i() + 1) && i() === list.items.length - 1,
						}}
					>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: drag source; the button inside handles keyboard selection */}
						<div
							class="group flex items-center gap-1 rounded-md pr-1 text-sm"
							classList={{
								"bg-accent-bg/25": selected() === el.id,
								"hover:bg-raised": selected() !== el.id,
								"opacity-40": dragging() === el.id,
							}}
							draggable={true}
							onDragStart={(event) => {
								event.stopPropagation();
								event.dataTransfer?.setData("text/plain", el.id);
								setDragging(el.id);
							}}
							onDragEnd={() => {
								setDragging(null);
								setDrop(null);
							}}
							onDragOver={(event) => {
								if (!dragging()) return;
								event.preventDefault();
								event.stopPropagation();
								const box = event.currentTarget.getBoundingClientRect();
								const after = event.clientY > box.top + box.height / 2;
								setDrop({ parent: list.parent, column: list.column, index: i() + (after ? 1 : 0) });
							}}
						>
							<GripVertical class="size-3.5 shrink-0 cursor-grab text-muted opacity-40 group-hover:opacity-100" />
							<button
								type="button"
								class="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
								onClick={() => setSelected(el.id)}
							>
								<ElementIcon type={el.type} class="size-4 shrink-0 text-muted" />
								<span class="shrink-0 font-medium">{definition(el.type).label}</span>
								<span class="truncate text-xs text-muted">{summary(el)}</span>
							</button>
							<Show when={el.placement === "free"}>
								<span class="badge !px-1.5 !py-0">free</span>
							</Show>
						</div>
						<Show when={childLists(el).length > 0}>
							<div class="ml-3 space-y-1 border-l border-line pl-2">
								<For each={childLists(el)}>
									{(column, c) => (
										<div>
											<Show when={el.type === "columns"}>
												<div class="px-1 pt-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
													Column {c() + 1}
												</div>
											</Show>
											<TreeList items={column} parent={el.id} column={c()} />
											<Show when={column.length === 0}>
												{/* biome-ignore lint/a11y/noStaticElementInteractions: drop target of an empty column */}
												<div
													class="rounded-md border border-dashed border-line px-2 py-1.5 text-xs text-muted"
													classList={{ "border-accent text-accent": isDrop(el.id, c(), 0) }}
													onDragOver={(event) => {
														if (!dragging()) return;
														event.preventDefault();
														event.stopPropagation();
														setDrop({ parent: el.id, column: c(), index: 0 });
													}}
													onDrop={(event) => {
														event.preventDefault();
														event.stopPropagation();
														finishDrag();
													}}
												>
													Drop an element here
												</div>
											</Show>
										</div>
									)}
								</For>
							</div>
						</Show>
					</div>
				)}
			</For>
		</div>
	);

	return (
		<Show when={loaded()} fallback={<div class="p-10 text-muted">Loading…</div>}>
			<div class="flex h-full flex-col">
				{/* Toolbar */}
				<div class="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
					<button type="button" class="btn btn-ghost btn-icon" onClick={leave} aria-label="Back to layouts">
						<ArrowLeft />
					</button>
					<input
						class="input max-w-64 font-semibold"
						value={draft.name}
						placeholder="Layout name"
						aria-label="Layout name"
						onInput={(e) => setDraft("name", e.currentTarget.value)}
					/>
					<button
						type="button"
						class="btn btn-ghost btn-icon"
						disabled={!canUndo()}
						onClick={undo}
						title="Undo (Ctrl+Z)"
						aria-label="Undo"
					>
						<Undo2 />
					</button>
					<button
						type="button"
						class="btn btn-ghost btn-icon"
						disabled={!canRedo()}
						onClick={redo}
						title="Redo (Ctrl+Shift+Z)"
						aria-label="Redo"
					>
						<Redo2 />
					</button>
					<Show when={displays()}>
						<div class="flex min-w-0 flex-wrap items-center gap-1.5 pl-1 text-xs text-muted">
							<Show when={usedBy().length} fallback="Not on any display">
								<span>Shown on</span>
								<For each={usedBy()}>
									{(display) => (
										<a
											class="badge max-w-40 hover:border-accent hover:text-ink"
											href={displayUrl(display)}
											target="_blank"
											rel="noreferrer"
											title={`Open ${display.name} (${display.online ? "connected" : "not connected"})`}
										>
											<span
												class="size-2 shrink-0 rounded-full"
												classList={{ "bg-ok": Boolean(display.online), "bg-line": !display.online }}
											/>
											<span class="truncate">{display.name}</span>
										</a>
									)}
								</For>
							</Show>
						</div>
					</Show>
					<div class="flex-1" />
					<Show when={draft.settings.aspectRatio === "auto"}>
						<select
							class="input !w-auto"
							value={shape()}
							title="Shape of the preview screen"
							aria-label="Preview screen shape"
							onChange={(e) => {
								setShape(e.currentTarget.value);
								localStorage.setItem("sidedisplay:shape", e.currentTarget.value);
							}}
						>
							<For each={RATIOS}>{(r) => <option value={r}>Preview {r}</option>}</For>
						</select>
					</Show>
					<select
						class="input !w-auto"
						value={mode()}
						title="Preview as this kind of screen"
						aria-label="Preview colour mode"
						onChange={(e) => setMode(e.currentTarget.value as ColorMode)}
					>
						<For each={COLOR_MODES}>{(m) => <option value={m.value}>{m.label}</option>}</For>
					</select>
					<button
						type="button"
						class="btn btn-ghost btn-icon"
						onClick={() => setRefreshKey((k) => k + 1)}
						title="Reload live data"
						aria-label="Reload live data"
					>
						<RefreshCw />
					</button>
					<a
						class="btn"
						href={url(`p/${props.id}`)}
						target="_blank"
						rel="noreferrer"
						title="Opens the saved version full screen"
					>
						<Eye /> Full screen
					</a>
					<button type="button" class="btn btn-primary" disabled={saving() || !dirty()} onClick={save}>
						<Save /> {dirty() ? "Save" : "Saved"}
					</button>
				</div>

				<div class="flex min-h-0 flex-1">
					{/* Elements */}
					<aside class="flex w-72 shrink-0 flex-col border-r border-line bg-surface">
						<div class="flex gap-2 p-3">
							<button type="button" class="btn btn-primary flex-1" onClick={() => setAdding(true)}>
								<Plus /> Add element
							</button>
							<button
								type="button"
								class="btn btn-icon"
								classList={{ "!border-accent": !selected() }}
								onClick={() => setSelected(null)}
								title="Layout settings"
								aria-label="Layout settings"
							>
								<Settings2 />
							</button>
						</div>
						<div class="min-h-0 flex-1 overflow-y-auto px-2 pb-6">
							<TreeList items={draft.elements} parent={null} column={0} />
							<Show when={draft.elements.length === 0}>
								<p class="px-2 py-6 text-center text-sm text-muted">
									This layout is empty. Add a first element to get going.
								</p>
							</Show>
						</div>
					</aside>

					{/* Preview */}
					<div
						class="flex min-w-0 flex-1 items-center justify-center bg-bg p-6 [container-type:size]"
						onPointerDown={() => setSelected(null)}
					>
						<div
							class="preview-frame rounded-md shadow-xl ring-1 ring-line"
							data-editing
							style={{ width: `min(100cqw, 100cqh * ${ratio()})`, "aspect-ratio": String(ratio()) }}
						>
							<Canvas
								settings={draft.settings}
								elements={draft.elements}
								env={env}
								selectedId={selected()}
								onElementPointerDown={(el, event) => {
									setSelected(el.id);
									// A selected map takes the pointer itself, to be moved around.
									const own = (event.target as Element).closest("[data-own-pointer]");
									if (el.placement === "free" && !own) dragFree(el, event, false);
								}}
								overlay={(stage) => (
									<Show when={selectedEl()?.placement === "free" && selectedEl()} keyed>
										{(el) => (
											<div
												class="free-handle"
												style={{
													left: `${el.x + el.w}%`,
													top: `${el.y + el.h}%`,
													transform: `scale(${1 / (stage.scale() || 1)})`,
												}}
												onPointerDown={(event) => {
													event.stopPropagation();
													dragFree(el, event, true);
												}}
											/>
										)}
									</Show>
								)}
							/>
						</div>
					</div>

					{/* Properties */}
					<aside class="w-80 shrink-0 overflow-y-auto border-l border-line bg-surface p-4">
						<Show
							when={selectedEl()}
							keyed
							fallback={
								<div class="space-y-4">
									<div>
										<h2 class="text-base font-semibold">Layout settings</h2>
										<p class="help">Select an element to edit it; these settings apply to the whole layout.</p>
									</div>
									<Fields
										fields={LAYOUT_FIELDS.filter((f) => !f.advanced)}
										values={draft.settings as unknown as Record<string, unknown>}
										set={(key, value) => setDraft("settings", key as keyof LayoutSettings, value as never)}
									/>
									<Advanced
										storageKey="layout"
										fields={LAYOUT_FIELDS.filter((f) => f.advanced)}
										values={draft.settings as unknown as Record<string, unknown>}
										set={(key, value) => setDraft("settings", key as keyof LayoutSettings, value as never)}
									/>
								</div>
							}
						>
							{(el) => {
								const d = definition(el.type);
								const set = (key: string, value: unknown) => updateEl(el.id, key, value);
								// Free placement only exists at the top level.
								const nested = () => !draft.elements.some((e) => e.id === el.id);
								const common = () => COMMON_FIELDS.filter((f) => !(nested() && f.key === "placement"));
								// What the container it sits in lets it set: its time in a carousel, its span in a grid.
								const childFields = () => {
									let fields: Field[] = [];
									walk(draft.elements, (e, parent) => {
										if (e.id === el.id && parent) fields = CHILD_FIELDS[parent.type] ?? [];
									});
									return fields;
								};
								return (
									<div class="space-y-4">
										<div class="flex items-start gap-2">
											<ElementIcon type={el.type} class="mt-0.5 size-5 shrink-0 text-accent" />
											<div class="min-w-0 flex-1">
												<h2 class="text-base font-semibold">{d.label}</h2>
												<p class="help !mt-0">{d.description}</p>
											</div>
											<button
												type="button"
												class="btn btn-ghost btn-icon"
												onClick={() => duplicateEl(el.id)}
												title="Duplicate (Ctrl+D)"
												aria-label="Duplicate"
											>
												<Copy />
											</button>
											<button
												type="button"
												class="btn btn-ghost btn-icon btn-danger"
												onClick={() => removeEl(el.id)}
												title="Delete (Del)"
												aria-label="Delete"
											>
												<Trash2 />
											</button>
										</div>
										<Show when={el.type === "columns"}>
											<div>
												<div class="label">Number of columns</div>
												<div class="flex gap-1">
													<For each={[1, 2, 3, 4]}>
														{(n) => (
															<button
																type="button"
																class="flex-1 rounded-md border border-line py-1 text-sm font-medium"
																classList={{
																	"bg-accent-bg text-accent-ink border-transparent":
																		(el.columns as AnyEl[][]).length === n,
																	"bg-raised": (el.columns as AnyEl[][]).length !== n,
																}}
																onClick={() => setColumnCount(el.id, n)}
															>
																{n}
															</button>
														)}
													</For>
												</div>
											</div>
										</Show>
										<Show when={el.type === "carousel" || el.type === "switch"}>
											<p class="help !mt-0">
												Add elements while this one is selected, or drag them into it in the list. Selecting one of them
												brings it up in the preview.
											</p>
										</Show>
										<Show when={childFields().length > 0}>
											<Fields fields={childFields()} values={el} set={set} />
										</Show>
										<Fields fields={d.fields.filter((f) => !f.advanced)} values={el} set={set} />
										<div class="border-t border-line pt-3">
											<div class="section-title mb-3">Placement & style</div>
											<Fields fields={common().filter((f) => !f.advanced)} values={el} set={set} />
										</div>
										<Advanced
											storageKey="element"
											fields={[...d.fields, ...common()].filter((f) => f.advanced)}
											values={el}
											set={set}
										/>
									</div>
								);
							}}
						</Show>
					</aside>
				</div>

				<Show when={adding()}>
					<Modal title="Add an element" onClose={() => setAdding(false)} wide>
						<For each={CATEGORIES}>
							{(category) => (
								<div>
									<div class="section-title mb-2">{category.label}</div>
									<div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
										<For each={ELEMENT_TYPES.filter((type) => ELEMENTS[type].category === category.id)}>
											{(type) => (
												<button
													type="button"
													class="flex items-start gap-2.5 rounded-lg border border-line bg-raised/40 p-2.5 text-left hover:border-accent hover:bg-raised"
													onClick={() => addElement(type)}
												>
													<ElementIcon type={type} class="mt-0.5 size-5 shrink-0 text-accent" />
													<span>
														<span class="block text-sm font-semibold">{ELEMENTS[type].label}</span>
														<span class="block text-xs leading-snug text-muted">{ELEMENTS[type].description}</span>
													</span>
												</button>
											)}
										</For>
									</div>
								</div>
							)}
						</For>
					</Modal>
				</Show>
			</div>
		</Show>
	);
}
