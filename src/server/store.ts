/**
 * Reads and writes layouts and displays, and keeps the bookkeeping the live
 * streams need: which displays show which layout, and which Home Assistant
 * entities each display depends on.
 */
import { eq, or, sql } from "drizzle-orm";
import { definition, isElementType } from "../shared/elements";
import {
	entitiesOf,
	newId,
	normalizeDisplaySettings,
	normalizeElements,
	normalizeLayoutSettings,
	normalizePlaylist,
	normalizeSlug,
	walk,
} from "../shared/layout";
import type { AnyEl, Display, Layout, ViewPayload } from "../shared/types";
import { config } from "./config";
import { db, schema } from "./db";
import { connectedDisplayIds, notify, onlineCount } from "./events";
import { getSetting, setSetting } from "./settings";

type LayoutRow = typeof schema.layouts.$inferSelect;
type DisplayRow = typeof schema.displays.$inferSelect;

// Stored JSON is normalised on the way out too, so layouts saved by an older
// version gain the defaults of properties added since.
const toLayout = (row: LayoutRow): Layout => ({
	id: row.id,
	name: row.name,
	settings: normalizeLayoutSettings(row.settings),
	elements: normalizeElements(row.elements),
	folder: row.folder,
	archivedAt: row.archivedAt,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
});

const toDisplay = (row: DisplayRow): Display => ({
	id: row.id,
	name: row.name,
	slug: row.slug ?? "",
	playlist: normalizePlaylist(row.playlist),
	settings: normalizeDisplaySettings(row.settings),
	archivedAt: row.archivedAt,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
	lastSeenAt: row.lastSeenAt,
	online: onlineCount(row.id),
});

// ------------------------------------------------------------------ layouts

export const listLayouts = (): Layout[] =>
	db
		.select()
		.from(schema.layouts)
		.all()
		.map(toLayout)
		.sort((a, b) => a.name.localeCompare(b.name));

export function getLayout(id: string): Layout | null {
	const row = db.select().from(schema.layouts).where(eq(schema.layouts.id, id)).get();
	return row ? toLayout(row) : null;
}

export interface LayoutInput {
	name?: string;
	settings?: unknown;
	elements?: unknown;
	folder?: string;
	archived?: boolean;
}

const folderName = (raw: string) => raw.trim().slice(0, 60);
/** The archive date to store: kept when the state does not change, so re-archiving does not move it. */
const archiveDate = (archived: boolean | undefined, current: number | null) =>
	archived === undefined || archived === (current !== null) ? current : archived ? Date.now() : null;

export function createLayout(input: LayoutInput): Layout {
	const id = newId();
	db.insert(schema.layouts)
		.values({
			id,
			name: input.name?.trim() || "Untitled layout",
			settings: normalizeLayoutSettings(input.settings),
			elements: normalizeElements(input.elements),
			folder: createFolder(input.folder ?? ""),
			archivedAt: archiveDate(input.archived, null),
		})
		.run();
	invalidate();
	return getLayout(id)!;
}

export function updateLayout(id: string, input: LayoutInput): Layout | null {
	const current = getLayout(id);
	if (!current) return null;
	db.update(schema.layouts)
		.set({
			name: input.name?.trim() || current.name,
			settings: input.settings === undefined ? current.settings : normalizeLayoutSettings(input.settings),
			elements: input.elements === undefined ? current.elements : normalizeElements(input.elements),
			folder: input.folder === undefined ? current.folder : createFolder(input.folder),
			archivedAt: archiveDate(input.archived, current.archivedAt),
		})
		.where(eq(schema.layouts.id, id))
		.run();
	invalidate();
	// Filing a layout away changes nothing on screen: only its content makes displays refetch.
	if (input.name !== undefined || input.settings !== undefined || input.elements !== undefined)
		notify({ event: "update", data: null }, displaysUsing(id));
	return getLayout(id);
}

export function deleteLayout(id: string): boolean {
	const affected = displaysUsing(id);
	// Drop the layout from every playlist it was part of.
	for (const row of db.select().from(schema.displays).all()) {
		const playlist = normalizePlaylist(row.playlist);
		if (playlist.some((e) => e.layoutId === id)) {
			db.update(schema.displays)
				.set({ playlist: playlist.filter((e) => e.layoutId !== id) })
				.where(eq(schema.displays.id, row.id))
				.run();
		}
	}
	const removed = db.delete(schema.layouts).where(eq(schema.layouts.id, id)).returning({ id: schema.layouts.id }).all();
	invalidate();
	notify({ event: "update", data: null }, affected);
	return removed.length > 0;
}

