/**
 * Renders a form from field descriptions (`Field` in `shared/elements.ts`).
 * The element inspector, the layout settings and the list rows inside them
 * are all built from this, so every element gets the same controls and the
 * same split between everyday and advanced options.
 */
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Trash2, Upload, X } from "lucide-solid";
import { createMemo, createSignal, createUniqueId, For, Index, Match, Show, Switch } from "solid-js";
import type { Field } from "../../shared/elements";
import type { MediaItem } from "../../shared/types";
import { api, mediaUrl } from "../lib/api";
import { albums, entities, media, refetchMedia } from "./state";
import { attempt, Fold, Modal } from "./ui";

type Values = Record<string, unknown>;
type SetValue = (key: string, value: unknown) => void;

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Shown Monday first, as most calendars do. */
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function Fields(props: { fields: Field[]; values: Values; set: SetValue }) {
	return (
		<div class="space-y-3">
			<For each={props.fields}>
				{(field) => (
					<Show when={!field.when || field.when(props.values)}>
						<FieldInput field={field} value={props.values[field.key]} set={(value) => props.set(field.key, value)} />
					</Show>
				)}
			</For>
		</div>
	);
}

/** The advanced options of a form, folded away; remembers whether it was left open. */
export function Advanced(props: { fields: Field[]; values: Values; set: SetValue; storageKey?: string }) {
	const visible = createMemo(() => props.fields.filter((f) => !f.when || f.when(props.values)));
	return (
		<Show when={visible().length}>
			<Fold label="Advanced" note={`${visible().length} more`} storageKey={props.storageKey ?? "default"}>
				<Fields fields={props.fields} values={props.values} set={props.set} />
			</Fold>
		</Show>
	);
}

function FieldInput(props: { field: Field; value: unknown; set: (value: unknown) => void }) {
	const f = () => props.field;
	const id = createUniqueId();
	const text = () => (props.value == null ? "" : String(props.value));
	const number = () => (typeof props.value === "number" ? props.value : Number(props.value) || 0);
	const setNumber = (raw: string) => {
		const value = Number(raw);
		if (raw.trim() !== "" && Number.isFinite(value)) props.set(value);
	};

	return (
		<div>
			<Show when={f().kind !== "toggle"}>
				<label class="label" for={id}>
					<span>{f().label}</span>
					<Show when={f().kind === "range"}>
						<span class="font-medium tabular-nums">
							{number()}
							{f().unit ? ` ${f().unit}` : ""}
						</span>
					</Show>
				</label>
			</Show>
			<Switch>
				<Match when={f().kind === "text"}>
					<input
						id={id}
						class="input"
						type="text"
						value={text()}
						placeholder={f().placeholder}
						onInput={(e) => props.set(e.currentTarget.value)}
					/>
				</Match>
				<Match when={f().kind === "textarea"}>
					<textarea
						id={id}
						class="input"
						value={text()}
						placeholder={f().placeholder}
						onInput={(e) => props.set(e.currentTarget.value)}
					/>
				</Match>
				<Match when={f().kind === "number"}>
					<div class="flex items-center gap-2">
						<input
							id={id}
							class="input"
							type="number"
							value={number()}
							min={f().min}
							max={f().max}
							step={f().step ?? 1}
							onInput={(e) => setNumber(e.currentTarget.value)}
						/>
						<Show when={f().unit}>
							<span class="shrink-0 text-xs text-muted">{f().unit}</span>
						</Show>
					</div>
				</Match>
				<Match when={f().kind === "range"}>
					<input
						id={id}
						class="w-full"
						type="range"
						value={number()}
						min={f().min ?? 0}
						max={f().max ?? 100}
						step={f().step ?? 1}
						onInput={(e) => setNumber(e.currentTarget.value)}
					/>
				</Match>
				<Match when={f().kind === "select"}>
					<select id={id} class="input" value={text()} onChange={(e) => props.set(e.currentTarget.value)}>
						<For each={f().options}>{(option) => <option value={option.value}>{option.label}</option>}</For>
					</select>
				</Match>
				<Match when={f().kind === "toggle"}>
					<label class="flex cursor-pointer items-center justify-between gap-3 text-sm">
						<span>{f().label}</span>
						<input
							type="checkbox"
							class="size-4 accent-[var(--accent)]"
							checked={Boolean(props.value)}
							onChange={(e) => props.set(e.currentTarget.checked)}
						/>
					</label>
				</Match>
				<Match when={f().kind === "color"}>
					<ColorInput id={id} value={text()} set={props.set} />
				</Match>
				<Match when={f().kind === "media"}>
					<MediaInput id={id} value={text()} kind={f().media ?? "image"} set={props.set} />
				</Match>
				<Match when={f().kind === "album"}>
					<select id={id} class="input" value={text()} onChange={(e) => props.set(e.currentTarget.value)}>
						<option value="">Every image</option>
						<For each={albums()}>{(album) => <option value={album}>{album}</option>}</For>
						{/* Keep an album that no longer has photos selectable. */}
						<Show when={text() && !albums().includes(text())}>
							<option value={text()}>{text()} (empty)</option>
						</Show>
					</select>
				</Match>
				<Match when={f().kind === "entity"}>
					<EntityInput id={id} value={text()} domains={f().domains} set={props.set} />
				</Match>
				<Match when={f().kind === "datetime"}>
					<input
						id={id}
						class="input"
						type="datetime-local"
						value={text()}
						onInput={(e) => props.set(e.currentTarget.value)}
					/>
				</Match>
				<Match when={f().kind === "time"}>
					<div class="flex gap-2">
						<input id={id} class="input" type="time" value={text()} onInput={(e) => props.set(e.currentTarget.value)} />
						<Show when={text()}>
							<button type="button" class="btn btn-icon" onClick={() => props.set("")} aria-label="Clear">
								<X />
							</button>
						</Show>
					</div>
				</Match>
				<Match when={f().kind === "days"}>
					<DaysInput value={Array.isArray(props.value) ? (props.value as number[]) : []} set={props.set} />
				</Match>
				<Match when={f().kind === "list"}>
					<ListInput field={f()} rows={Array.isArray(props.value) ? (props.value as Values[]) : []} set={props.set} />
				</Match>
			</Switch>
			<Show when={f().help}>
				<p class="help">{f().help}</p>
			</Show>
		</div>
	);
}

