/**
 * The admin API. Every route here requires the admin session, which the
 * gate in `app.ts` enforces for the whole `/api/` namespace.
 */
import { Elysia, t } from "elysia";
import { cloneElement, convertLegacyLayout, isLegacyLayout, normalizeElements } from "../../shared/layout";
import { DEFAULT_GENERAL_SETTINGS, type GeneralSettings, type SetupInfo } from "../../shared/types";
import { isOwner } from "../auth";
import { elementPicture, resolveElement } from "../data";
import { cameraStream } from "../data/home";
import { notify } from "../events";
import { connection, haStatus, listEntities, startHa, testConnection } from "../ha/client";
import { deleteMedia, listMedia, moveMedia, saveUpload, UploadError, updateMedia } from "../media";
import { MqttError, mqttStatus, parseBrokerUrl, startMqtt, testBroker } from "../mqtt/client";
import { onboardingNeeded, searchPlaces, suggestedSettings } from "../onboarding";
import { getSetting, setSetting } from "../settings";
import {
	createDisplay,
	createFolder,
	createLayout,
	deleteDisplay,
	deleteFolder,
	deleteLayout,
	getDisplay,
	getLayout,
	listDisplays,
	listFolders,
	listLayouts,
	renameFolder,
	SlugTaken,
	settingsChanged,
	updateDisplay,
	updateLayout,
} from "../store";

const id = t.Object({ id: t.String() });
const notFound = { error: "not found" };

const layoutBody = t.Object({
	name: t.Optional(t.String({ maxLength: 120 })),
	settings: t.Optional(t.Unknown()),
	elements: t.Optional(t.Unknown()),
	folder: t.Optional(t.String({ maxLength: 120 })),
	archived: t.Optional(t.Boolean()),
});
const displayBody = t.Object({
	name: t.Optional(t.String({ maxLength: 120 })),
	slug: t.Optional(t.String({ maxLength: 120 })),
	playlist: t.Optional(t.Unknown()),
	settings: t.Optional(t.Unknown()),
	archived: t.Optional(t.Boolean()),
});

/** Runs a display write; a short address that is already in use becomes a 409 the form can show. */
function slugChecked<T, R>(status: (code: 409, body: { error: string }) => R, write: () => T): T | R {
	try {
		return write();
	} catch (err) {
		if (err instanceof SlugTaken) return status(409, { error: err.message });
		throw err;
	}
}

const layoutRoutes = new Elysia({ prefix: "/layouts" })
	.get("/", () => listLayouts())
	.post("/", { body: layoutBody }, ({ body }) => createLayout(body))
	/** Accepts a SideDisplay export or a layout exported from sidequest-bar. */
	.post("/import", { body: t.Object({ data: t.Unknown(), assetBase: t.Optional(t.String()) }) }, ({ body, status }) => {
		const data = body.data as { name?: string; settings?: unknown; elements?: unknown } | null;
		if (!data || typeof data !== "object" || !Array.isArray(data.elements))
			return status(422, { error: "This file is not a layout." });
		return createLayout(isLegacyLayout(data) ? convertLegacyLayout(data, body.assetBase) : data);
	})
	.get("/:id", { params: id }, ({ params, status }) => getLayout(params.id) ?? status(404, notFound))
	.put(
		"/:id",
		{ params: id, body: layoutBody },
		({ params, body, status }) => updateLayout(params.id, body) ?? status(404, notFound),
	)
	.delete("/:id", { params: id }, ({ params, status }) =>
		deleteLayout(params.id) ? { ok: true } : status(404, notFound),
	)
	.post("/:id/duplicate", { params: id }, ({ params, status }) => {
		const source = getLayout(params.id);
		if (!source) return status(404, notFound);
		return createLayout({
			name: `${source.name} (copy)`,
			settings: source.settings,
			elements: source.elements.map(cloneElement),
			folder: source.folder,
		});
	});

// Folder names travel in the body, never in the path: they are free text.
const folderName = t.String({ maxLength: 120 });
const unnamed = { error: "Give the folder a name." };
const folderRoutes = new Elysia({ prefix: "/folders" })
	.get("/", () => listFolders())
	.post("/", { body: t.Object({ name: folderName }) }, ({ body, status }) => {
		const name = createFolder(body.name);
		return name ? { name } : status(422, unnamed);
	})
	.post("/rename", { body: t.Object({ from: folderName, to: folderName }) }, ({ body, status }) => {
		const name = renameFolder(body.from, body.to);
		return name ? { name } : status(422, unnamed);
	})
	.post("/delete", { body: t.Object({ name: folderName }) }, ({ body }) => {
		deleteFolder(body.name);
		return { ok: true };
	});

