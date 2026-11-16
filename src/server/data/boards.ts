/**
 * Server side of the board elements: the posts of a social wall, and the
 * bytes of a PDF that lives on another site (which a browser may not fetch
 * itself).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SocialData, SocialPost } from "../../shared/data";
import type { El } from "../../shared/elements";
import type { AnyEl } from "../../shared/types";
import { config } from "../config";
import { cached, plain } from "./sources";

// ------------------------------------------------------------------- social

const TEXT_LIMIT = 500;

async function json<T>(url: string, host: string): Promise<T> {
	const response = await fetch(url, {
		headers: { accept: "application/json", "user-agent": "SideDisplay" },
		signal: AbortSignal.timeout(15_000),
	});
	if (response.status === 404 || response.status === 400) throw new Error(`${host} does not know this account`);
	if (!response.ok) throw new Error(`${host} answered ${response.status}`);
	return response.json() as Promise<T>;
}

const clip = (text: string) => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1).trimEnd()}…` : text);

/**
 * The text of a Mastodon post. Its HTML hides the scheme and the tail of long
 * links in "invisible" spans and wraps hashtags and mentions in tags of their
 * own, so tags are removed without leaving a space behind ("#" + "tag").
 */
export function mastodonText(html: string): string {
	return clip(
		plain(
			html
				.replace(/<span class="invisible">[^<]*<\/span>/g, "")
				.replace(/<span class="ellipsis">([^<]*)<\/span>/g, "$1…")
				.replace(/<br\s*\/?>|<\/p>/gi, " ")
				.replace(/<[^>]*>/g, ""),
		),
	);
}

interface MastodonStatus {
	created_at: string;
	content: string;
	sensitive: boolean;
	spoiler_text: string;
	visibility: string;
	in_reply_to_id: string | null;
	reblog: MastodonStatus | null;
	account: { acct: string; display_name: string; avatar_static: string };
	media_attachments: { type: string; preview_url: string | null; description: string | null }[];
}

/** One post for the wall, or null when it should not be on a public screen. */
export function mastodonPost(status: MastodonStatus, hideReplies: boolean, hideBoosts: boolean): SocialPost | null {
	if (status.reblog && hideBoosts) return null;
	if (status.in_reply_to_id && hideReplies) return null;
	const shown = status.reblog ?? status;
	// Posts behind a content warning are not for a screen in a public room.
	if (shown.sensitive || shown.spoiler_text || shown.visibility !== "public") return null;
	const picture = shown.media_attachments?.find((m) => m.type === "image" && m.preview_url);
	const text = mastodonText(shown.content ?? "");
	if (!text && !picture) return null;
	return {
		author: plain(shown.account.display_name) || shown.account.acct,
		handle: `@${shown.account.acct}`,
		avatar: shown.account.avatar_static ?? "",
		text,
		date: shown.created_at,
		image: picture?.preview_url ?? "",
		boostedBy: status.reblog ? plain(status.account.display_name) || status.account.acct : "",
	};
}

interface BlueskyImage {
	thumb: string;
}
interface BlueskyFeedItem {
	post: {
		author: { handle: string; displayName?: string; avatar?: string };
		record: { text?: string; createdAt?: string };
		embed?: { images?: BlueskyImage[]; media?: { images?: BlueskyImage[] } };
		labels?: unknown[];
		indexedAt: string;
	};
	reply?: unknown;
	reason?: { $type?: string; by?: { handle: string; displayName?: string } };
}

export function blueskyPost(item: BlueskyFeedItem, hideReplies: boolean, hideBoosts: boolean): SocialPost | null {
	const repost = item.reason?.$type === "app.bsky.feed.defs#reasonRepost";
	if (repost && hideBoosts) return null;
	if (item.reply && !repost && hideReplies) return null;
	const { post } = item;
	// Labelled posts (adult content, graphic media…) are not for a screen in a public room.
	if (post.labels?.length) return null;
	const picture = (post.embed?.images ?? post.embed?.media?.images)?.[0];
	const text = clip((post.record.text ?? "").replace(/\s+/g, " ").trim());
	if (!text && !picture) return null;
	return {
		author: post.author.displayName?.trim() || post.author.handle,
		handle: `@${post.author.handle}`,
		avatar: post.author.avatar ?? "",
		text,
		date: post.record.createdAt ?? post.indexedAt,
		image: picture?.thumb ?? "",
		boostedBy: repost ? item.reason?.by?.displayName?.trim() || item.reason?.by?.handle || "" : "",
	};
}

