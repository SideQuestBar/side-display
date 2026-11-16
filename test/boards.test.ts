import { describe, expect, test } from "bun:test";
import { blueskyPost, mastodonPost, mastodonText } from "../src/server/data/boards";
import { inWindow, localStamp, menuPrice, menuSections, wifiPayload } from "../src/shared/boards";
import { zoned } from "../src/shared/time";

describe("announcement window", () => {
	test("the stamp is the wall-clock time of the instance's zone", () => {
		expect(localStamp(zoned(Date.UTC(2026, 0, 5, 23, 30), "Europe/Budapest"))).toBe("2026-01-06T00:30");
	});

	test("open ends, and the end itself is excluded", () => {
		expect(inWindow("2026-01-06T00:30", "", "")).toBe(true);
		expect(inWindow("2026-01-06T00:30", "2026-01-06T00:30", "")).toBe(true);
		expect(inWindow("2026-01-06T00:29", "2026-01-06T00:30", "")).toBe(false);
		expect(inWindow("2026-01-06T18:00", "", "2026-01-06T18:00")).toBe(false);
		expect(inWindow("2026-01-06T17:59", "2026-01-01T00:00", "2026-01-06T18:00")).toBe(true);
	});
});

describe("menu board", () => {
	const dish = (section: string, name: string, soldOut = false) => ({
		section,
		name,
		description: "",
		price: "",
		allergens: "",
		soldOut,
	});

	test("rows are grouped by section in order of appearance; an empty section continues the one above", () => {
		const sections = menuSections([dish("Mains", "a"), dish("", "b"), dish("Drinks", "c"), dish("Mains", "d")]);
		expect(sections.map((s) => [s.name, s.items.map((i) => i.name).join("")])).toEqual([
			["Mains", "abd"],
			["Drinks", "c"],
		]);
	});

	test("hidden sold-out dishes take their empty section with them", () => {
		const sections = menuSections([dish("Mains", "a", true), dish("Drinks", "c"), dish("", "d", true)], true);
		expect(sections.map((s) => s.name)).toEqual(["Drinks"]);
		expect(sections[0]!.items).toHaveLength(1);
	});

	test("the currency goes around numbers only", () => {
		expect(menuPrice("12.50", "", " €")).toBe("12.50 €");
		expect(menuPrice(" 9,5 ", "£", "")).toBe("£9,5");
		expect(menuPrice("Market price", "$", "")).toBe("Market price");
	});
});

describe("Wi-Fi code", () => {
	test("special characters are escaped", () => {
		expect(wifiPayload('Café; "Guests"', "p:a\\ss,word", "WPA")).toBe(
			'WIFI:T:WPA;S:Café\\; \\"Guests\\";P:p\\:a\\\\ss\\,word;;',
		);
	});

	test("open and hidden networks", () => {
		expect(wifiPayload("Open", "ignored", "nopass")).toBe("WIFI:T:nopass;S:Open;;");
		expect(wifiPayload("Open", "", "WPA")).toBe("WIFI:T:nopass;S:Open;;");
		expect(wifiPayload("Lab", "secret", "WEP", true)).toBe("WIFI:T:WEP;S:Lab;P:secret;H:true;;");
	});
});

describe("social wall", () => {
	const status = {
		created_at: "2026-11-16T11:05:27.567Z",
		content:
			'<p>Update on <a href="https://x.example/tags/Plush" class="mention hashtag" rel="tag">#<span>Plush</span></a> &amp; more<br>second line</p><p><a href="https://shop.example/products/a-very-long-path"><span class="invisible">https://</span><span class="ellipsis">shop.example/products</span><span class="invisible">/a-very-long-path</span></a></p><script>alert(1)</script>',
		sensitive: false,
		spoiler_text: "",
		visibility: "public",
		in_reply_to_id: null,
		reblog: null,
		account: { acct: "plush@x.example", display_name: "Plush &amp; Co", avatar_static: "https://x.example/a.png" },
		media_attachments: [
			{ type: "video", preview_url: "https://x.example/v.jpg", description: null },
			{ type: "image", preview_url: "https://x.example/small.jpg", description: "a plush" },
		],
	};

	test("Mastodon HTML becomes plain text, with links shortened as the site shows them", () => {
		expect(mastodonText(status.content)).toBe("Update on #Plush & more second line shop.example/products… alert(1)");
	});

	test("a Mastodon post keeps its author, its first picture and nothing unsafe", () => {
		expect(mastodonPost(status, true, true)).toEqual({
			author: "Plush & Co",
			handle: "@plush@x.example",
			avatar: "https://x.example/a.png",
			text: "Update on #Plush & more second line shop.example/products… alert(1)",
			date: "2026-11-16T11:05:27.567Z",
			image: "https://x.example/small.jpg",
			boostedBy: "",
		});
	});

	test("content warnings, replies and boosts are left out", () => {
		expect(mastodonPost({ ...status, sensitive: true }, true, true)).toBeNull();
		expect(mastodonPost({ ...status, spoiler_text: "cw" }, true, true)).toBeNull();
		expect(mastodonPost({ ...status, in_reply_to_id: "1" }, true, true)).toBeNull();
		expect(mastodonPost({ ...status, in_reply_to_id: "1" }, false, true)).not.toBeNull();
		const boost = { ...status, content: "", account: { ...status.account, display_name: "Booster" }, reblog: status };
		expect(mastodonPost(boost, true, true)).toBeNull();
		expect(mastodonPost(boost, true, false)).toMatchObject({ author: "Plush & Co", boostedBy: "Booster" });
		expect(mastodonPost({ ...boost, reblog: { ...status, sensitive: true } }, true, false)).toBeNull();
	});

	test("Bluesky posts: reposts, replies, labels and pictures", () => {
		const item = {
			post: {
				author: { handle: "sky.example", displayName: "Sky", avatar: "https://cdn.example/a" },
				record: { text: "Hello\n\nworld", createdAt: "2026-11-13T22:03:20.663Z" },
				embed: { images: [{ thumb: "https://cdn.example/t" }] },
				labels: [],
				indexedAt: "2026-11-13T22:03:21.000Z",
			},
		};
		expect(blueskyPost(item, true, true)).toEqual({
			author: "Sky",
			handle: "@sky.example",
			avatar: "https://cdn.example/a",
			text: "Hello world",
			date: "2026-11-13T22:03:20.663Z",
			image: "https://cdn.example/t",
			boostedBy: "",
		});
		expect(blueskyPost({ ...item, reply: {} }, true, true)).toBeNull();
		expect(blueskyPost({ ...item, post: { ...item.post, labels: [{ val: "porn" }] } }, true, true)).toBeNull();
		const repost = { ...item, reason: { $type: "app.bsky.feed.defs#reasonRepost", by: { handle: "other.example" } } };
		expect(blueskyPost(repost, true, true)).toBeNull();
		expect(blueskyPost(repost, true, false)).toMatchObject({ boostedBy: "other.example" });
		const quoted = {
			...item,
			post: { ...item.post, embed: { media: { images: [{ thumb: "https://cdn.example/q" }] } } },
		};
		expect(blueskyPost(quoted, true, true)?.image).toBe("https://cdn.example/q");
	});
});