// ------------------------------------------------------------------ folders
// A folder is only a name: layouts carry the name of theirs, and the names
// that were created are kept in the settings so an empty folder still exists.

/** Every folder, sorted: the ones created, and any a layout names without it having been (older data). */
export function listFolders(): string[] {
	const used = db.selectDistinct({ folder: schema.layouts.folder }).from(schema.layouts).all();
	return [...new Set([...getSetting("folders"), ...used.map((row) => row.folder)])]
		.filter(Boolean)
		.sort((a, b) => a.localeCompare(b));
}

/** Makes sure a folder exists and returns its tidied name; "" (no folder) when the name is blank. */
export function createFolder(raw: string): string {
	const name = folderName(raw);
	const known = getSetting("folders");
	if (name && !known.includes(name)) setSetting("folders", [...known, name]);
	return name;
}

/** Raw SQL, like `touchDisplay`: refiling is not an edit of the layouts, so their `updated_at` stays. */
const refile = (from: string, to: string) => db.run(sql`update layouts set folder = ${to} where folder = ${from}`);
const forgetFolder = (name: string) =>
	setSetting(
		"folders",
		getSetting("folders").filter((f) => f !== name),
	);

/** Renames a folder, taking its layouts along; renaming to an existing folder merges the two. */
export function renameFolder(from: string, raw: string): string {
	const to = folderName(raw);
	if (!to || to === from) return to;
	forgetFolder(from);
	createFolder(to);
	refile(from, to);
	return to;
}

/** Removes a folder. Its layouts are kept, in no folder. */
export function deleteFolder(name: string) {
	forgetFolder(name);
	refile(name, "");
}

// ----------------------------------------------------------------- displays

export const listDisplays = (): Display[] =>
	db
		.select()
		.from(schema.displays)
		.all()
		.map(toDisplay)
		.sort((a, b) => a.name.localeCompare(b.name));

export function getDisplay(id: string): Display | null {
	const row = db.select().from(schema.displays).where(eq(schema.displays.id, id)).get();
	return row ? toDisplay(row) : null;
}

export interface DisplayInput {
	name?: string;
	slug?: string;
	playlist?: unknown;
	settings?: unknown;
	archived?: boolean;
}

/** A short address that another display already answers to. */
export class SlugTaken extends Error {
	readonly status = 409;
	constructor(slug: string) {
		super(`Another display already uses the address "${slug}".`);
	}
}

/**
 * The short address to store for a display: null for none. It must not be
 * another display's slug, nor any display's id, or `/d/<it>` would be ambiguous.
 */
function freeSlug(raw: string | undefined, ownId: string): string | null {
	const slug = normalizeSlug(raw);
	if (!slug) return null;
	const taken = db
		.select({ id: schema.displays.id })
		.from(schema.displays)
		.where(or(eq(schema.displays.slug, slug), eq(schema.displays.id, slug)))
		.all()
		.some((row) => row.id !== ownId || row.id === slug);
	if (taken) throw new SlugTaken(slug);
	return slug;
}

export function createDisplay(input: DisplayInput): Display {
	const id = newId();
	db.insert(schema.displays)
		.values({
			id,
			name: input.name?.trim() || "New display",
			slug: freeSlug(input.slug, id),
			playlist: normalizePlaylist(input.playlist),
			settings: normalizeDisplaySettings(input.settings),
			archivedAt: archiveDate(input.archived, null),
		})
		.run();
	invalidate();
	return getDisplay(id)!;
}

export function updateDisplay(id: string, input: DisplayInput): Display | null {
	const current = getDisplay(id);
	if (!current) return null;
	db.update(schema.displays)
		.set({
			name: input.name?.trim() || current.name,
			slug: input.slug === undefined ? current.slug || null : freeSlug(input.slug, id),
			playlist: input.playlist === undefined ? current.playlist : normalizePlaylist(input.playlist),
			settings: input.settings === undefined ? current.settings : normalizeDisplaySettings(input.settings),
			archivedAt: archiveDate(input.archived, current.archivedAt),
		})
		.where(eq(schema.displays.id, id))
		.run();
	invalidate();
	notify({ event: "update", data: null }, [id]);
	return getDisplay(id);
}

