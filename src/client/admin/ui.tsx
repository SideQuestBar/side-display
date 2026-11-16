/**
 * Small building blocks of the admin UI: modal, toasts, confirmation,
 * fields, and the static layout thumbnail.
 */
import { Archive, ChevronDown, ChevronRight, X } from "lucide-solid";
import { createSignal, For, type JSX, onCleanup, onMount, type ParentProps, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
	type AnyEl,
	type ColorMode,
	DEFAULT_GENERAL_SETTINGS,
	type GeneralSettings,
	type LayoutSettings,
} from "../../shared/types";
import { Canvas } from "../display/Canvas";
import type { DisplayEnv } from "../display/context";

export function Modal(
	props: ParentProps<{ title: string; onClose: () => void; wide?: boolean; footer?: JSX.Element }>,
) {
	onMount(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
		window.addEventListener("keydown", onKey);
		onCleanup(() => window.removeEventListener("keydown", onKey));
	});
	return (
		<Portal>
			<div
				class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:p-8"
				onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}
			>
				<div
					class="card flex w-full flex-col shadow-2xl"
					classList={{ "max-w-4xl": props.wide, "max-w-xl": !props.wide }}
					role="dialog"
					aria-modal="true"
					aria-label={props.title}
				>
					<div class="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
						<h2 class="text-base font-semibold">{props.title}</h2>
						<button type="button" class="btn btn-ghost btn-icon" onClick={() => props.onClose()} aria-label="Close">
							<X />
						</button>
					</div>
					<div class="space-y-4 p-5">{props.children}</div>
					<Show when={props.footer}>
						<div class="flex justify-end gap-2 border-t border-line px-5 py-3">{props.footer}</div>
					</Show>
				</div>
			</div>
		</Portal>
	);
}

// --------------------------------------------------------------------- toasts

interface Toast {
	id: number;
	text: string;
	kind: "ok" | "error";
}
const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextToast = 1;

export function toast(text: string, kind: Toast["kind"] = "ok") {
	const id = nextToast++;
	setToasts((list) => [...list, { id, text, kind }]);
	setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === "error" ? 6000 : 2500);
}
/** Runs an action and reports its failure as a toast instead of an unhandled rejection. */
export async function attempt<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
	try {
		const result = await action();
		if (success) toast(success);
		return result;
	} catch (err) {
		toast((err as Error).message || "Something went wrong", "error");
		return undefined;
	}
}

export function Toasts() {
	return (
		<Portal>
			<div class="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
				<For each={toasts()}>
					{(t) => (
						<div
							class="rounded-lg px-4 py-2 text-sm font-medium whitespace-pre-line text-white shadow-lg"
							classList={{ "bg-[#1f7a48]": t.kind === "ok", "bg-[#b03030]": t.kind === "error" }}
							role="status"
						>
							{t.text}
						</div>
					)}
				</For>
			</div>
		</Portal>
	);
}

// ------------------------------------------------------------- confirmation

const [confirmation, setConfirmation] = createSignal<{
	title: string;
	text: string;
	action: string;
	resolve: (ok: boolean) => void;
} | null>(null);

/** Asks before something that cannot be undone. Resolves to true when confirmed. */
export function confirmAction(title: string, text: string, action = "Delete"): Promise<boolean> {
	return new Promise((resolve) => setConfirmation({ title, text, action, resolve }));
}

export function ConfirmHost() {
	const close = (ok: boolean) => {
		confirmation()?.resolve(ok);
		setConfirmation(null);
	};
	return (
		<Show when={confirmation()}>
			{(c) => (
				<Modal
					title={c().title}
					onClose={() => close(false)}
					footer={
						<>
							<button type="button" class="btn" onClick={() => close(false)}>
								Cancel
							</button>
							<button type="button" class="btn btn-danger" onClick={() => close(true)}>
								{c().action}
							</button>
						</>
					}
				>
					<p class="text-sm text-muted">{c().text}</p>
				</Modal>
			)}
		</Show>
	);
}

// --------------------------------------------------------------------- misc

export function FormField(props: ParentProps<{ label: string; help?: string; aside?: JSX.Element }>) {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child
		<label class="block">
			<span class="label">
				{props.label}
				{props.aside}
			</span>
			{props.children}
			<Show when={props.help}>
				<span class="help block">{props.help}</span>
			</Show>
		</label>
	);
}

