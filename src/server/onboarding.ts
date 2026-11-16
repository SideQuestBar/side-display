/**
 * First-run setup: what can be guessed about the region and the location, and
 * the place search behind the location step.
 */
import type { GeneralSettings, Place } from "../shared/types";
import { connection, haJson } from "./ha/client";
import { getSetting, hasSetting } from "./settings";

/**
 * The guide is offered until it is finished or skipped. Saved region settings
 * count as finished, so installations older than the guide never see it.
 */
export const onboardingNeeded = () => !getSetting("onboarded") && !hasSetting("general");

interface HaConfig {
	latitude?: number;
	longitude?: number;
	time_zone?: string;
	location_name?: string;
	language?: string;
	country?: string | null;
	unit_system?: { temperature?: string };
}

const valid = (check: () => unknown) => {
	try {
		check();
		return true;
	} catch {
		return false;
	}
};

/** What the connected Home Assistant knows about where and how it is used; empty without one. */
export async function suggestedSettings(): Promise<Partial<GeneralSettings>> {
	if (!connection()) return {};
	let ha: HaConfig;
	try {
		// The guide waits for this, so do not hold it up for long.
		ha = await haJson<HaConfig>("/config", { signal: AbortSignal.timeout(4000) });
	} catch {
		return {};
	}
	const suggested: Partial<GeneralSettings> = {};
	const locale = [ha.language, ha.country].filter(Boolean).join("-");
	if (locale && valid(() => new Intl.Locale(locale))) suggested.locale = new Intl.Locale(locale).toString();
	if (ha.time_zone && valid(() => new Intl.DateTimeFormat("en", { timeZone: ha.time_zone }))) {
		suggested.timezone = ha.time_zone;
	}
	const unit = ha.unit_system?.temperature;
	if (unit) suggested.temperatureUnit = unit.includes("F") ? "f" : "c";
	const { latitude, longitude } = ha;
	if (
		typeof latitude === "number" &&
		typeof longitude === "number" &&
		Math.abs(latitude) <= 90 &&
		Math.abs(longitude) <= 180 &&
		// Home Assistant's own "not set".
		(latitude !== 0 || longitude !== 0)
	) {
		suggested.latitude = latitude;
		suggested.longitude = longitude;
		if (ha.location_name) suggested.locationName = ha.location_name.slice(0, 120);
	}
	return suggested;
}

/** Towns, villages and postcodes matching a name, from Open-Meteo's geocoder (no account needed). */
export async function searchPlaces(query: string, language: string): Promise<Place[]> {
	const name = query.trim();
	if (name.length < 2) return [];
	const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
	url.search = new URLSearchParams({ name, count: "6", language: language || "en", format: "json" }).toString();
	const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!response.ok) throw new Error(`Open-Meteo answered ${response.status}`);
	const body = (await response.json()) as {
		results?: {
			name: string;
			latitude: number;
			longitude: number;
			country?: string;
			admin1?: string;
			timezone?: string;
		}[];
	};
	return (body.results ?? []).map((place) => ({
		name: place.name,
		region: place.admin1 && place.admin1 !== place.name ? place.admin1 : "",
		country: place.country ?? "",
		latitude: place.latitude,
		longitude: place.longitude,
		timezone: place.timezone ?? "",
	}));
}
