/**
 * The media library: uploaded pictures and videos, stored as files in the
 * data directory and described in the `media` table.
 */
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { newId } from "../shared/layout";
import type { MediaItem } from "../shared/types";
import { config } from "./config";
import { db, schema } from "./db";

const cacheDir = join(config.dataDir, "cache");
mkdirSync(cacheDir, { recursive: true });

/** Extension → MIME type of everything the library accepts. */
const TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".svg": "image/svg+xml",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".pdf": "application/pdf",
};
/** Formats `Bun.Image` can decode, and so resize. */
const RESIZABLE = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export const listMedia = (): MediaItem[] =>
	db
		.select()
		.from(schema.media)
		.all()
		.sort((a, b) => b.createdAt - a.createdAt);

export class UploadError extends Error {}

export async function saveUpload(file: File, album: string): Promise<MediaItem> {
	const ext = extname(file.name).toLowerCase();
	const mime = TYPES[ext];
	if (!mime) throw new UploadError(`${file.name}: this file type is not supported`);
	const id = newId();
	const stored = `${id}${ext}`;
	const path = join(config.mediaDir, stored);
	await Bun.write(path, file);
	let width: number | null = null;
	let height: number | null = null;
	if (RESIZABLE.has(ext)) {
		try {
			// Reading the header doubles as a check that the file is the image it claims to be.
			({ width, height } = await Bun.file(path).image().metadata());
		} catch {
			await unlink(path).catch(() => {});
			throw new UploadError(`${file.name}: this is not a valid image`);
		}
	}
	if (ext === ".pdf" && (await Bun.file(path).slice(0, 5).text()) !== "%PDF-") {
		await unlink(path).catch(() => {});
		throw new UploadError(`${file.name}: this is not a valid PDF`);
	}
	const item: MediaItem = {
		id,
		name: basename(file.name, extname(file.name)).slice(0, 120) || "Untitled",
		file: stored,
		kind: mime.startsWith("video/") ? "video" : mime === "application/pdf" ? "document" : "image",
		mime,
		size: file.size,
		width,
		height,
		album: album.trim().slice(0, 60),
		createdAt: Date.now(),
	};
	db.insert(schema.media).values(item).run();
	return item;
}

export function updateMedia(id: string, patch: { name?: string; album?: string }): MediaItem | null {
	const set: Partial<MediaItem> = {};
	if (typeof patch.name === "string" && patch.name.trim()) set.name = patch.name.trim().slice(0, 120);
	if (typeof patch.album === "string") set.album = patch.album.trim().slice(0, 60);
	if (Object.keys(set).length) db.update(schema.media).set(set).where(eq(schema.media.id, id)).run();
	return db.select().from(schema.media).where(eq(schema.media.id, id)).get() ?? null;
}

/** Files several items under one album ("" = none) at once. Returns how many changed hands. */
export function moveMedia(ids: string[], album: string): number {
	if (!ids.length) return 0;
	return db
		.update(schema.media)
		.set({ album: album.trim().slice(0, 60) })
		.where(inArray(schema.media.id, ids))
		.returning({ id: schema.media.id })
		.all().length;
}

export async function deleteMedia(id: string): Promise<boolean> {
	const [row] = db.delete(schema.media).where(eq(schema.media.id, id)).returning().all();
	if (!row) return false;
	await unlink(join(config.mediaDir, row.file)).catch(() => {});
	for await (const cachedFile of new Bun.Glob(`${row.id}-*.webp`).scan(cacheDir))
		await unlink(join(cacheDir, cachedFile)).catch(() => {});
	return true;
}

const WIDTHS = [160, 320, 640, 1280, 1920, 2560];

/**
 * Serves a stored file. `width` asks for a downscaled WebP (made once, then
 * cached), so a 12-megapixel photo is not shipped whole to a small screen.
 * Byte ranges are honoured: browsers need them to loop and seek videos.
 */
export async function serveMedia(name: string, request: Request, width?: number): Promise<Response> {
	const fileName = basename(name);
	const ext = extname(fileName).toLowerCase();
	const type = TYPES[ext];
	let file = Bun.file(join(config.mediaDir, fileName));
	if (!type || !(await file.exists())) return new Response("Not found", { status: 404 });

	const headers: Record<string, string> = {
		"content-type": type,
		// File names are unique per upload, so they can be cached for good.
		"cache-control": "public, max-age=31536000, immutable",
		"x-content-type-options": "nosniff",
		"accept-ranges": "bytes",
	};
	// An SVG can carry scripts: never let one run with this site's origin.
	// A PDF is only ever drawn by the PDF element: opened directly, it downloads.
	if (ext === ".pdf") headers["content-disposition"] = "attachment";
	if (ext === ".svg") headers["content-security-policy"] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

	if (width && RESIZABLE.has(ext)) {
		const target = WIDTHS.find((w) => w >= width) ?? WIDTHS.at(-1)!;
		const resizedPath = join(cacheDir, `${basename(fileName, ext)}-${target}.webp`);
		const resized = Bun.file(resizedPath);
		try {
			if (!(await resized.exists())) {
				await file
					.image()
					.resize(target, target, { fit: "inside", withoutEnlargement: true })
					.webp({ quality: 82 })
					.write(resized);
			}
			// A fresh handle: the one that was asked "do you exist?" before the write still says it is empty.
			file = Bun.file(resizedPath);
			headers["content-type"] = "image/webp";
		} catch {
			// Fall back to the original.
		}
	}

	const size = file.size;
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start >= size || start > end)
			return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
		return new Response(file.slice(start, end + 1), {
			status: 206,
			headers: {
				...headers,
				"content-range": `bytes ${start}-${end}/${size}`,
				"content-length": String(end - start + 1),
			},
		});
	}
	return new Response(file, { headers });
}
