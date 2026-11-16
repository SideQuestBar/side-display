/**
 * Server-side data of the video, web page, ticker and news feed elements:
 * subtitles fetched for the browser, screenshots of web pages, and feeds
 * merged and filtered.
 */
import type { FeedData, FeedItem, TickerData, VideoData, WebData } from "../../shared/data";
import type { El } from "../../shared/elements";
import type { AnyEl } from "../../shared/types";
import { cached, feed, fetchText } from "./sources";

// -------------------------------------------------------------------- video

/** SubRip differs from WebVTT by its header, its cue numbers (which WebVTT tolerates) and a comma. */
const srtToVtt = (srt: string) => `WEBVTT\n\n${srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")}`;

/**
 * The subtitles of a video, as WebVTT text. They are fetched here because a
 * browser only loads a `<track>` from another site when both that site and
 * the video's send CORS headers, which is rarely the case.
 */
export async function videoData(el: El<"video">): Promise<VideoData | null> {
	const url = el.subtitles.trim();
	if (!url) return null;
	const text = await cached(`subtitles:${url}`, 3600, async () => {
		const body = (await fetchText(url, "text/vtt, application/x-subrip, text/plain, */*")).replace(/^\uFEFF/, "");
		if (body.length > 2_000_000) throw new Error("the subtitle file is too large");
		if (body.startsWith("WEBVTT")) return body;
		if (/^\s*\d+\s*\r?\n\d{2}:\d{2}:\d{2},\d{3} -->/.test(body)) return srtToVtt(body.replace(/\r/g, ""));
		throw new Error("the subtitles are not a WebVTT (.vtt) or SubRip (.srt) file");
	});
	return { subtitles: text };
}

// ---------------------------------------------------------------- web page

interface Shot {
	png: Blob;
	at: number;
}

/** Headless Chrome keeps this much of the requested height for itself. */
const CHROME = 87;
const SHOT_TIMEOUT = 40_000;

// One render at a time: a headless browser tab is by far the heaviest thing
// this server does, and a wall of screens must not start twenty of them.
let queue: Promise<unknown> = Promise.resolve();
const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
	const run = queue.then(task, task);
	queue = run.catch(() => {});
	return run;
};

async function render(url: string, width: number, height: number, wait: number, x: number, y: number): Promise<Shot> {
	let view: Bun.WebView;
	try {
		view = new Bun.WebView({
			width,
			height: height + CHROME,
			// Never attach to a browser somebody happens to have open on this machine.
			backend: process.platform === "darwin" ? undefined : { type: "chrome", url: false, argv: chromeFlags() },
		});
	} catch {
		throw new Error("screenshot mode needs Chromium on the server");
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("the page took too long to render")), SHOT_TIMEOUT);
	});
	const work = (async (): Promise<Shot> => {
		await view.navigate(url);
		// A redirect must not lead anywhere a display should not see (file:, chrome:…).
		if (!/^https?:\/\//i.test(view.url)) throw new Error("the address must start with http:// or https://");
		if (x > 0 || y > 0) await view.evaluate(`window.scrollTo(${x}, ${y})`);
		// `load` has fired; dashboards drawn by scripts need a little longer.
		await Bun.sleep(wait * 1000);
		return { png: await view.screenshot(), at: Date.now() };
	})();
	// Once the timeout has won, a late failure of the abandoned render has nobody to report to.
	work.catch(() => {});
	try {
		return await Promise.race([work, timeout]);
	} catch (err) {
		const message = (err as Error).message ?? "";
		if (/spawn Chrome|Chrome process|install Chrome/i.test(message)) {
			throw new Error("screenshot mode needs Chromium on the server");
		}
		throw new Error(message.startsWith("net::") ? `the page could not be loaded (${message.slice(5)})` : message);
	} finally {
		clearTimeout(timer);
		// Closing the tab also ends a render that timed out.
		try {
			view.close();
		} catch {
			// Already gone.
		}
	}
}

/** No scrollbars in the picture; and Chrome refuses to start as root (usual in a container) with its sandbox on. */
const chromeFlags = () => ["--hide-scrollbars", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value) || min));

/** How long a screenshot is kept: the element's reload period, at least a minute; hourly when it never reloads. */
const shotSeconds = (el: El<"web">) => (el.refresh > 0 ? Math.max(60, el.refresh) : 3600);

/**
 * A picture of the element's page, rendered by a headless browser and kept
 * for the element's reload period. Elements showing the same page at the same
 * size share one render.
 */