const displayRoutes = new Elysia({ prefix: "/displays" })
	.get("/", () => listDisplays())
	.post("/", { body: displayBody }, ({ body, status }) => slugChecked(status, () => createDisplay(body)))
	.get("/:id", { params: id }, ({ params, status }) => getDisplay(params.id) ?? status(404, notFound))
	.put("/:id", { params: id, body: displayBody }, ({ params, body, status }) =>
		slugChecked(status, () => updateDisplay(params.id, body) ?? status(404, notFound)),
	)
	.delete("/:id", { params: id }, ({ params, status }) =>
		deleteDisplay(params.id) ? { ok: true } : status(404, notFound),
	)
	.post("/:id/reload", { params: id }, ({ params }) => {
		notify({ event: "reload", data: null }, [params.id]);
		return { ok: true };
	})
	.post("/:id/identify", { params: id }, ({ params }) => {
		notify({ event: "identify", data: null }, [params.id]);
		return { ok: true };
	});

const mediaRoutes = new Elysia({ prefix: "/media" })
	.get("/", () => listMedia())
	.post("/", { body: t.Object({ files: t.Files(), album: t.Optional(t.String()) }) }, async ({ body, status }) => {
		const saved = [];
		const errors: string[] = [];
		for (const file of body.files) {
			try {
				saved.push(await saveUpload(file, body.album ?? ""));
			} catch (err) {
				if (!(err instanceof UploadError)) throw err;
				errors.push(err.message);
			}
		}
		if (!saved.length && errors.length) return status(422, { error: errors.join("\n") });
		return { saved, errors };
	})
	// Many files into one album: what selecting or dragging in the library does.
	.patch("/", { body: t.Object({ ids: t.Array(t.String(), { maxItems: 5000 }), album: t.String() }) }, ({ body }) => ({
		moved: moveMedia(body.ids, body.album),
	}))
	.patch(
		"/:id",
		{ params: id, body: t.Object({ name: t.Optional(t.String()), album: t.Optional(t.String()) }) },
		({ params, body, status }) => updateMedia(params.id, body) ?? status(404, notFound),
	)
	.delete("/:id", { params: id }, async ({ params, status }) =>
		(await deleteMedia(params.id)) ? { ok: true } : status(404, notFound),
	);

const generalBody = t.Object({
	locale: t.String({ maxLength: 35 }),
	timezone: t.String({ maxLength: 64 }),
	hourCycle: t.UnionEnum(["auto", "12", "24"]),
	temperatureUnit: t.UnionEnum(["c", "f"]),
	locationName: t.String({ maxLength: 120 }),
	latitude: t.Number({ minimum: -90, maximum: 90 }),
	longitude: t.Number({ minimum: -180, maximum: 180 }),
});

const mqttBody = t.Object({
	url: t.String({ maxLength: 300 }),
	username: t.Optional(t.String({ maxLength: 200 })),
	password: t.Optional(t.String({ maxLength: 500 })),
});