/**
 * A folded group of less common options. With `storageKey` it remembers
 * whether it was left open.
 */
export function Fold(props: ParentProps<{ label: string; note?: string; storageKey?: string }>) {
	const key = props.storageKey && `sidedisplay:advanced:${props.storageKey}`;
	const [open, setOpen] = createSignal(key ? localStorage.getItem(key) === "1" : false);
	let box: HTMLDivElement | undefined;
	const toggle = () => {
		setOpen(!open());
		if (key) localStorage.setItem(key, open() ? "1" : "0");
		// The button is usually the last thing in a scrolling panel, so what it
		// reveals lands below the edge: without this, nothing seems to happen.
		if (open()) requestAnimationFrame(() => box?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
	};
	return (
		<div class="border-t border-line pt-3" ref={box}>
			<button
				type="button"
				class="flex w-full items-center gap-1 text-xs font-bold tracking-wider text-muted uppercase hover:text-ink"
				onClick={toggle}
				aria-expanded={open()}
			>
				<Show when={open()} fallback={<ChevronRight class="size-4" />}>
					<ChevronDown class="size-4" />
				</Show>
				{props.label}
				<Show when={props.note}>
					<span class="font-medium normal-case tracking-normal">· {props.note}</span>
				</Show>
			</button>
			<Show when={open()}>
				<div class="mt-3">{props.children}</div>
			</Show>
		</div>
	);
}

export function PageHeader(props: ParentProps<{ title: string; subtitle?: string }>) {
	return (
		<div class="mb-6 flex flex-wrap items-end justify-between gap-3">
			<div>
				<h1 class="text-2xl font-bold tracking-tight">{props.title}</h1>
				<Show when={props.subtitle}>
					<p class="mt-1 text-sm text-muted">{props.subtitle}</p>
				</Show>
			</div>
			<div class="flex flex-wrap gap-2">{props.children}</div>
		</div>
	);
}

/** Switches a page between what is in use and what was archived; absent while the archive is empty. */
export function ArchiveToggle(props: { count: number; active: boolean; onToggle: () => void }) {
	return (
		<Show when={props.count || props.active}>
			<button
				type="button"
				class="btn"
				classList={{ "!border-accent": props.active }}
				aria-pressed={props.active}
				onClick={props.onToggle}
			>
				<Archive /> Archived
				<span class="text-xs text-muted">{props.count}</span>
			</button>
		</Show>
	);
}

export function EmptyState(props: ParentProps<{ title: string; text: string }>) {
	return (
		<div class="card flex flex-col items-center gap-3 px-6 py-14 text-center">
			<div class="text-base font-semibold">{props.title}</div>
			<p class="max-w-md text-sm text-muted">{props.text}</p>
			{props.children}
		</div>
	);
}

/** An environment that loads nothing: for thumbnails, which must stay cheap. */
export function staticEnv(
	mode: () => ColorMode = () => "full",
	general: () => GeneralSettings = () => DEFAULT_GENERAL_SETTINGS,
): DisplayEnv {
	return {
		mode,
		invert: () => false,
		general,
		editing: false,
		refreshKey: () => 0,
		loadData: async () => ({ show: true, data: null }),
		pictureUrl: async () => "",
		onEntities: () => () => {},
	};
}

/**
 * A small, non-interactive rendering of a layout, as large as fits in the box
 * it is given (size that box with `class`).
 */
export function Thumbnail(props: { settings: LayoutSettings; elements: AnyEl[]; mode?: ColorMode; class?: string }) {
	const ratio = () => {
		const [w, h] = props.settings.aspectRatio.split(":").map(Number);
		return w && h ? w / h : 16 / 9;
	};
	return (
		<div class={`flex items-center justify-center [container-type:size] ${props.class ?? ""}`}>
			<div class="preview-frame" style={{ width: `min(100cqw, 100cqh * ${ratio()})`, "aspect-ratio": String(ratio()) }}>
				<Canvas settings={props.settings} elements={props.elements} env={staticEnv(() => props.mode ?? "full")} />
			</div>
		</div>
	);
}

export const formatBytes = (bytes: number) =>
	bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function timeAgo(timestamp: number | null | undefined): string {
	if (!timestamp) return "never";
	const minutes = Math.round((Date.now() - timestamp) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
	return `${Math.round(minutes / 60 / 24)} d ago`;
}