function ColorInput(props: { id: string; value: string; set: (value: string) => void }) {
	// The native picker only understands #rrggbb; the text box also takes
	// #rrggbbaa (translucent) and empty ("use the default").
	const swatch = () => (/^#[0-9a-f]{6}/i.test(props.value) ? props.value.slice(0, 7) : "#888888");
	return (
		<div class="flex items-center gap-2">
			<input
				type="color"
				class="size-8 shrink-0 cursor-pointer rounded-md"
				value={swatch()}
				onInput={(e) => props.set(e.currentTarget.value)}
				aria-label="Pick a colour"
			/>
			<input
				id={props.id}
				class="input font-mono"
				type="text"
				value={props.value}
				placeholder="Default"
				spellcheck={false}
				onChange={(e) => props.set(e.currentTarget.value.trim())}
			/>
			<Show when={props.value}>
				<button type="button" class="btn btn-icon" onClick={() => props.set("")} aria-label="Use the default colour">
					<X />
				</button>
			</Show>
		</div>
	);
}

export function DaysInput(props: { value: number[]; set: (value: number[]) => void }) {
	const toggle = (day: number) =>
		props.set(props.value.includes(day) ? props.value.filter((d) => d !== day) : [...props.value, day].sort());
	return (
		<div class="flex gap-1">
			<For each={DAY_ORDER}>
				{(day) => (
					<button
						type="button"
						class="flex-1 rounded-md border border-line py-1 text-xs font-medium"
						classList={{
							"bg-accent-bg text-accent-ink border-transparent": props.value.includes(day),
							"bg-raised text-muted": !props.value.includes(day),
						}}
						aria-pressed={props.value.includes(day)}
						onClick={() => toggle(day)}
					>
						{DAY_NAMES[day]}
					</button>
				)}
			</For>
		</div>
	);
}

function EntityInput(props: { id: string; value: string; domains?: string[]; set: (value: string) => void }) {
	const listId = createUniqueId();
	const options = createMemo(() => {
		const all = entities()?.entities ?? [];
		return props.domains ? all.filter((e) => props.domains!.includes(e.entity_id.split(".")[0] ?? "")) : all;
	});
	const current = () => options().find((e) => e.entity_id === props.value);
	return (
		<>
			<input
				id={props.id}
				class="input font-mono"
				type="text"
				list={listId}
				value={props.value}
				placeholder={props.domains ? `${props.domains[0]}.…` : "sensor.…"}
				spellcheck={false}
				onInput={(e) => props.set(e.currentTarget.value.trim())}
			/>
			<datalist id={listId}>
				<For each={options().slice(0, 2000)}>{(e) => <option value={e.entity_id}>{e.name}</option>}</For>
			</datalist>
			<Show
				when={current()}
				fallback={
					<Show when={entities() && !entities()?.configured}>
						<p class="help">Connect Home Assistant in Settings to pick from your entities.</p>
					</Show>
				}
			>
				{(e) => (
					<p class="help">
						{e().name}: {e().state} {e().unit}
					</p>
				)}
			</Show>
		</>
	);
}

function MediaInput(props: {
	id: string;
	value: string;
	kind: NonNullable<Field["media"]>;
	set: (value: string) => void;
}) {
	const [picking, setPicking] = createSignal(false);
	const item = () => (media() ?? []).find((m) => `media/${m.file}` === props.value);
	return (
		<div class="space-y-2">
			<Show when={props.value}>
				<div class="flex items-center gap-2 rounded-lg border border-line bg-raised p-1.5">
					<Show
						when={props.kind !== "video" && props.kind !== "document" && !/youtu/.test(props.value)}
						fallback={
							<div class="flex size-12 items-center justify-center rounded bg-black/20 text-xs text-muted">
								{props.kind === "document" ? "PDF" : "video"}
							</div>
						}
					>
						<img src={mediaUrl(props.value, 160)} alt="" class="size-12 rounded object-cover" />
					</Show>
					<span class="min-w-0 flex-1 truncate text-xs">{item()?.name ?? props.value}</span>
					<button type="button" class="btn btn-ghost btn-icon" onClick={() => props.set("")} aria-label="Remove">
						<X />
					</button>
				</div>
			</Show>
			<div class="flex gap-2">
				<button type="button" class="btn shrink-0" onClick={() => setPicking(true)}>
					Library…
				</button>
				<input
					id={props.id}
					class="input"
					type="text"
					value={props.value.startsWith("media/") ? "" : props.value}
					placeholder="…or paste an address"
					onChange={(e) => props.set(e.currentTarget.value.trim())}
				/>
			</div>
			<Show when={picking()}>
				<MediaPicker
					kind={props.kind}
					onClose={() => setPicking(false)}
					onPick={(m) => {
						props.set(`media/${m.file}`);
						setPicking(false);
					}}
				/>
			</Show>
		</div>
	);
}

/** Uploads files to the library; shared by the picker and the media page. */
export async function uploadFiles(files: FileList | File[], album = ""): Promise<MediaItem[]> {
	const form = new FormData();
	for (const file of files) form.append("files", file);
	form.append("album", album);
	const result = await attempt(() => api<{ saved: MediaItem[]; errors: string[] }>("api/media", { form }));
	if (!result) return [];
	if (result.errors.length) await attempt(() => Promise.reject(new Error(result.errors.join("\n"))));
	await refetchMedia();
	return result.saved;
}

/** What the picker says and lets through, per kind of file a field asks for. */
const PICKER: Record<NonNullable<Field["media"]>, { title: string; accept: string }> = {
	image: { title: "Choose an image", accept: "image/*" },
	video: { title: "Choose a video", accept: "video/*" },
	document: { title: "Choose a PDF", accept: "application/pdf" },
	any: { title: "Choose a file", accept: "image/*,video/*,application/pdf" },
};

export function MediaPicker(props: {
	kind: NonNullable<Field["media"]>;
	onPick: (item: MediaItem) => void;
	onClose: () => void;
}) {
	const [uploading, setUploading] = createSignal(false);
	const items = () => (media() ?? []).filter((m) => props.kind === "any" || m.kind === props.kind);
	const upload = async (files: FileList | null) => {
		if (!files?.length) return;
		setUploading(true);
		const saved = await uploadFiles(files);
		setUploading(false);
		const match = saved.find((m) => props.kind === "any" || m.kind === props.kind);
		if (saved.length === 1 && match) props.onPick(match);
	};
	return (
		<Modal title={PICKER[props.kind].title} onClose={props.onClose} wide>
			<label class="btn btn-primary cursor-pointer">
				<Upload />
				{uploading() ? "Uploading…" : "Upload"}
				<input
					type="file"
					class="hidden"
					multiple
					accept={PICKER[props.kind].accept}
					onChange={(e) => upload(e.currentTarget.files)}
				/>
			</label>
			<div class="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
				<For
					each={items()}
					fallback={
						<p class="col-span-full py-8 text-center text-sm text-muted">
							Nothing here yet. Upload a file to get started.
						</p>
					}
				>
					{(m) => (
						<button
							type="button"
							class="group overflow-hidden rounded-lg border border-line text-left hover:border-accent"
							onClick={() => props.onPick(m)}
						>
							<MediaThumb item={m} />
							<div class="truncate px-2 py-1 text-xs">{m.name}</div>
						</button>
					)}
				</For>
			</div>
		</Modal>
	);
}

/** A square thumbnail. `width` is the widest it is shown at, in CSS px. */
export function MediaThumb(props: { item: MediaItem; width?: number }) {
	return (
		<Show
			when={props.item.kind !== "document"}
			fallback={
				<div class="flex aspect-square w-full items-center justify-center bg-black/10 text-sm font-semibold text-muted">
					PDF
				</div>
			}
		>
			<MediaPreview item={props.item} width={props.width} />
		</Show>
	);
}

function MediaPreview(props: { item: MediaItem; width?: number }) {
	return (
		<Show
			when={props.item.kind === "image"}
			fallback={
				// The first frame is enough for a thumbnail: load metadata only.
				<video
					src={`${mediaUrl(`media/${props.item.file}`)}#t=0.5`}
					preload="metadata"
					muted
					class="aspect-square w-full bg-black object-cover"
				/>
			}
		>
			<img
				// Twice the shown width, for dense screens; the server rounds up to a size it keeps.
				src={mediaUrl(`media/${props.item.file}`, Math.max(320, (props.width ?? 160) * 2))}
				alt=""
				loading="lazy"
				draggable={false}
				class="aspect-square w-full bg-black/10 object-cover"
			/>
		</Show>
	);
}

function ListInput(props: { field: Field; rows: Values[]; set: (value: Values[]) => void }) {
	const [open, setOpen] = createSignal<number | null>(null);
	const label = (row: Values, index: number) => String(row[props.field.itemLabel ?? ""] ?? "") || `Item ${index + 1}`;
	const replace = (index: number, key: string, value: unknown) =>
		props.set(props.rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
	const move = (index: number, by: number) => {
		const target = index + by;
		if (target < 0 || target >= props.rows.length) return;
		const next = [...props.rows];
		[next[index], next[target]] = [next[target]!, next[index]!];
		props.set(next);
		setOpen(target);
	};
	const add = () => {
		props.set([...props.rows, structuredClone(props.field.item ?? {})]);
		setOpen(props.rows.length);
	};
	return (
		<div class="space-y-1.5">
			<Index each={props.rows}>
				{(row, index) => {
					// Rows are tracked by position, so typing in one does not rebuild it.
					const i = () => index;
					return (
						<div class="rounded-lg border border-line bg-raised/50">
							<div class="flex items-center gap-1 px-2 py-1">
								<button
									type="button"
									class="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left text-sm"
									onClick={() => setOpen(open() === i() ? null : i())}
									aria-expanded={open() === i()}
								>
									<Show when={open() === i()} fallback={<ChevronRight class="size-4 shrink-0 text-muted" />}>
										<ChevronDown class="size-4 shrink-0 text-muted" />
									</Show>
									<span class="truncate">{label(row(), i())}</span>
								</button>
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
									disabled={i() === props.rows.length - 1}
									onClick={() => move(i(), 1)}
									aria-label="Move down"
								>
									<ArrowDown />
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-icon btn-danger !p-1"
									onClick={() => {
										props.set(props.rows.filter((_, index) => index !== i()));
										setOpen(null);
									}}
									aria-label="Remove"
								>
									<Trash2 />
								</button>
							</div>
							<Show when={open() === i()}>
								<div class="border-t border-line p-2.5">
									<Fields
										fields={props.field.fields ?? []}
										values={row()}
										set={(key, value) => replace(i(), key, value)}
									/>
								</div>
							</Show>
						</div>
					);
				}}
			</Index>
			<button type="button" class="btn w-full" onClick={add}>
				<Plus /> Add
			</button>
		</div>
	);
}
