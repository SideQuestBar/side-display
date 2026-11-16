/**
 * Placeholders in a text element: `{time}`, `{date}` and
 * `{entity:sensor.some_id}`. Anything else in braces is left alone, so text
 * that merely contains braces is not mangled.
 */

const TOKEN = /\{\s*(time|date|entity\s*:\s*([a-z0-9_]+\.[a-z0-9_]+))\s*\}/gi;

/** A text never asks for more entities than this, however many it names. */
export const MAX_PLACEHOLDER_ENTITIES = 30;

/** The Home Assistant entities a text names, each once, in order of appearance. */
export function placeholderEntities(text: unknown): string[] {
	if (typeof text !== "string" || !text.includes("{")) return [];
	const out = new Set<string>();
	for (const match of text.matchAll(TOKEN)) if (match[2]) out.add(match[2].toLowerCase());
	return [...out].slice(0, MAX_PLACEHOLDER_ENTITIES);
}

/** Does the text show the time or the date, and so change by itself? */
export function hasClockPlaceholder(text: string): boolean {
	if (!text.includes("{")) return false;
	for (const match of text.matchAll(TOKEN)) if (!match[2]) return true;
	return false;
}

export interface PlaceholderValues {
	time: () => string;
	date: () => string;
	/** The state to show for an entity id (lower case). */
	entity: (id: string) => string;
}

/** The text with every placeholder replaced by its current value. */
export function fillPlaceholders(text: string, values: PlaceholderValues): string {
	if (!text.includes("{")) return text;
	return text.replace(TOKEN, (_, kind: string, entity: string | undefined) => {
		if (entity) return values.entity(entity.toLowerCase());
		return kind.toLowerCase() === "time" ? values.time() : values.date();
	});
}
