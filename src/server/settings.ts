/**
 * Typed access to the key/value settings table.
 */
import { eq } from "drizzle-orm";
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettings, type HaSettings, type MqttSettings } from "../shared/types";
import { db, schema } from "./db";

interface SettingsMap {
	"auth.passwordHash": string | null;
	general: GeneralSettings;
	ha: HaSettings;
	mqtt: MqttSettings;
	/** Set when the first-run guide was skipped. */
	onboarded: boolean;
	/** Layout folders that were created, so one can exist before anything is filed in it. */
	folders: string[];
}

const defaults: SettingsMap = {
	"auth.passwordHash": null,
	general: DEFAULT_GENERAL_SETTINGS,
	ha: { url: "", token: "" },
	mqtt: { url: "", username: "", password: "" },
	onboarded: false,
	folders: [],
};

const cache = new Map<string, unknown>();

export function getSetting<K extends keyof SettingsMap>(key: K): SettingsMap[K] {
	if (!cache.has(key)) {
		const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
		const fallback = defaults[key];
		const value =
			row && fallback && typeof fallback === "object" && !Array.isArray(fallback)
				? { ...fallback, ...(row.value as object) }
				: (row?.value ?? fallback);
		cache.set(key, value);
	}
	return cache.get(key) as SettingsMap[K];
}

/** True once a value was saved for the key, as opposed to reading its default. */
export const hasSetting = (key: keyof SettingsMap) =>
	Boolean(db.select({ key: schema.settings.key }).from(schema.settings).where(eq(schema.settings.key, key)).get());

export function setSetting<K extends keyof SettingsMap>(key: K, value: SettingsMap[K]) {
	db.insert(schema.settings)
		.values({ key, value })
		.onConflictDoUpdate({ target: schema.settings.key, set: { value } })
		.run();
	cache.set(key, value);
}
