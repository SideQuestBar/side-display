/**
 * End-to-end tests of the HTTP API, driven through `app.handle` (no socket),
 * with a fake Home Assistant for the integration parts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { app } from "../src/server/app";
import { setPassword } from "../src/server/auth";
import { config } from "../src/server/config";
import { alertText, statsOf, watts } from "../src/server/data/home";
import { parseFeed, parseIcalEvents } from "../src/server/data/sources";
import { byDate, filterFeed } from "../src/server/data/streams";
import { icalBirthdays } from "../src/server/data/time";
import { haStatus, onEntitiesChanged, startHa, stopHa } from "../src/server/ha/client";
import { messageValue, mqttStatus, onTopicsChanged, parseBrokerUrl, stopMqtt } from "../src/server/mqtt/client";
import { PacketReader, PacketType, packet, text } from "../src/server/mqtt/packets";
import { setSetting } from "../src/server/settings";
import { notifyEntities } from "../src/server/store";
import { entitiesOf, makeElement } from "../src/shared/layout";
import type { Display, ElementData, Layout, MediaItem, ViewPayload } from "../src/shared/types";
import { FAKE_TOKEN, type FakeHa, startFakeHa } from "./fake-ha";
import { type FakeMqtt, startFakeMqtt } from "./fake-mqtt";

const PASSWORD = "correct horse battery";
let cookie = "";

async function call(
	path: string,
	init: {
		method?: string;
		body?: unknown;
		form?: FormData;
		headers?: Record<string, string>;
		anonymous?: boolean;
	} = {},
) {
	const headers: Record<string, string> = { ...init.headers };
	if (cookie && !init.anonymous) headers.cookie = cookie;
	if (init.body !== undefined) headers["content-type"] = "application/json";
	return app.handle(
		new Request(`http://localhost${path}`, {
			method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
			headers,
			body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
		}),
	);
}
const json = async <T>(path: string, init?: Parameters<typeof call>[1]) =>
	(await call(path, init)).json() as Promise<T>;
const until = async (condition: () => boolean, ms = 3000) => {
	const deadline = Date.now() + ms;
	while (!condition() && Date.now() < deadline) await Bun.sleep(20);
	expect(condition()).toBe(true);
};

describe("authentication", () => {
	test("everything is locked until a password is set", async () => {
		expect(await json("/api/auth/status")).toMatchObject({ setup: true, authenticated: false });
		expect((await call("/api/layouts")).status).toBe(401);
		expect((await call("/api/settings")).status).toBe(401);
	});

	test("setup rejects weak passwords, then signs in", async () => {
		expect((await call("/api/auth/setup", { body: { password: "short" } })).status).toBe(422);
		const response = await call("/api/auth/setup", { body: { password: PASSWORD } });
		expect(response.status).toBe(200);
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");
		cookie = setCookie.split(";")[0]!;
		expect(await json("/api/auth/status")).toMatchObject({ setup: false, authenticated: true });
	});

	test("setup cannot be run twice", async () => {
		expect((await call("/api/auth/setup", { body: { password: "another password" }, anonymous: true })).status).toBe(
			409,
		);
	});

	test("login checks the password", async () => {
		expect((await call("/api/auth/login", { body: { password: "wrong" }, anonymous: true })).status).toBe(401);
		const ok = await call("/api/auth/login", { body: { password: PASSWORD }, anonymous: true });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("set-cookie")).toContain("sd_session=");
	});

	test("the whole admin API is closed to anonymous requests, known route or not", async () => {
		for (const path of ["/api/displays", "/api/media", "/api/ha/entities", "/api/not-a-route"]) {
			expect((await call(path, { anonymous: true })).status).toBe(401);
		}
		expect(
			(await call("/api/auth/password", { body: { current: PASSWORD, next: "whatever else" }, anonymous: true }))
				.status,
		).toBe(401);
		expect((await call("/api/preview/data", { body: { element: {} }, anonymous: true })).status).toBe(401);
	});

	test("a made-up session cookie is refused", async () => {
		expect((await call("/api/layouts", { anonymous: true, headers: { cookie: "sd_session=forged" } })).status).toBe(
			401,
		);
	});

	test("requests from another site are refused even with the cookie", async () => {
		const response = await call("/api/layouts", { body: {}, headers: { origin: "https://evil.example" } });
		expect(response.status).toBe(403);
		expect(
			(await call("/api/layouts", { body: { name: "Same origin" }, headers: { origin: "http://localhost" } })).status,
		).toBe(200);
	});

	test("logging out ends the session", async () => {
		const login = await call("/api/auth/login", { body: { password: PASSWORD }, anonymous: true });
		const other = login.headers.get("set-cookie")!.split(";")[0]!;
		expect((await call("/api/layouts", { anonymous: true, headers: { cookie: other } })).status).toBe(200);
		await call("/api/auth/logout", { method: "POST", anonymous: true, headers: { cookie: other } });
		expect((await call("/api/layouts", { anonymous: true, headers: { cookie: other } })).status).toBe(401);
	});
});

describe("Home Assistant ingress", () => {
	// The gate goes by the address a request comes from, so these run against a
	// listening server whose peer address is replaced by Supervisor's.
	const SUPERVISOR = "172.30.32.2";
	const ADMIN = "system-admin,system-users";
	const USER = "system-users";
	let origin = "";
	let peer: string | null = SUPERVISOR;

	async function ingress(
		path: string,
		init: { groups?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
	) {
		const headers: Record<string, string> = { "x-ingress-path": "/api/hassio_ingress/token", ...init.headers };
		if (init.groups) headers["x-remote-user-groups"] = init.groups;
		if (init.body !== undefined) headers["content-type"] = "application/json";
		return fetch(origin + path, {
			method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
			headers,
			body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
		});
	}
	const status = async (groups?: string) => (await ingress("/api/auth/status", { groups })).json();

	beforeAll(() => {
		config.trustIngress = true;
		app.listen({ hostname: "127.0.0.1", port: 0 });
		const server = app.server!;
		const requestIP = server.requestIP.bind(server);
		server.requestIP = (request) => {
			const real = requestIP(request);
			return real && peer ? { ...real, address: peer } : real;
		};
		origin = `http://127.0.0.1:${server.port}`;
	});
	afterAll(async () => {
		config.trustIngress = false;
		setSetting("auth.haAccess", "admins");
		await app.stop(true);
	});

	test("only administrators get in until the setting says otherwise", async () => {
		expect(await status(ADMIN)).toMatchObject({ authenticated: true, ingress: true, restricted: false, owner: true });
		expect((await ingress("/api/layouts", { groups: ADMIN })).status).toBe(200);

		expect(await status(USER)).toMatchObject({ authenticated: false, ingress: false, restricted: true, owner: false });
		expect((await ingress("/api/layouts", { groups: USER })).status).toBe(401);
		// A Supervisor that does not say which groups the user is in vouches for nobody.
		expect(await status()).toMatchObject({ authenticated: false, restricted: true });
		expect((await ingress("/api/layouts")).status).toBe(401);
		expect(
			(await ingress("/api/settings/access", { groups: USER, method: "PUT", body: { access: "everyone" } })).status,
		).toBe(401);
	});

	test("the same headers from any other address mean nothing", async () => {
		peer = null;
		try {
			expect(await status(ADMIN)).toMatchObject({
				authenticated: false,
				ingress: false,
				restricted: false,
				owner: false,
			});
			expect((await ingress("/api/layouts", { groups: ADMIN })).status).toBe(401);
		} finally {
			peer = SUPERVISOR;
		}
	});

	test("an administrator opens it to every user", async () => {
		expect(
			(await ingress("/api/settings/access", { groups: ADMIN, method: "PUT", body: { access: "nobody" } })).status,
		).toBe(422);
		const opened = await ingress("/api/settings/access", {
			groups: ADMIN,
			method: "PUT",
			body: { access: "everyone" },
		});
		expect(opened.status).toBe(200);
		expect(await json<{ access: string }>("/api/settings")).toMatchObject({ access: "everyone" });

		expect(await status(USER)).toMatchObject({ authenticated: true, ingress: true, restricted: false, owner: false });
		expect((await ingress("/api/layouts", { groups: USER })).status).toBe(200);
		expect((await ingress("/api/layouts", { groups: USER, body: { name: "By a member of staff" } })).status).toBe(200);
	});

	test("other users cannot change who gets in", async () => {
		const closing = await ingress("/api/settings/access", { groups: USER, method: "PUT", body: { access: "admins" } });
		expect(closing.status).toBe(403);
		const password = await ingress("/api/auth/password", {
			groups: USER,
			body: { current: "", next: "taken over by staff" },
		});
		expect(password.status).toBe(403);
		// Nor choose the first password, were there none yet.
		setSetting("auth.passwordHash", "");
		try {
			expect(
				(await ingress("/api/auth/setup", { groups: USER, body: { password: "taken over by staff" } })).status,
			).toBe(403);
			expect((await ingress("/api/auth/setup", { groups: ADMIN, body: { password: PASSWORD } })).status).toBe(200);
		} finally {
			await setPassword(PASSWORD);
		}
		expect(await json<{ access: string }>("/api/settings")).toMatchObject({ access: "everyone" });
	});

	test("someone signed in with the password can change it too", async () => {
		expect((await call("/api/settings/access", { method: "PUT", body: { access: "admins" } })).status).toBe(200);
		expect((await ingress("/api/layouts", { groups: USER })).status).toBe(401);
		expect((await ingress("/api/layouts", { groups: ADMIN })).status).toBe(200);
	});

	test("an administrator changes the password without knowing it", async () => {
		const changed = await ingress("/api/auth/password", { groups: ADMIN, body: { current: "", next: PASSWORD } });
		expect(changed.status).toBe(200);
		// That signed every browser out, the one these tests use included.
		const login = await call("/api/auth/login", { body: { password: PASSWORD }, anonymous: true });
		cookie = login.headers.get("set-cookie")!.split(";")[0]!;
		expect((await call("/api/layouts")).status).toBe(200);
	});
});

describe("layouts and displays", () => {
	let layout: Layout;
	let display: Display;

	test("a layout is stored normalised", async () => {
		layout = await json<Layout>("/api/layouts", {
			body: {
				name: "Lobby",
				settings: { padding: 9999, background: "#102030" },
				elements: [makeElement("text", { text: "Hi" }), { type: "bogus" }],
			},
		});
		expect(layout.name).toBe("Lobby");
		expect(layout.settings.padding).toBe(400);
		expect(layout.settings.textColor).toBe("#ffffff");
		expect(layout.elements.map((e) => e.type)).toEqual(["text"]);
	});

	test("update, duplicate, and 404s", async () => {
		const updated = await json<Layout>(`/api/layouts/${layout.id}`, {
			method: "PUT",
			body: {
				name: "Lobby 2",
				elements: [makeElement("clock"), makeElement("ha-entity", { entity: "sensor.living_room_temperature" })],
			},
		});
		expect(updated.name).toBe("Lobby 2");
		expect(updated.settings.background).toBe("#102030");
		layout = updated;
		const copy = await json<Layout>(`/api/layouts/${layout.id}/duplicate`, { method: "POST" });
		expect(copy.name).toBe("Lobby 2 (copy)");
		expect(copy.elements[0]!.id).not.toBe(layout.elements[0]!.id);
		expect((await call("/api/layouts/nope")).status).toBe(404);
		expect((await call("/api/layouts/nope", { method: "PUT", body: {} })).status).toBe(404);
	});

	test("import converts a sidequest-bar layout and rejects junk", async () => {
		const imported = await json<Layout>("/api/layouts/import", {
			body: {
				data: { name: "Old TV", settings: {}, elements: [{ id: "1", type: "message", text: { en: "Welcome" } }] },
				assetBase: "https://bar.example",
			},
		});
		expect(imported.elements[0]).toMatchObject({ type: "text", text: "Welcome" });
		expect((await call("/api/layouts/import", { body: { data: { hello: 1 } } })).status).toBe(422);
	});

	test("a display is public by id and only exposes its own layouts", async () => {
		display = await json<Display>("/api/displays", {
			body: {
				name: "Lobby TV",
				playlist: [
					{ layoutId: layout.id, seconds: 20 },
					{ layoutId: "missing", seconds: 20 },
				],
				settings: { colorMode: "mono", rotation: 45 },
			},
		});
		expect(display.settings).toMatchObject({ colorMode: "mono", rotation: 0 });
		const view = await json<ViewPayload>(`/api/view/${display.id}`, { anonymous: true });
		expect(view.display.name).toBe("Lobby TV");
		expect(view.entries).toHaveLength(1);
		expect(view.entries[0]!.layout.id).toBe(layout.id);
		expect(JSON.stringify(view)).not.toContain("passwordHash");
		expect((await call("/api/view/unknown", { anonymous: true })).status).toBe(404);
	});

	test("a display also answers to its slug, which no other display may take", async () => {
		const saved = await json<Display>(`/api/displays/${display.id}`, { method: "PUT", body: { slug: " Lobby TV! " } });
		expect(saved.slug).toBe("lobby-tv");
		for (const key of ["lobby-tv", "Lobby-TV", display.id]) {
			const view = await json<ViewPayload>(`/api/view/${key}`, { anonymous: true });
			expect(view.display.id).toBe(display.id);
		}
		const clock = layout.elements.find((e) => e.type === "clock")!;
		expect((await call(`/api/view/lobby-tv/data/${clock.id}`, { anonymous: true })).status).toBe(200);

		// Saving something else leaves the slug alone; saving the same slug again is not a conflict.
		expect(
			(await json<Display>(`/api/displays/${display.id}`, { method: "PUT", body: { name: "Lobby TV" } })).slug,
		).toBe("lobby-tv");
		expect((await call(`/api/displays/${display.id}`, { method: "PUT", body: { slug: "lobby-tv" } })).status).toBe(200);

		const taken = await call("/api/displays", { body: { name: "Other", slug: "lobby tv" } });
		expect(taken.status).toBe(409);
		expect((await call("/api/displays", { body: { name: "Other", slug: display.id } })).status).toBe(409);
		const other = await json<Display>("/api/displays", { body: { name: "Other" } });
		expect(other.slug).toBe("");

		// Without its slug the display is back to its id alone, and the name is free again.
		await call(`/api/displays/${display.id}`, { method: "PUT", body: { slug: "" } });
		expect((await call("/api/view/lobby-tv", { anonymous: true })).status).toBe(404);
		expect((await call(`/api/displays/${other.id}`, { method: "PUT", body: { slug: "lobby-tv" } })).status).toBe(200);
		expect((await json<ViewPayload>("/api/view/lobby-tv", { anonymous: true })).display.id).toBe(other.id);
		await call(`/api/displays/${other.id}`, { method: "DELETE" });
	});

	test("element data is only served for elements on the display", async () => {
		const clock = layout.elements[0]!;
		expect(await json<ElementData>(`/api/view/${display.id}/data/${clock.id}`, { anonymous: true })).toEqual({
			show: true,
			data: null,
		});
		expect((await call(`/api/view/${display.id}/data/not-on-this-display`, { anonymous: true })).status).toBe(404);
	});

	test("the live stream greets, then relays updates", async () => {
		const controller = new AbortController();
		const response = await app.handle(
			new Request(`http://localhost/api/view/${display.id}/stream`, { signal: controller.signal }),
		);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const readUntil = async (needle: string) => {
			const deadline = Date.now() + 3000;
			while (!text.includes(needle) && Date.now() < deadline) text += decoder.decode((await reader.read()).value);
			expect(text).toContain(needle);
		};
		await readUntil("event: connected");
		expect((await json<Display[]>("/api/displays")).find((d) => d.id === display.id)?.online).toBe(1);
		await call(`/api/layouts/${layout.id}`, { method: "PUT", body: { name: "Lobby 3" } });
		await readUntil("event: update");
		await call(`/api/displays/${display.id}/identify`, { method: "POST" });
		await readUntil("event: identify");
		controller.abort();
		await reader.cancel().catch(() => {});
		await until(() => true);
	});

	test("archiving and filing keep everything in place, and stay out of what screens receive", async () => {
		const put = <T>(path: string, body: unknown) => json<T>(path, { method: "PUT", body });
		const filed = await put<Layout>(`/api/layouts/${layout.id}`, { folder: "  Bar  ", archived: true });
		expect(filed).toMatchObject({ folder: "Bar", name: "Lobby 3" });
		expect(filed.archivedAt).toBeNumber();
		expect(filed.elements).toHaveLength(layout.elements.length);
		// Archiving again does not move the date, and a content save does not restore.
		const again = await put<Layout>(`/api/layouts/${layout.id}`, { archived: true, name: "Lobby 3" });
		expect(again.archivedAt).toBe(filed.archivedAt);
		const copy = await json<Layout>(`/api/layouts/${layout.id}/duplicate`, { method: "POST" });
		expect(copy).toMatchObject({ folder: "Bar", archivedAt: null });
		await call(`/api/layouts/${copy.id}`, { method: "DELETE" });

		const stored = await put<Display>(`/api/displays/${display.id}`, { archived: true });
		expect(stored.archivedAt).toBeNumber();
		expect(stored.playlist).toHaveLength(2);
		// Still listed, still served, and the screen learns nothing about the filing.
		expect((await json<Display[]>("/api/displays")).some((d) => d.id === display.id)).toBe(true);
		const view = await json<ViewPayload>(`/api/view/${display.id}`, { anonymous: true });
		expect(view.entries[0]!.layout).toMatchObject({ id: layout.id, folder: "", archivedAt: null });

		expect((await put<Layout>(`/api/layouts/${layout.id}`, { archived: false, folder: "" })).archivedAt).toBeNull();
		expect((await put<Display>(`/api/displays/${display.id}`, { archived: false })).archivedAt).toBeNull();
	});

	test("a folder exists without layouts, and renaming or deleting it keeps the layouts", async () => {
		expect(await json<{ name: string }>("/api/folders", { body: { name: "  Seasonal " } })).toEqual({
			name: "Seasonal",
		});
		expect((await call("/api/folders", { body: { name: "   " } })).status).toBe(422);
		expect(await json<string[]>("/api/folders")).toContain("Seasonal");
		// Filing a layout under a new name creates that folder, which outlives the layout leaving it.
		const put = (folder: string) => json<Layout>(`/api/layouts/${layout.id}`, { method: "PUT", body: { folder } });
		const before = await put("Bar");
		await put("Seasonal");
		expect(await json<string[]>("/api/folders")).toEqual(expect.arrayContaining(["Bar", "Seasonal"]));

		await call("/api/folders/rename", { body: { from: "Seasonal", to: "Winter" } });
		const renamed = await json<Layout>(`/api/layouts/${layout.id}`);
		expect(renamed.folder).toBe("Winter");
		expect(renamed.updatedAt).toBeGreaterThanOrEqual(before.updatedAt);
		expect(await json<string[]>("/api/folders")).not.toContain("Seasonal");

		await call("/api/folders/delete", { body: { name: "Winter" } });
		await call("/api/folders/delete", { body: { name: "Bar" } });
		expect((await json<Layout>(`/api/layouts/${layout.id}`)).folder).toBe("");
		expect(await json<string[]>("/api/folders")).toEqual([]);
	});

	test("deleting a layout removes it from playlists", async () => {
		expect((await call(`/api/layouts/${layout.id}`, { method: "DELETE" })).status).toBe(200);
		const after = await json<Display>(`/api/displays/${display.id}`);
		expect(after.playlist).toEqual([{ layoutId: "missing", seconds: 20, days: [], from: "", to: "" }]);
		expect((await json<ViewPayload>(`/api/view/${display.id}`, { anonymous: true })).entries).toEqual([]);
		expect((await call(`/api/displays/${display.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await call(`/api/view/${display.id}`, { anonymous: true })).status).toBe(404);
	});
});

describe("media", () => {
	// A real 2×1 PNG.
	const png = Uint8Array.fromBase64(
		"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4GBgYEBAA4JAQPbK1VRAAAAAElFTkSuQmCC",
	);
	let item: MediaItem;

	test("uploads are checked and described", async () => {
		const form = new FormData();
		form.append("files", new File([png], "dot.png", { type: "image/png" }));
		form.append("files", new File(["not an image"], "fake.png", { type: "image/png" }));
		form.append("files", new File(["#!/bin/sh"], "script.sh", { type: "text/x-sh" }));
		form.append("album", "Test");
		const result = await json<{ saved: MediaItem[]; errors: string[] }>("/api/media", { form });
		expect(result.saved).toHaveLength(1);
		expect(result.errors).toHaveLength(2);
		item = result.saved[0]!;
		expect(item).toMatchObject({ name: "dot", kind: "image", mime: "image/png", width: 2, height: 1, album: "Test" });
		expect((await call("/api/media", { form: new FormData(), anonymous: true })).status).toBe(401);
	});

	test("files are served publicly, with ranges, without path tricks", async () => {
		const whole = await call(`/media/${item.file}`, { anonymous: true });
		expect(whole.status).toBe(200);
		expect(whole.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await whole.arrayBuffer())).toEqual(png);
		const part = await call(`/media/${item.file}`, { anonymous: true, headers: { range: "bytes=0-3" } });
		expect(part.status).toBe(206);
		expect(part.headers.get("content-range")).toBe(`bytes 0-3/${png.length}`);
		expect(new Uint8Array(await part.arrayBuffer())).toEqual(png.slice(0, 4));
		expect((await call("/media/..%2Fsidedisplay.db", { anonymous: true })).status).toBe(404);
		expect((await call(`/media/${item.file}?w=32`, { anonymous: true })).headers.get("content-type")).toBe(
			"image/webp",
		);
	});

	test("albums feed galleries; deleting removes the file", async () => {
		const data = await json<ElementData<{ items: { src: string }[] }>>("/api/preview/data", {
			body: { element: makeElement("gallery", { album: "Test" }) },
		});
		// A PNG has no capture date: the upload date stands in, in the same shape.
		expect(data.data?.items).toEqual([
			{
				src: `media/${item.file}`,
				name: "dot",
				date: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/),
				width: 2,
				height: 1,
			},
		] as never);
		expect((await json<MediaItem>(`/api/media/${item.id}`, { method: "PATCH", body: { album: "Other" } })).album).toBe(
			"Other",
		);
		// Several files change album in one request; ids that do not exist are passed over.
		expect(
			await json<{ moved: number }>("/api/media", {
				method: "PATCH",
				body: { ids: [item.id, "nope"], album: " Trip " },
			}),
		).toEqual({ moved: 1 });
		expect((await json<MediaItem[]>("/api/media")).find((m) => m.id === item.id)?.album).toBe("Trip");
		expect((await call(`/api/media/${item.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await call(`/media/${item.file}`, { anonymous: true })).status).toBe(404);
	});
});

describe("settings", () => {
	test("the setup guide is offered until the region is saved", async () => {
		expect((await call("/api/onboarding", { anonymous: true })).status).toBe(401);
		expect(await json("/api/onboarding")).toMatchObject({ needed: true, suggested: {} });
		expect(await json("/api/places?q=x")).toEqual([]);
	});

	test("general settings validate and persist", async () => {
		const body = {
			locale: "hu-HU",
			timezone: "Europe/Budapest",
			hourCycle: "24",
			temperatureUnit: "c",
			locationName: "Budapest",
			latitude: 47.5,
			longitude: 19.04,
		};
		expect((await call("/api/settings/general", { method: "PUT", body })).status).toBe(200);
		expect(
			(await call("/api/settings/general", { method: "PUT", body: { ...body, timezone: "Mars/Olympus" } })).status,
		).toBe(422);
		expect((await json<{ general: typeof body }>("/api/settings")).general).toEqual(body);
		expect(await json("/api/onboarding")).toMatchObject({ needed: false, general: body });
	});

	test("the Home Assistant token is never sent back", async () => {
		await call("/api/settings/ha", { method: "PUT", body: { url: "http://127.0.0.1:9", token: "super-secret" } });
		const text = await (await call("/api/settings")).text();
		expect(text).not.toContain("super-secret");
		expect(JSON.parse(text).ha).toMatchObject({ url: "http://127.0.0.1:9", hasToken: true });
		await call("/api/settings/ha", { method: "PUT", body: { url: "" } });
		stopHa();
	});

	test("changing the password needs the current one", async () => {
		expect((await call("/api/auth/password", { body: { current: "wrong", next: "a new password" } })).status).toBe(401);
		const response = await call("/api/auth/password", { body: { current: PASSWORD, next: "a new password" } });
		expect(response.status).toBe(200);
		// The old session is gone; the response carries the new one.
		expect((await call("/api/layouts")).status).toBe(401);
		cookie = response.headers.get("set-cookie")!.split(";")[0]!;
		expect((await call("/api/layouts")).status).toBe(200);
	});
});

describe("feeds", () => {
	test("RSS and Atom parse to the same shape", () => {
		const rss = parseFeed(
			`<rss><channel><title>News</title><item><title>One &amp; two</title><link>https://e.com/1</link><description><![CDATA[<p>Hello <b>there</b></p>]]></description></item></channel></rss>`,
		);
		expect(rss).toEqual({
			title: "News",
			items: [{ title: "One & two", link: "https://e.com/1", date: "", summary: "Hello there" }],
		});
		const atom = parseFeed(
			`<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title><entry><title>Post</title><link href="https://e.com/p"/><updated>2026-01-01T00:00:00Z</updated><summary>Text</summary></entry></feed>`,
		);
		expect(atom.items[0]).toMatchObject({ title: "Post", link: "https://e.com/p", summary: "Text" });
		expect(() => parseFeed("<html></html>")).toThrow();
	});

	test("an item's picture is found wherever the feed keeps it", () => {
		const item = (inner: string) => `<item><title>T</title><link>https://e.com/1</link>${inner}</item>`;
		const rss = parseFeed(
			`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>News</title>${[
				`<media:thumbnail url="https://e.com/thumb.jpg" width="240"/><enclosure url="https://e.com/other.jpg" type="image/jpeg"/>`,
				`<media:content url="https://e.com/small.jpg" width="140"/><media:content url="https://e.com/large.jpg?w=700&amp;q=1" width="700"/>`,
				`<media:content url="https://e.com/clip.mp4" medium="video"><media:thumbnail url="https://e.com/still.jpg"/></media:content>`,
				`<enclosure url="https://e.com/episode.mp3" type="audio/mpeg"/><enclosure url="https://e.com/cover.png" type="image/png"/>`,
				`<description><![CDATA[<p>Hello <img alt="x" src="//e.com/inline.jpg?a=1&amp;b=2"> there</p>]]></description>`,
				`<description>Nothing to see, and <![CDATA[<img src="javascript:alert(1)">]]></description>`,
			]
				.map(item)
				.join("")}</channel></rss>`,
		);
		expect(rss.items.map((i) => i.image)).toEqual([
			"https://e.com/thumb.jpg",
			"https://e.com/large.jpg?w=700&q=1",
			"https://e.com/still.jpg",
			"https://e.com/cover.png",
			"https://e.com/inline.jpg?a=1&b=2",
			undefined,
		]);
		expect(rss.items[4]?.summary).toBe("Hello there");
		const atom = parseFeed(
			`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/"><title>Blog</title>
			<entry><title>A</title><link href="https://e.com/a"/><link rel="enclosure" type="image/webp" href="https://e.com/a.webp"/></entry>
			<entry><title>B</title><link href="https://e.com/b"/><media:group><media:thumbnail url="https://e.com/b.jpg"/></media:group></entry>
			<entry><title>C</title><link href="https://e.com/c"/><content type="html">&lt;img src='https://e.com/c.jpg'&gt; Text</content></entry></feed>`,
		);
		expect(atom.items.map((i) => [i.link, i.image])).toEqual([
			["https://e.com/a", "https://e.com/a.webp"],
			["https://e.com/b", "https://e.com/b.jpg"],
			["https://e.com/c", "https://e.com/c.jpg"],
		]);
	});

	test("the news feed filters by keyword and age, and merges newest first", () => {
		const now = Date.parse("2026-05-10T12:00:00Z");
		const at = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
		const items = [
			{ title: "Election results", link: "", date: at(1), summary: "" },
			{ title: "Cup final", link: "", date: at(2), summary: "A night of SPORT" },
			{ title: "Weather", link: "", date: at(30), summary: "Rain after the election" },
			{ title: "Undated", link: "", date: "", summary: "" },
		];
		const titles = (options: Partial<Parameters<typeof filterFeed>[1]>) =>
			filterFeed(items, { include: "", exclude: "", maxAge: 0, ...options }, now).map((i) => i.title);
		expect(titles({})).toHaveLength(4);
		expect(titles({ include: " ELECTION , cup" })).toEqual(["Election results", "Cup final", "Weather"]);
		expect(titles({ exclude: "sport,, " })).toEqual(["Election results", "Weather", "Undated"]);
		expect(titles({ include: "election", maxAge: 24 })).toEqual(["Election results"]);
		expect(byDate([items[3]!, items[2]!, items[0]!, items[1]!]).map((i) => i.title)).toEqual([
			"Election results",
			"Cup final",
			"Weather",
			"Undated",
		]);
	});
});

describe("Home Assistant", () => {
	let home: FakeHa;
	const preview = <T>(element: unknown) => json<ElementData<T>>("/api/preview/data", { body: { element } });
	const changes: string[] = [];

	beforeAll(async () => {
		home = startFakeHa();
		setSetting("ha", { url: home.url, token: FAKE_TOKEN });
		onEntitiesChanged((ids) => {
			changes.push(...ids);
			notifyEntities(ids);
		});
		startHa();
		await until(() => haStatus().connected && haStatus().entities > 0);
	});
	afterAll(async () => {
		stopHa();
		await home.stop();
	});

	test("connects and lists entities for the pickers", async () => {
		expect(haStatus()).toMatchObject({ source: "settings", connected: true, version: "2026.11.0" });
		const { entities } = await json<{ entities: { entity_id: string; name: string }[] }>("/api/ha/entities");
		expect(entities.find((e) => e.entity_id === "sensor.living_room_temperature")?.name).toBe("Living room");
	});

	test("the setup guide is pre-filled from Home Assistant", async () => {
		expect((await json<{ suggested: unknown }>("/api/onboarding")).suggested).toEqual({
			locale: "en-HU",
			timezone: "Europe/Budapest",
			temperatureUnit: "c",
			latitude: 47.4979,
			longitude: 19.0402,
			locationName: "Demo home",
		});
	});

	test("the connection test reports a bad token", async () => {
		expect(await json("/api/ha/test", { body: { url: home.url, token: FAKE_TOKEN } })).toMatchObject({ ok: true });
		expect(await json("/api/ha/test", { body: { url: home.url, token: "wrong" } })).toMatchObject({ ok: false });
	});

	test("entity elements resolve their state", async () => {
		const data = await preview<{ state: { state: string; unit: string } }>(
			makeElement("ha-entity", { entity: "sensor.living_room_temperature" }),
		);
		expect(data.data?.state).toMatchObject({ state: "21.4", unit: "°C", name: "Living room" });
		expect(
			(await preview<{ state: unknown }>(makeElement("ha-entity", { entity: "sensor.nope" }))).data?.state,
		).toBeNull();
	});

	test("state changes arrive live", async () => {
		changes.length = 0;
		home.setState("sensor.living_room_temperature", "23.0");
		await until(() => changes.includes("sensor.living_room_temperature"));
		const data = await preview<{ state: { state: string } }>(
			makeElement("ha-entity", { entity: "sensor.living_room_temperature" }),
		);
		expect(data.data?.state.state).toBe("23.0");
	});

	test("visibility conditions follow entity states", async () => {
		const el = (state: string) => makeElement("text", { showEntity: "binary_sensor.front_door", showState: state });
		expect((await preview(el("on, open"))).show).toBe(false);
		expect((await preview(el("off"))).show).toBe(true);
		const not = makeElement("text", { showEntity: "binary_sensor.front_door", showState: "off", showNot: true });
		expect((await preview(not)).show).toBe(false);
	});

	test("visibility conditions compare numeric states", async () => {
		home.setState("sensor.living_room_temperature", "23.0");
		await until(() => changes.includes("sensor.living_room_temperature"));
		const el = (bounds: Record<string, unknown>) =>
			makeElement("text", { showEntity: "sensor.living_room_temperature", ...bounds });
		expect((await preview(el({ showAbove: "20" }))).show).toBe(true);
		expect((await preview(el({ showAbove: "23" }))).show).toBe(false);
		expect((await preview(el({ showAbove: "20", showBelow: "22" }))).show).toBe(false);
		expect((await preview(el({ showBelow: "25", showNot: true }))).show).toBe(false);
		// A state that is not a number is neither above nor below anything.
		expect((await preview(makeElement("text", { showEntity: "binary_sensor.front_door", showBelow: "5" }))).show).toBe(
			false,
		);
	});

	test("weather, history, to-do, template and map trackers resolve", async () => {
		const weather = await preview<{ current: { temperature: number; condition: string }; days: unknown[] }>(
			makeElement("weather", { source: "ha", entity: "weather.home" }),
		);
		expect(weather.data?.current).toMatchObject({ temperature: 8, condition: "partly" });
		expect(weather.data?.days).toHaveLength(7);
		const graph = await preview<{ points: [number, number][] }>(
			makeElement("ha-graph", { entity: "sensor.outdoor_temperature", hours: 6 }),
		);
		expect(graph.data?.points.length).toBeGreaterThan(10);
		const todo = await preview<{ items: { summary: string; done: boolean }[] }>(
			makeElement("ha-todo", { entity: "todo.shopping_list" }),
		);
		expect(todo.data?.items).toHaveLength(5);
		expect(todo.data?.items.at(-1)).toMatchObject({ summary: "Bread", done: true });
		const template = await preview<{ text: string }>(
			makeElement("ha-template", { template: "Door: {{ states('binary_sensor.front_door') }}" }),
		);
		expect(template.data?.text).toBe("Door: off");
		const map = await preview<{ trackers: { label: string; latitude: number }[] }>(
			makeElement("map", {
				trackers: [
					{ entity: "person.alex", label: "", color: "" },
					{ entity: "sensor.power_consumption", label: "", color: "" },
				],
			}),
		);
		expect(map.data?.trackers).toEqual([
			{ entity: "person.alex", label: "Alex", color: "", latitude: 47.4979, longitude: 19.0402 },
		] as never);
	});

	test("calendars merge iCal feeds (recurring and all-day events) with Home Assistant", async () => {
		const element = makeElement("calendar", {
			sources: [
				{ kind: "ical", url: `${home.url}/calendar.ics`, entity: "", name: "Venue", color: "#f00" },
				{ kind: "ha", url: "", entity: "calendar.family", name: "Family", color: "#0f0" },
				{ kind: "ical", url: `${home.url}/missing.ics`, entity: "", name: "Broken", color: "#00f" },
			],
		});
		const { data } = await preview<{
			events: { title: string; allDay: boolean; start: string; calendar: string }[];
			errors: string[];
		}>(element);
		const titles = data!.events.map((e) => e.title);
		expect(titles).toContain("Quiz night");
		expect(titles).toContain("Dentist");
		// The weekly event is expanded into its occurrences around today.
		expect(titles.filter((t) => t === "Happy hour").length).toBeGreaterThan(5);
		expect(data!.events.find((e) => e.title === "Closed for a private event")).toMatchObject({
			allDay: true,
			calendar: "Venue",
		});
		expect(data!.events.find((e) => e.title === "School holiday")?.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(data!.errors).toHaveLength(1);
		expect(data!.errors[0]).toContain("Broken");
		expect([...titles]).toEqual(data!.events.map((e) => e.title));
	});

	test("feeds and camera pictures are fetched server-side", async () => {
		const feed = await preview<{ items: { title: string; date: string }[] }>(
			makeElement("rss", { url: `${home.url}/feed.xml`, count: 2 }),
		);
		expect(feed.data?.items).toHaveLength(2);
		expect(feed.data?.items[0]?.title).toBe("New tram line opens next month");
		expect(feed.data?.items[1]?.title).toBe("Farmers' market moves to Saturdays");
		expect(feed.data?.items[0]?.date).toMatch(/^\d{4}-/);
		const picture = await call("/api/preview/picture", {
			body: { element: makeElement("ha-camera", { entity: "camera.front_door" }) },
		});
		expect(picture.status).toBe(200);
		expect(picture.headers.get("content-type")).toBe("image/svg+xml");
		expect(
			(await call("/api/preview/picture", { body: { element: makeElement("ha-camera", { entity: "" }) } })).status,
		).toBe(404);
	});

	test("trends and day ranges are read from the history", async () => {
		const now = Date.UTC(2026, 0, 10, 12);
		const at = (minutes: number) => now - minutes * 60_000;
		const points: [number, number][] = [
			[at(900), 30],
			[at(120), 18],
			[at(50), 21],
			[at(10), 19],
		];
		// An hour ago the value was the one set 120 minutes ago; the day (started 12 h ago) spans 18 to 22.
		expect(statsOf(points, now, at(720), 60, 22)).toEqual({ past: 18, min: 18, max: 22 });
		expect(statsOf(points, now, at(720), 0, null)).toEqual({ past: null, min: 18, max: 21 });
		expect(statsOf([], now, at(720), 60, 5)).toEqual({ past: null, min: 5, max: 5 });
		const entity = await preview<{ stats?: { past: number | null; min: number | null; max: number | null } }>(
			makeElement("ha-entity", { entity: "sensor.outdoor_temperature", trend: 60, dayRange: true }),
		);
		expect(entity.data?.stats?.past).toBeNumber();
		expect(entity.data?.stats?.min).toBeLessThanOrEqual(7.8);
		expect(entity.data?.stats?.max).toBeGreaterThanOrEqual(7.8);
		// Not asked for, not fetched.
		expect(
			(await preview<{ stats?: unknown }>(makeElement("ha-gauge", { entity: "sensor.outdoor_temperature" }))).data,
		).not.toHaveProperty("stats");
		const graph = await preview<{ series?: { label: string; points: unknown[] }[] }>(
			makeElement("ha-graph", {
				entity: "sensor.outdoor_temperature",
				hours: 6,
				entities: [{ entity: "sensor.living_room_temperature", label: "", color: "" }],
			}),
		);
		expect(graph.data?.series?.[0]?.label).toBe("Living room");
		expect(graph.data?.series?.[0]?.points.length).toBeGreaterThan(10);
	});

	test("the energy card reads every role in watts and works out the home", async () => {
		const state = (value: string, unit: string) => ({ state: value, unit }) as never;
		expect(watts(state("1.84", "kW"))).toBe(1840);
		expect(watts(state("412", "W"))).toBe(412);
		expect(watts(state("unavailable", "W"))).toBeNull();
		const energy = await preview<Record<string, unknown>>(
			makeElement("ha-energy", {
				solarEntity: "sensor.solar_production",
				gridEntity: "sensor.grid_power",
				batteryEntity: "sensor.battery_power",
				levelEntity: "sensor.battery_level",
				solarTodayEntity: "sensor.solar_energy_today",
				invertBattery: true,
			}),
		);
		// 1840 W of sun, 620 W sold, 810 W out of the battery (its sensor counts the other way).
		expect(energy.data).toEqual({
			solar: 1840,
			grid: -620,
			battery: 810,
			home: 2030,
			level: 78,
			totals: [{ key: "solar", value: 12.4, unit: "kWh" }],
		});
		expect(entitiesOf(makeElement("ha-energy", { gridEntity: "sensor.grid_power", homeEntity: "sensor.x" }))).toEqual([
			"sensor.grid_power",
			"sensor.x",
		]);
	});

	test("alerts list only what is wrong", async () => {
		const state = (entity_id: string, value: string, device_class = "", unit = "") =>
			({ entity_id, state: value, device_class, unit }) as never;
		expect(alertText(state("binary_sensor.window", "on", "window"))).toBe("Open");
		expect(alertText(state("binary_sensor.window", "off", "window"))).toBeNull();
		expect(alertText(state("binary_sensor.motion", "on", "motion"))).toBeNull();
		expect(alertText(state("binary_sensor.motion", "on", "motion"), { states: "on" })).toBe("On");
		expect(alertText(state("sensor.any", "unavailable"))).toBe("Unavailable");
		expect(alertText(state("sensor.battery", "12", "battery", "%"))).toBe("12 %");
		expect(alertText(state("sensor.battery", "12", "battery", "%"), { below: "10" })).toBeNull();
		expect(alertText(state("sensor.fridge", "9.5", "temperature", "°C"), { above: 8 })).toBe("9.5 °C");
		expect(alertText(state("lock.door", "unlocked"), { states: "unlocked, jammed" })).toBe("Unlocked");
		expect(alertText(null)).toBeNull();
		const row = (entity: string, severity = "warning") => ({
			entity,
			label: "",
			states: "",
			below: "",
			above: "",
			severity,
		});
		const alerts = await preview<{ alerts: { entity: string; label: string; text: string; severity: string }[] }>(
			makeElement("ha-alerts", {
				entities: [
					row("binary_sensor.front_door"),
					row("binary_sensor.kitchen_window"),
					row("sensor.remote_battery", "critical"),
				],
				batteryBelow: 70,
			}),
		);
		expect(alerts.data?.alerts).toEqual([
			{ entity: "sensor.remote_battery", label: "Remote battery", text: "12 %", severity: "critical" },
			{ entity: "binary_sensor.kitchen_window", label: "Kitchen window", text: "Open", severity: "warning" },
			{ entity: "sensor.door_sensor_battery", label: "Door sensor battery", text: "64 %", severity: "warning" },
		]);
	});

	test("presence serves the pictures of the people it lists, and no others", async () => {
		const element = makeElement("ha-presence", {
			entities: [
				{ entity: "person.alex", label: "" },
				{ entity: "person.sam", label: "Sam K." },
			],
		});
		const presence = await preview<{ people: unknown[] }>(element);
		expect(presence.data?.people).toEqual([
			{ entity: "person.alex", name: "Alex", state: "home", home: true, picture: true },
			{ entity: "person.sam", name: "Sam K.", state: "not_home", home: false, picture: false },
		]);
		const saved = await json<Layout>("/api/layouts", { body: { name: "People", elements: [element] } });
		const screen = await json<Display>("/api/displays", {
			body: { name: "Hall", playlist: [{ layoutId: saved.id, seconds: 20 }] },
		});
		const picture = (entity: string) =>
			call(`/api/view/${screen.id}/picture/${saved.elements[0]!.id}?entity=${entity}`, { anonymous: true });
		const alex = await picture("person.alex");
		expect(alex.status).toBe(200);
		expect(alex.headers.get("content-type")).toBe("image/svg+xml");
		// No picture, and not on the element: both are simply not there.
		expect((await picture("person.sam")).status).toBe(404);
		expect((await picture("media_player.living_room")).status).toBe(404);
		expect((await picture("camera.front_door")).status).toBe(404);
	});

	test("a camera stream is passed through until the viewer leaves", async () => {
		const stream = makeElement("ha-stream", { entity: "camera.front_door" });
		const camera = makeElement("ha-camera", { entity: "camera.front_door" });
		const saved = await json<Layout>("/api/layouts", { body: { name: "Cameras", elements: [stream, camera] } });
		const screen = await json<Display>("/api/displays", {
			body: { name: "Door", playlist: [{ layoutId: saved.id, seconds: 20 }] },
		});
		const live = (element: string, signal?: AbortSignal) =>
			app.handle(new Request(`http://localhost/api/view/${screen.id}/live/${element}`, { signal }));
		const controller = new AbortController();
		const response = await live(saved.elements[0]!.id, controller.signal);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("multipart/x-mixed-replace");
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value!.slice(0, 40))).toContain("--frameboundary");
		expect(home.streams()).toBe(1);
		controller.abort();
		await reader.cancel().catch(() => {});
		await until(() => home.streams() === 0);
		// Only stream elements stream, and only cameras that can.
		expect((await live(saved.elements[1]!.id)).status).toBe(404);
		expect((await live("nope")).status).toBe(404);
		expect((await call("/api/preview/live?entity=camera.garden")).status).toBe(404);
		expect((await call("/api/preview/live?entity=camera.front_door", { anonymous: true })).status).toBe(401);
		// The fallback: a plain snapshot through the picture route.
		expect(
			(await call(`/api/view/${screen.id}/picture/${saved.elements[0]!.id}`, { anonymous: true })).headers.get(
				"content-type",
			),
		).toBe("image/svg+xml");
	});

	test("errors are reported per element, not thrown", async () => {
		const data = await preview(makeElement("rss", { url: "ftp://example.com/feed" }));
		expect(data).toMatchObject({ show: true, data: null });
		expect(data.error).toContain("http");
	});
});

describe("MQTT", () => {
	let broker: FakeMqtt;
	const preview = <T>(element: unknown) => json<ElementData<T>>("/api/preview/data", { body: { element } });
	const value = async (props: Record<string, unknown>) =>
		(await preview<{ state: { state: string; name: string; unit: string } | null }>(makeElement("mqtt", props))).data
			?.state;
	const changes: string[] = [];

	beforeAll(async () => {
		broker = startFakeMqtt({ username: "screens", password: "s3cret pass", deny: ["private/topic"] });
		broker.publish("home/kitchen/temperature", "21.5", true);
		broker.publish("home/weather", JSON.stringify({ outside: { temperature: 7.5 }, tags: ["mild", "dry"] }), true);
		onTopicsChanged((keys) => {
			changes.push(...keys);
			notifyEntities(keys);
		});
	});
	afterAll(() => {
		stopMqtt();
		broker.stop();
	});

	test("packets survive any chunking, and oversized ones are skipped", () => {
		const small = packet(PacketType.PUBLISH, 0, text("a/b"), new TextEncoder().encode("hello"));
		const long = packet(PacketType.PUBLISH, 0, text("a/long"), new Uint8Array(300).fill(65));
		const huge = packet(PacketType.PUBLISH, 0, text("a/huge"), new Uint8Array(300_000));
		const stream = new Uint8Array([...small, ...long, ...huge, ...small]);
		for (const size of [1, 2, 7, 1000, stream.length]) {
			const reader = new PacketReader();
			const lengths: number[] = [];
			for (let i = 0; i < stream.length; i += size)
				for (const received of reader.push(stream.subarray(i, i + size))) lengths.push(received.body.length);
			expect(lengths).toEqual([small.length - 2, long.length - 3, small.length - 2]);
		}
	});

	test("broker addresses and values inside messages are read leniently", () => {
		expect(parseBrokerUrl("broker.local")).toMatchObject({ host: "broker.local", port: 1883, tls: false });
		expect(parseBrokerUrl("mqtts://u:p%40ss@broker.local")).toMatchObject({ port: 8883, tls: true, password: "p@ss" });
		expect(() => parseBrokerUrl("ws://broker.local:9001")).toThrow();
		expect(messageValue(" 21.5\n", "")).toBe("21.5");
		expect(messageValue('{"a":{"b":[1,{"c":true}]}}', "a.b[1].c")).toBe("true");
		expect(messageValue('{"a":{"b":[1,2]}}', "a.b.0")).toBe("1");
		expect(() => messageValue('{"a":1}', "b")).toThrow();
		expect(() => messageValue("not json", "a")).toThrow();
	});

	test("elements are told about their topics like entities", () => {
		expect(entitiesOf(makeElement("mqtt", { topic: " a/b " }))).toEqual(["mqtt:a/b"]);
		expect(entitiesOf(makeElement("mqtt-list", { topics: [{ topic: "x" }, { topic: "" }] }))).toEqual(["mqtt:x"]);
	});

	test("without a broker, elements say so", async () => {
		expect(mqttStatus()).toMatchObject({ source: "none", connected: false });
		expect((await preview(makeElement("mqtt", { topic: "a/b" }))).error).toContain("not set up");
	});

	test("the connection test checks address and credentials", async () => {
		const test = (body: unknown) => json<{ ok: boolean; message: string }>("/api/mqtt/test", { body });
		expect(await test({ url: broker.url, username: "screens", password: "s3cret pass" })).toMatchObject({ ok: true });
		const wrong = await test({ url: broker.url, username: "screens", password: "wrong" });
		expect(wrong.ok).toBe(false);
		expect(wrong.message).toContain("password");
		expect((await test({ url: "mqtt://127.0.0.1:9" })).ok).toBe(false);
		expect((await test({ url: "http://127.0.0.1" })).ok).toBe(false);
	});

	test("settings are validated, and the password is never sent back", async () => {
		expect((await call("/api/settings/mqtt", { method: "PUT", body: { url: "ws://broker:9001" } })).status).toBe(422);
		const body = { url: broker.url, username: "screens", password: "s3cret pass" };
		expect((await call("/api/settings/mqtt", { method: "PUT", body })).status).toBe(200);
		const text = await (await call("/api/settings")).text();
		expect(text).not.toContain("s3cret");
		expect(JSON.parse(text).mqtt).toMatchObject({ url: broker.url, username: "screens", hasPassword: true });
		await until(() => mqttStatus().connected);
		// Saving again without a password keeps the stored one.
		await call("/api/settings/mqtt", { method: "PUT", body: { url: broker.url, username: "screens" } });
		await until(() => mqttStatus().connected);
		expect(mqttStatus()).toMatchObject({ source: "settings", broker: `127.0.0.1:${broker.port}`, error: null });
	});

	test("a value element shows the retained message, or a part of it", async () => {
		expect(await value({ topic: "home/kitchen/temperature", unit: "°C" })).toMatchObject({
			state: "21.5",
			name: "temperature",
			unit: "°C",
		});
		expect((await value({ topic: "home/weather", path: "outside.temperature" }))?.state).toBe("7.5");
		expect((await value({ topic: "home/weather", path: "tags[1]" }))?.state).toBe("dry");
		expect(broker.subscriptions().sort()).toEqual(["home/kitchen/temperature", "home/weather"]);
	});

	test("problems are reported per element", async () => {
		expect(await value({ topic: "nothing/here/yet" })).toBeNull();
		expect((await preview(makeElement("mqtt", { topic: "home/weather", path: "inside" }))).error).toContain("inside");
		expect((await preview(makeElement("mqtt", { topic: "home/#" }))).error).toContain("wildcards");
		expect((await preview(makeElement("mqtt", { topic: "private/topic" }))).error).toContain("does not allow");
	});

	test("messages arrive live", async () => {
		changes.length = 0;
		broker.publish("home/kitchen/temperature", "22.0");
		await until(() => changes.includes("mqtt:home/kitchen/temperature"));
		expect((await value({ topic: "home/kitchen/temperature" }))?.state).toBe("22.0");
		// The topic nobody had published on is listened to as well.
		broker.publish("nothing/here/yet", "now there is");
		await until(() => changes.includes("mqtt:nothing/here/yet"));
	});

	test("a list shows several topics, skipping the ones it cannot read", async () => {
		const el = makeElement("mqtt-list", {
			topics: [
				{ topic: "home/kitchen/temperature", path: "", label: "Kitchen", unit: "°C" },
				{ topic: "private/topic", path: "", label: "", unit: "" },
				{ topic: "home/weather", path: "outside.temperature", label: "", unit: "" },
			],
		});
		const { data } = await preview<{ states: ({ state: string; unit: string } | null)[] }>(el);
		expect(data?.states.map((s) => s?.state ?? null)).toEqual(["22.0", null, "7.5"]);
	});

	test("after the broker restarts, topics are subscribed to again", async () => {
		broker.dropClients();
		await until(() => !mqttStatus().connected);
		expect((await value({ topic: "home/kitchen/temperature" }))?.state).toBe("22.0");
		await until(() => mqttStatus().connected, 6000);
		await until(() => broker.subscriptions().includes("home/kitchen/temperature"));
		changes.length = 0;
		broker.publish("home/kitchen/temperature", "19.0");
		await until(() => changes.includes("mqtt:home/kitchen/temperature"));
	}, 10_000);

	test("clearing the address stops the connection", async () => {
		await call("/api/settings/mqtt", { method: "PUT", body: { url: "" } });
		expect(mqttStatus()).toMatchObject({ source: "none", connected: false, topics: 0 });
	});
});

describe("calendars", () => {
	const event = (lines: string[]) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"];
	const feed = (...events: string[][]) =>
		["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...events.flat(), "END:VCALENDAR"].join("\r\n");
	const from = new Date("2026-01-01T00:00:00Z");
	const to = new Date("2026-03-01T00:00:00Z");

	test("cancelled and declined events can be left out, one occurrence at a time", () => {
		const text = feed(
			event(["UID:1", "SUMMARY:Quiz", "DTSTART:20260106T180000Z", "DTEND:20260106T200000Z"]),
			event(["UID:2", "SUMMARY:Gig", "STATUS:CANCELLED", "DTSTART:20260107T180000Z", "DTEND:20260107T200000Z"]),
			event([
				"UID:3",
				"SUMMARY:Meeting",
				"DTSTART:20260108T100000Z",
				"DTEND:20260108T110000Z",
				"ATTENDEE;PARTSTAT=DECLINED:mailto:Me@Example.com",
				"ATTENDEE;PARTSTAT=ACCEPTED:mailto:you@example.com",
			]),
			event([
				"UID:4",
				"SUMMARY:Weekly",
				"DTSTART:20260105T090000Z",
				"DTEND:20260105T100000Z",
				"RRULE:FREQ=WEEKLY;COUNT=3",
			]),
			event([
				"UID:4",
				"SUMMARY:Weekly",
				"STATUS:CANCELLED",
				"RECURRENCE-ID:20260112T090000Z",
				"DTSTART:20260112T090000Z",
				"DTEND:20260112T100000Z",
			]),
		);
		const titles = (options?: Parameters<typeof parseIcalEvents>[5]) =>
			parseIcalEvents(text, from, to, "", "", options)
				.sort((a, b) => a.start.localeCompare(b.start))
				.map((e) => `${e.title} ${e.start.slice(5, 10)}`);
		expect(titles()).toEqual([
			"Weekly 01-05",
			"Quiz 01-06",
			"Gig 01-07",
			"Meeting 01-08",
			"Weekly 01-12",
			"Weekly 01-19",
		]);
		expect(titles({ hideCancelled: true })).toEqual(["Weekly 01-05", "Quiz 01-06", "Meeting 01-08", "Weekly 01-19"]);
		expect(titles({ declinedBy: " me@example.com " })).not.toContain("Meeting 01-08");
		expect(titles({ declinedBy: "you@example.com" })).toContain("Meeting 01-08");
	});

	test("birthdays come from the start of a yearly series", () => {
		const text = feed(
			event(["UID:1", "SUMMARY:Ada", "DTSTART;VALUE=DATE:19920229", "RRULE:FREQ=YEARLY"]),
			// Address books write a placeholder year when they do not know it.
			event(["UID:2", "SUMMARY:Bob", "DTSTART;VALUE=DATE:16040301", "RRULE:FREQ=YEARLY"]),
			event(["UID:3", "SUMMARY:Party", "DTSTART;VALUE=DATE:20260120"]),
			event(["UID:4", "SUMMARY:Long ago", "DTSTART;VALUE=DATE:20200120"]),
			event(["UID:5", "SUMMARY:Standup", "DTSTART:20260105T090000Z", "RRULE:FREQ=WEEKLY"]),
		);
		expect(icalBirthdays(text, from, to)).toEqual([
			{ name: "Ada", date: "1992-02-29" },
			{ name: "Bob", date: "03-01" },
			{ name: "Party", date: "01-20" },
		]);
	});
});

describe("pages", () => {
	test("health is public", async () => {
		expect(await json("/api/health", { anonymous: true })).toMatchObject({ ok: true });
	});
});