function screenshot(el: El<"web">): Promise<Shot> {
	const url = el.url.trim();
	if (!/^https?:\/\//i.test(url)) throw new Error("the address must start with http:// or https://");
	const width = clamp(el.shotWidth, 200, 3840);
	const height = clamp(el.shotHeight, 200, 3840);
	const wait = Math.min(15, Math.max(0, el.shotWait));
	const x = clamp(el.offsetX, 0, 20_000);
	const y = clamp(el.offsetY, 0, 20_000);
	return cached(`shot:${url}:${width}:${height}:${wait}:${x}:${y}`, shotSeconds(el), () =>
		inTurn(() => render(url, width, height, wait, x, y)),
	);
}

/** Tells the display when a new screenshot is ready (and why there is none). */
export async function webData(el: El<"web">): Promise<WebData | null> {
	if (el.mode !== "screenshot" || !el.url.trim()) return null;
	return { shot: (await screenshot(el)).at };
}

/** The screenshot itself, for the per-element picture route. */
export async function webPicture(el: AnyEl): Promise<Response | null> {
	const web = el as unknown as El<"web">;
	if (web.mode !== "screenshot") return null;
	const shot = await screenshot(web);
	return new Response(shot.png, { headers: { "content-type": "image/png", "cache-control": "no-store" } });
}

// ------------------------------------------------------------------- feeds

const addresses = (first: string, more: { url: string }[]) =>
	[first, ...more.map((row) => row.url)].map((url) => url.trim()).filter(Boolean);

/** Loads several feeds; the ones that fail are skipped unless all of them do. */
async function feeds(urls: string[]): Promise<(FeedData | null)[]> {
	const results = await Promise.allSettled(urls.map((url) => feed(url)));
	const failed = results.find((r) => r.status === "rejected");
	if (failed && results.every((r) => r.status === "rejected")) throw failed.reason;
	return results.map((r) => (r.status === "fulfilled" ? r.value : null));
}

const TICKER_HEADLINES = 15;

export async function tickerData(el: El<"ticker">): Promise<TickerData> {
	const urls = addresses(el.feed, el.feeds);
	if (!urls.length) return { headlines: [] };
	const lists = (await feeds(urls)).map((data) => data?.items.map((item) => item.title).filter(Boolean) ?? []);
	// One headline of each feed in turn, so no feed crowds the others out.
	const headlines: string[] = [];
	for (let i = 0; headlines.length < TICKER_HEADLINES && lists.some((list) => i < list.length); i++) {
		for (const list of lists) if (i < list.length && headlines.length < TICKER_HEADLINES) headlines.push(list[i]!);
	}
	return { headlines };
}

const keywords = (text: string) =>
	text
		.split(",")
		.map((word) => word.trim().toLowerCase())
		.filter(Boolean);

/** The news feed element's own filters: keywords on title and summary, and a maximum age. */
export function filterFeed(
	items: FeedItem[],
	options: { include: string; exclude: string; maxAge: number },
	now = Date.now(),
): FeedItem[] {
	const include = keywords(options.include);
	const exclude = keywords(options.exclude);
	const oldest = options.maxAge > 0 ? now - options.maxAge * 3600_000 : 0;
	return items.filter((item) => {
		const text = `${item.title} ${item.summary}`.toLowerCase();
		if (include.length && !include.some((word) => text.includes(word))) return false;
		if (exclude.some((word) => text.includes(word))) return false;
		// An item without a date cannot be shown to be recent.
		if (oldest && !(Date.parse(item.date) >= oldest)) return false;
		return true;
	});
}

/** Newest first; items without a date last, in the order they came. */
export const byDate = (items: FeedItem[]): FeedItem[] =>
	items
		.map((item, i) => ({ item, i, time: Date.parse(item.date) || 0 }))
		.sort((a, b) => b.time - a.time || a.i - b.i)
		.map((entry) => entry.item);

export async function rssData(el: El<"rss">): Promise<FeedData> {
	const sources = [{ url: el.url, label: el.sourceLabel }, ...el.feeds]
		.map((source) => ({ url: source.url.trim(), label: source.label.trim() }))
		.filter((source) => source.url);
	if (!sources.length) throw new Error("enter a feed address");
	const loaded = await feeds(sources.map((source) => source.url));
	const merged = loaded.flatMap((data, i) => {
		const label = sources[i]!.label;
		return (data?.items ?? []).map((item) => (label ? { ...item, source: label } : item));
	});
	// A single feed keeps its own order, which is not always by date.
	const items = filterFeed(sources.length > 1 ? byDate(merged) : merged, el);
	return { title: loaded.find((data) => data)?.title ?? "", items: items.slice(0, el.count) };
}
