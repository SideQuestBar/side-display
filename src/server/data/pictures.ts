/**
 * Server data of the text and gallery elements: the entity states a text
 * names in its placeholders, and the photos of an album with their dates.
 */
import { extname, join } from "node:path";
import type { GalleryData, TextData } from "../../shared/data";
import type { El } from "../../shared/elements";
import { placeholderEntities } from "../../shared/placeholders";
import { zoned } from "../../shared/time";
import type { GeneralSettings } from "../../shared/types";
import { config } from "../config";
import { entityState } from "../ha/client";
import { listMedia } from "../media";
import { exifDate } from "./exif";

/** Only the entities written in the text, and of those only what is shown. */
export function textStates(el: El<"text">): TextData {
	const states: TextData["states"] = {};
	for (const id of placeholderEntities(el.text)) {
		const state = entityState(id);
		if (state) states[id] = { state: state.state, unit: state.unit };
	}
	return { states };
}

/** EXIF sits at the start of a JPEG; a segment is at most 64 KB, a few of them may come first. */
const EXIF_WINDOW = 256 * 1024;
/** Stored files never change (a new upload gets a new name), so a date is read once. */
const captureDates = new Map<string, Promise<string | null>>();

function captureDate(file: string): Promise<string | null> {
	if (!/^\.jpe?g$/i.test(extname(file))) return Promise.resolve(null);
	let date = captureDates.get(file);
	if (!date) {
		date = Bun.file(join(config.mediaDir, file))
			.slice(0, EXIF_WINDOW)
			.bytes()
			.then(exifDate)
			.catch(() => null);
		captureDates.set(file, date);
		// Deleted files would otherwise be remembered for ever.
		if (captureDates.size > 5000) captureDates.delete(captureDates.keys().next().value as string);
	}
	return date;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An upload time in the shape of an EXIF date: wall-clock time where the instance is. */
function localStamp(at: number, timeZone: string): string {
	const z = zoned(at, timeZone);
	return `${z.year}-${pad(z.month)}-${pad(z.day)}T${pad(z.hour)}:${pad(z.minute)}:${pad(z.second)}`;
}

export async function galleryPhotos(el: El<"gallery">, general: GeneralSettings): Promise<GalleryData> {
	// Newest upload first, which is the order "as uploaded" keeps.
	const media = listMedia().filter((m) => m.kind === "image" && (!el.album || m.album === el.album));
	const items = await Promise.all(
		media.map(async (m) => ({
			src: `media/${m.file}`,
			name: m.name,
			date: (await captureDate(m.file)) ?? localStamp(m.createdAt, general.timezone),
			width: m.width ?? 0,
			height: m.height ?? 0,
		})),
	);
	if (el.order === "name") {
		let collator: Intl.Collator;
		try {
			collator = new Intl.Collator(general.locale || undefined, { numeric: true, sensitivity: "base" });
		} catch {
			collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
		}
		items.sort((a, b) => collator.compare(a.name, b.name));
	}
	// Both dates have the same shape, so they sort as text. Oldest first: an album reads as a story.
	if (el.order === "date") items.sort((a, b) => a.date.localeCompare(b.date));
	return { items };
}
