/**
 * The pure logic behind the board elements (announcement banner, menu board,
 * Wi-Fi card): no DOM and no server APIs, so it can be tested on its own.
 */
import type { ZonedParts } from "./time";

const pad = (n: number) => String(n).padStart(2, "0");

/** A zoned time in the shape of a `datetime-local` value, so the two compare as text. */
export const localStamp = (now: ZonedParts) =>
	`${now.year}-${pad(now.month)}-${pad(now.day)}T${pad(now.hour)}:${pad(now.minute)}`;

/**
 * Is `now` inside the window? Both ends are `datetime-local` values in the
 * instance's time zone; an empty end is open. The end itself is excluded, so
 * "until 18:00" is gone at 18:00.
 */
export function inWindow(now: string, from: string, until: string): boolean {
	return (!from || now >= from) && (!until || now < until);
}

export interface MenuItem {
	section: string;
	name: string;
	description: string;
	price: string;
	allergens: string;
	soldOut: boolean;
}

/**
 * Groups the flat rows of a menu into sections, in the order each section
 * first appears. A row without a section joins the one above it, so the
 * section only needs typing once.
 */
export function menuSections(items: MenuItem[], hideSoldOut = false): { name: string; items: MenuItem[] }[] {
	const sections: { name: string; items: MenuItem[] }[] = [];
	let current = "";
	for (const item of items) {
		current = item.section.trim() || current;
		if (hideSoldOut && item.soldOut) continue;
		let section = sections.find((s) => s.name === current);
		if (!section) {
			section = { name: current, items: [] };
			sections.push(section);
		}
		section.items.push(item);
	}
	return sections;
}

/** A price as shown: the currency goes around numbers only, so "Market price" stays as typed. */
export function menuPrice(price: string, before: string, after: string): string {
	const value = price.trim();
	return /^\d+([.,]\d+)?$/.test(value) ? `${before}${value}${after}` : value;
}

export type WifiSecurity = "WPA" | "WEP" | "nopass";

const wifiEscape = (value: string) => value.replace(/[\\;,:"]/g, "\\$&");

/** The text of a "join this network" QR code, as phones read it. */
export function wifiPayload(ssid: string, password: string, security: WifiSecurity, hidden = false): string {
	const open = security === "nopass" || !password;
	return `WIFI:T:${open ? "nopass" : security};S:${wifiEscape(ssid)};${open ? "" : `P:${wifiEscape(password)};`}${hidden ? "H:true;" : ""};`;
}
