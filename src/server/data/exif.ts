/**
 * The one thing a photo frame wants from EXIF: when the picture was taken.
 * `Bun.Image` does not report it (it does apply the orientation), so this
 * reads the JPEG's APP1 segment directly. Pure: bytes in, date out.
 */

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

/** "2024:05:03 14:22:10" → "2024-05-03T14:22:10"; null for blank or zeroed dates. */
function cleanDate(raw: string): string | null {
	const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
	if (!m || m[1] === "0000") return null;
	const [, year, month, day, hour, minute, second] = m;
	if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
	return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/** Reads the TIFF structure inside an APP1 segment. */
function readTiff(view: DataView): string | null {
	if (view.byteLength < 8) return null;
	const order = view.getUint16(0);
	if (order !== 0x4949 && order !== 0x4d4d) return null;
	const little = order === 0x4949;
	if (view.getUint16(2, little) !== 42) return null;

	const dates = new Map<number, string>();
	let exifIfd = 0;
	const readIfd = (offset: number) => {
		if (offset < 8 || offset + 2 > view.byteLength) return;
		const count = view.getUint16(offset, little);
		for (let i = 0; i < count; i++) {
			const entry = offset + 2 + i * 12;
			if (entry + 12 > view.byteLength) return;
			const tag = view.getUint16(entry, little);
			const type = view.getUint16(entry + 2, little);
			const length = view.getUint32(entry + 4, little);
			if (tag === TAG_EXIF_IFD && type === 4) exifIfd = view.getUint32(entry + 8, little);
			else if (
				(tag === TAG_DATETIME || tag === TAG_DATETIME_ORIGINAL || tag === TAG_DATETIME_DIGITIZED) &&
				type === 2
			) {
				// Text longer than four bytes lives elsewhere in the block.
				const at = length > 4 ? view.getUint32(entry + 8, little) : entry + 8;
				if (length < 19 || length > 64 || at + length > view.byteLength) continue;
				let text = "";
				for (let k = 0; k < length; k++) {
					const code = view.getUint8(at + k);
					if (code === 0) break;
					text += String.fromCharCode(code);
				}
				dates.set(tag, text);
			}
		}
	};
	readIfd(view.getUint32(4, little));
	if (exifIfd) readIfd(exifIfd);

	// When the shutter fired, else when it was digitised, else the file's own date.
	for (const tag of [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED, TAG_DATETIME]) {
		const date = cleanDate(dates.get(tag) ?? "");
		if (date) return date;
	}
	return null;
}

/**
 * When a JPEG was taken, as the camera wrote it: `YYYY-MM-DDTHH:MM:SS`, local
 * time without a zone. Only the start of the file is needed (the metadata
 * comes before the picture). Null for anything that is not a JPEG with a date.
 */
export function exifDate(bytes: Uint8Array): string | null {
	try {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
		let offset = 2;
		while (offset + 4 <= view.byteLength) {
			if (view.getUint8(offset) !== 0xff) return null;
			const marker = view.getUint8(offset + 1);
			// Padding bytes and markers without a length.
			if (marker === 0xff) {
				offset += 1;
				continue;
			}
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				offset += 2;
				continue;
			}
			// Start of the picture data, or the end: no metadata past here.
			if (marker === 0xda || marker === 0xd9) return null;
			const length = view.getUint16(offset + 2);
			if (length < 2) return null;
			const start = offset + 4;
			const end = Math.min(offset + 2 + length, view.byteLength);
			// "Exif\0\0"; an XMP packet is an APP1 segment too and is skipped.
			if (
				marker === 0xe1 &&
				end - start > 6 &&
				view.getUint32(start) === 0x45786966 &&
				view.getUint16(start + 4) === 0
			) {
				return readTiff(new DataView(bytes.buffer, bytes.byteOffset + start + 6, end - start - 6));
			}
			offset += 2 + length;
		}
		return null;
	} catch {
		// A truncated or malformed block: the photo simply has no date.
		return null;
	}
}