export function deleteDisplay(id: string): boolean {
	const removed = db
		.delete(schema.displays)
		.where(eq(schema.displays.id, id))
		.returning({ id: schema.displays.id })
		.all();
	invalidate();
	// Screens still pointing at it reload and show "display not found".
	notify({ event: "reload", data: null }, [id]);
	return removed.length > 0;
}

export function touchDisplay(id: string) {
	// Raw SQL so the row's `updated_at` (an edit timestamp) is left alone.
	db.run(sql`update displays set last_seen_at = ${Date.now()} where id = ${id}`);
}

// --------------------------------------------------------------------- views

interface View {
	payload: ViewPayload;
	/** Every element of every layout of the display, by id. */
	elements: Map<string, AnyEl>;
	entities: Set<string>;
	layoutIds: Set<string>;
}

// What each display shows, built on demand and dropped on any write: screens
// poll element data often, so this keeps those requests off the database.
const views = new Map<string, View | null>();
/** Display ids by slug, built and dropped along with the views. */
let slugs: Map<string, string> | null = null;
function invalidate() {
	views.clear();
	slugs = null;
}

/** A display is addressed by its id or by its slug; everything past this point works with the id. */
function displayIdOf(key: string): string {
	if (views.get(key)) return key;
	if (!slugs) {
		slugs = new Map();
		for (const row of db.select({ id: schema.displays.id, slug: schema.displays.slug }).from(schema.displays).all())
			if (row.slug) slugs.set(row.slug, row.id);
	}
	return slugs.get(key.toLowerCase()) ?? key;
}

function view(displayKey: string): View | null {
	const displayId = displayIdOf(displayKey);
	if (!views.has(displayId)) views.set(displayId, buildView(displayId));
	return views.get(displayId) ?? null;
}

/**
 * A copy of a layout without what only the server may know: fields marked
 * `secret` in the catalogue (API keys, request headers, private addresses)
 * are blanked. The resolvers keep working from the stored elements.
 */
function withoutSecrets(layout: Layout): Layout {
	// How the admin files a layout is not a screen's business either.
	const copy = { ...structuredClone(layout), folder: "", archivedAt: null };
	walk(copy.elements, (el) => {
		const values = el as Record<string, unknown>;
		for (const field of isElementType(el.type) ? definition(el.type).fields : []) {
			if (field.secret && typeof values[field.key] === "string") values[field.key] = "";
			const rows = values[field.key];
			if (field.kind !== "list" || !Array.isArray(rows)) continue;
			for (const inner of field.fields ?? []) {
				if (!inner.secret) continue;
				for (const row of rows as Record<string, unknown>[])
					if (typeof row[inner.key] === "string") row[inner.key] = "";
			}
		}
	});
	return copy;
}

function buildView(displayId: string): View | null {
	const display = getDisplay(displayId);
	if (!display) return null;
	const elements = new Map<string, AnyEl>();
	const entities = new Set<string>();
	const layoutIds = new Set<string>();
	const entries: ViewPayload["entries"] = [];
	for (const entry of display.playlist) {
		const layout = getLayout(entry.layoutId);
		if (!layout) continue;
		layoutIds.add(layout.id);
		walk(layout.elements, (el) => {
			elements.set(el.id, el);
			for (const entity of entitiesOf(el)) entities.add(entity);
		});
		entries.push({
			seconds: entry.seconds,
			days: entry.days,
			from: entry.from,
			to: entry.to,
			layout: withoutSecrets(layout),
		});
	}
	return {
		payload: {
			display: { id: display.id, name: display.name, settings: display.settings },
			entries,
			general: getSetting("general"),
			version: config.version,
		},
		elements,
		entities,
		layoutIds,
	};
}

/** Both take what the address of a display page ends in: its id or its slug. */
export const viewPayload = (displayKey: string) => view(displayKey)?.payload ?? null;
export const viewElement = (displayKey: string, elementId: string) => view(displayKey)?.elements.get(elementId) ?? null;

function displaysUsing(layoutId: string): string[] {
	return [...connectedDisplayIds()].filter((id) => view(id)?.layoutIds.has(layoutId));
}

/** Tells connected screens which of the entities they use just changed. */
export function notifyEntities(changed: string[]) {
	for (const displayId of connectedDisplayIds()) {
		const used = view(displayId)?.entities;
		if (!used?.size) continue;
		const relevant = changed.filter((id) => used.has(id));
		if (relevant.length) notify({ event: "entities", data: relevant }, [displayId]);
	}
}

/** Settings shared by every display changed: all screens refetch. */
export function settingsChanged() {
	invalidate();
	notify({ event: "update", data: null });
}