const settingsRoutes = new Elysia()
	.get("/settings", () => {
		const ha = getSetting("ha");
		const mqtt = getSetting("mqtt");
		return {
			general: getSetting("general"),
			access: getSetting("auth.haAccess"),
			// The token and the password themselves are never sent back, only whether one is stored.
			ha: { url: ha.url, hasToken: Boolean(ha.token), status: haStatus() },
			mqtt: {
				url: mqtt.url,
				username: mqtt.username,
				hasPassword: Boolean(mqtt.password),
				status: mqttStatus(),
			},
		};
	})
	.put(
		"/settings/access",
		{ body: t.Object({ access: t.Union([t.Literal("admins"), t.Literal("everyone")]) }) },
		({ body, request, server, status }) => {
			if (!isOwner(request, server?.requestIP(request)?.address))
				return status(403, { error: "Only a Home Assistant administrator can change who gets in." });
			setSetting("auth.haAccess", body.access);
			return { access: body.access };
		},
	)
	.put("/settings/general", { body: generalBody }, ({ body, status }) => {
		const general: GeneralSettings = { ...DEFAULT_GENERAL_SETTINGS, ...body };
		try {
			new Intl.DateTimeFormat(general.locale || undefined, { timeZone: general.timezone || undefined });
		} catch {
			return status(422, { error: "Unknown locale or time zone." });
		}
		setSetting("general", general);
		settingsChanged();
		return general;
	})
	.get(
		"/onboarding",
		async (): Promise<SetupInfo> => ({
			needed: onboardingNeeded(),
			general: getSetting("general"),
			suggested: await suggestedSettings(),
		}),
	)
	.post("/onboarding/skip", () => {
		setSetting("onboarded", true);
		return { ok: true };
	})
	.get(
		"/places",
		{ query: t.Object({ q: t.String({ maxLength: 120 }), language: t.Optional(t.String({ maxLength: 35 })) }) },
		async ({ query, status }) => {
			try {
				// Open-Meteo wants a bare language ("en"), not a full locale.
				return await searchPlaces(query.q, (query.language ?? "").split("-")[0]!.toLowerCase());
			} catch {
				return status(502, { error: "The place search cannot be reached right now." });
			}
		},
	)
	.put(
		"/settings/ha",
		{ body: t.Object({ url: t.String({ maxLength: 300 }), token: t.Optional(t.String({ maxLength: 2000 })) }) },
		({ body }) => {
			const current = getSetting("ha");
			// An omitted token keeps the stored one; clearing the URL forgets both.
			setSetting(
				"ha",
				body.url.trim() ? { url: body.url.trim(), token: body.token?.trim() || current.token } : { url: "", token: "" },
			);
			startHa();
			settingsChanged();
			return { ok: true };
		},
	)
	.post("/ha/test", { body: t.Object({ url: t.String(), token: t.Optional(t.String()) }) }, ({ body }) =>
		testConnection(body.url, body.token?.trim() || getSetting("ha").token),
	)
	.put("/settings/mqtt", { body: mqttBody }, ({ body, status }) => {
		const url = body.url.trim();
		try {
			if (url) parseBrokerUrl(url);
		} catch (err) {
			if (err instanceof MqttError) return status(422, { error: err.message });
			throw err;
		}
		const current = getSetting("mqtt");
		const username = body.username?.trim() ?? "";
		// An omitted password keeps the stored one, as long as it is still for the
		// same user; clearing the address forgets everything.
		const password = body.password || (username === current.username ? current.password : "");
		setSetting("mqtt", url ? { url, username, password } : { url: "", username: "", password: "" });
		startMqtt();
		settingsChanged();
		return { ok: true };
	})
	.post("/mqtt/test", { body: mqttBody }, ({ body }) => {
		const current = getSetting("mqtt");
		const username = body.username?.trim() ?? "";
		return testBroker(body.url, username, body.password || (username === current.username ? current.password : ""));
	})
	.get("/mqtt/status", () => mqttStatus())
	.get("/ha/status", () => haStatus())
	.get("/ha/entities", () => ({ configured: Boolean(connection()), entities: listEntities() }))
	/** Data for an element as it is being edited (not saved yet, so sent whole). */
	.post("/preview/data", { body: t.Object({ element: t.Unknown() }) }, async ({ body, status }) => {
		const [element] = normalizeElements([body.element]);
		return element ? resolveElement(element) : status(422, { error: "not an element" });
	})
	.post("/preview/picture", { body: t.Object({ element: t.Unknown() }) }, async ({ body, status }) => {
		const [element] = normalizeElements([body.element]);
		const picture = element ? await elementPicture(element).catch(() => null) : null;
		return picture ?? status(404, notFound);
	})
	/** A camera's MJPEG stream for the editor preview; a GET, so an <img> can show it. */
	.get(
		"/preview/live",
		{ query: t.Object({ entity: t.String({ maxLength: 255 }) }) },
		async ({ query, request, status }) => (await cameraStream(query.entity, request.signal)) ?? status(404, notFound),
	);

export const adminRoutes = new Elysia({ name: "routes.admin", prefix: "/api" })
	.use(layoutRoutes)
	.use(folderRoutes)
	.use(displayRoutes)
	.use(mediaRoutes)
	.use(settingsRoutes);