/** `mastodon.social`, `https://mastodon.social/` → the bare host, or "" when it is not one. */
const hostOf = (value: string) => {
	const host = value
		.trim()
		.replace(/^https?:\/\//i, "")
		.replace(/\/.*$/, "")
		.toLowerCase();
	return /^[a-z0-9.-]+\.[a-z]{2,}(:\d+)?$/.test(host) ? host : "";
};

async function mastodonPosts(el: El<"social">): Promise<SocialPost[]> {
	const subject = el.account.trim();
	const tag = subject.startsWith("#");
	// "@user@example.social" names its own server; the instance field is for plain names and hashtags.
	const [name = "", server = ""] = subject.replace(/^[@#]/, "").split("@");
	const host = hostOf(el.instance) || hostOf(server);
	if (!host) throw new Error("enter the address of a Mastodon server");
	if (!name) throw new Error("enter an account or a #hashtag");
	const base = `https://${host}/api/v1`;
	// More than asked for, since content warnings, replies and boosts are dropped afterwards.
	const limit = Math.min(40, el.count * 2 + 5);
	let statuses: MastodonStatus[];
	if (tag) {
		statuses = await json<MastodonStatus[]>(`${base}/timelines/tag/${encodeURIComponent(name)}?limit=${limit}`, host);
	} else {
		const acct = server && hostOf(server) !== host ? `${name}@${server}` : name;
		const account = await cached(`mastodon-account:${host}:${acct.toLowerCase()}`, 86_400, () =>
			json<{ id: string }>(`${base}/accounts/lookup?acct=${encodeURIComponent(acct)}`, host),
		);
		const query = `limit=${limit}&exclude_replies=${el.hideReplies}&exclude_reblogs=${el.hideBoosts}`;
		statuses = await json<MastodonStatus[]>(
			`${base}/accounts/${encodeURIComponent(account.id)}/statuses?${query}`,
			host,
		);
	}
	if (!Array.isArray(statuses)) throw new Error(`${host} did not answer with posts`);
	return statuses.flatMap((status) => mastodonPost(status, el.hideReplies, el.hideBoosts) ?? []);
}

async function blueskyPosts(el: El<"social">): Promise<SocialPost[]> {
	const actor = el.account.trim().replace(/^@/, "");
	if (!actor) throw new Error("enter a Bluesky handle");
	const url = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
	url.search = new URLSearchParams({
		// A bare name is a bsky.social account, as in the app.
		actor: actor.includes(".") || actor.startsWith("did:") ? actor : `${actor}.bsky.social`,
		limit: String(Math.min(60, el.count * 3 + 5)),
		filter: el.hideReplies ? "posts_no_replies" : "posts_with_replies",
	}).toString();
	const body = await json<{ feed?: BlueskyFeedItem[] }>(url.href, "Bluesky");
	return (body.feed ?? []).flatMap((item) => blueskyPost(item, el.hideReplies, el.hideBoosts) ?? []);
}

export async function socialPosts(el: El<"social">): Promise<SocialData> {
	// Nothing asked for yet: the editor shows its own hint.
	if (!el.account.trim()) return { posts: [] };
	const count = Math.min(20, Math.max(1, el.count));
	const key = [el.network, el.instance, el.account, count, el.hideReplies, el.hideBoosts].join("|").toLowerCase();
	const posts = await cached(`social:${key}`, 300, () =>
		el.network === "bluesky" ? blueskyPosts({ ...el, count }) : mastodonPosts({ ...el, count }),
	);
	return { posts: posts.slice(0, count) };
}

// ---------------------------------------------------------------------- PDF

const MAX_PDF_BYTES = 40 * 1024 * 1024;
/** How long a fetched document is served before the site is asked again. */
const PDF_TTL = 600;
const cacheDir = join(config.dataDir, "cache");
mkdirSync(cacheDir, { recursive: true });

/** Downloads a PDF to the cache folder, refusing anything too big or that is not a PDF. */
async function download(url: string, path: string): Promise<void> {
	const response = await fetch(url, {
		headers: { accept: "application/pdf, */*", "user-agent": "SideDisplay" },
		signal: AbortSignal.timeout(60_000),
	});
	const host = new URL(url).host;
	if (!response.ok || !response.body) throw new Error(`${host} answered ${response.status}`);
	if (Number(response.headers.get("content-length") ?? 0) > MAX_PDF_BYTES) throw new Error("this PDF is too big");
	const chunks: Uint8Array[] = [];
	let size = 0;
	// The announced length can be missing or wrong: count what actually arrives.
	for await (const chunk of response.body) {
		size += chunk.byteLength;
		if (size > MAX_PDF_BYTES) throw new Error("this PDF is too big");
		chunks.push(chunk);
	}
	const bytes = Buffer.concat(chunks);
	if (bytes.subarray(0, 1024).indexOf("%PDF-") === -1) throw new Error(`${host} did not answer with a PDF`);
	await Bun.write(path, bytes);
}

/**
 * The PDF of a PDF element whose document is on another site. Library files
 * are served by `/media/` like any other; this is only the proxy for URLs.
 */
export async function pdfDocument(el: AnyEl): Promise<Response | null> {
	const url = typeof el.src === "string" ? el.src.trim() : "";
	if (!/^https?:\/\//i.test(url)) return null;
	const file = Bun.file(join(cacheDir, `pdf-${Bun.hash(url).toString(36)}.pdf`));
	const path = file.name!;
	try {
		await cached(`pdf:${url}`, PDF_TTL, () => download(url, path));
	} catch (err) {
		// The site is down: yesterday's menu beats an empty screen.
		if (!(await file.exists())) throw err;
	}
	return new Response(Bun.file(path), {
		headers: {
			"content-type": "application/pdf",
			"content-disposition": "attachment",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}
