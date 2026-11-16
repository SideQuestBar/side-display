import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnyEl, DisplaySettings, LayoutSettings, PlaylistEntry } from "../../shared/types";

const timestamps = {
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
	updatedAt: integer("updated_at")
		.notNull()
		.$defaultFn(() => Date.now())
		.$onUpdateFn(() => Date.now()),
};

/** Key/value store: password hash, general preferences, Home Assistant connection. */
export const settings = sqliteTable("settings", {
	key: text().primaryKey(),
	value: text({ mode: "json" }).$type<unknown>().notNull(),
});

/** Admin sessions. Only a hash of the cookie token is stored. */
export const sessions = sqliteTable("sessions", {
	id: text().primaryKey(),
	createdAt: integer("created_at").notNull(),
	expiresAt: integer("expires_at").notNull(),
	userAgent: text("user_agent").notNull().default(""),
});

export const layouts = sqliteTable("layouts", {
	id: text().primaryKey(),
	name: text().notNull(),
	settings: text({ mode: "json" }).$type<LayoutSettings>().notNull(),
	elements: text({ mode: "json" }).$type<AnyEl[]>().notNull(),
	/** Name of the folder the layout is filed under in the admin; empty = none. */
	folder: text().notNull().default(""),
	/** When the layout was archived; null while it is in use. */
	archivedAt: integer("archived_at"),
	...timestamps,
});

export const displays = sqliteTable(
	"displays",
	{
		id: text().primaryKey(),
		name: text().notNull(),
		/** Optional short name for the address (`/d/<slug>`); null when the display has none. */
		slug: text(),
		playlist: text({ mode: "json" }).$type<PlaylistEntry[]>().notNull(),
		settings: text({ mode: "json" }).$type<DisplaySettings>().notNull(),
		lastSeenAt: integer("last_seen_at"),
		archivedAt: integer("archived_at"),
		...timestamps,
	},
	// An index rather than a column constraint: SQLite can add it without rebuilding the table.
	(table) => [uniqueIndex("displays_slug_unique").on(table.slug)],
);

export const media = sqliteTable("media", {
	id: text().primaryKey(),
	name: text().notNull(),
	file: text().notNull(),
	kind: text().$type<"image" | "video" | "document">().notNull(),
	mime: text().notNull(),
	size: integer().notNull(),
	width: integer(),
	height: integer(),
	album: text().notNull().default(""),
	createdAt: integer("created_at")
		.notNull()
		.$defaultFn(() => Date.now()),
});
