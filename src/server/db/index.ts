import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { config } from "../config";
import * as schema from "./schema";

const sqlite = new Database(config.dbPath, { create: true });
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
sqlite.exec("PRAGMA busy_timeout = 5000;");

export const db = drizzle({ client: sqlite });
export { schema };

/** Applies the migrations in `drizzle/`. Safe to run on every start. */
export function runMigrations() {
	migrate(db, { migrationsFolder: config.migrationsDir });
}

export function closeDb() {
	sqlite.close();
}
