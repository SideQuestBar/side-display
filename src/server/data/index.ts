/**
 * Resolves the server-side data of an element: one function per element type
 * that needs something the browser should not (or cannot) fetch itself.
 * Secrets such as the Home Assistant token never leave the server; a display
 * only ever receives the data of the elements placed on its layouts.
 */
import type { EntitiesData, EntityData, TemplateData, TodoData } from "../../shared/data";
import type { El, ElementType } from "../../shared/elements";
import type { AnyEl, ElementData, GeneralSettings, HaEntityState } from "../../shared/types";
import { connection, entityState, haFetch, haServiceResponse } from "../ha/client";
import { messageValue, topicMessage } from "../mqtt/client";
import { getSetting } from "../settings";
import { pdfDocument, socialPosts } from "./boards";
import { chart, jsonValue, sports, stocks, transit, uptime } from "./feeds";
import { alertsData, cameraSnapshot, energyData, entityData, graphData, presenceData, presencePicture } from "./home";
import { galleryPhotos, textStates } from "./pictures";
import { cached } from "./sources";
import { rssData, tickerData, twitchData, videoData, webData, webPicture } from "./streams";
import { birthdaysData, calendarData, hoursData } from "./time";
import { airQuality, map, weather } from "./weather";

type Resolver<K extends ElementType> = (el: El<K>, general: GeneralSettings) => Promise<unknown> | unknown;

const num = (v: unknown): number | null => {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : null;
};

/**
 * An MQTT topic in the shape of an entity state, so the MQTT elements are
 * drawn by the same code as the Home Assistant ones. Null until the topic has
 * a message.
 */
async function topicState(row: { topic: string; path: string; unit: string }): Promise<HaEntityState | null> {
	const topic = row.topic.trim();
	if (!topic) return null;
	const message = await topicMessage(topic);
	if (!message) return null;
	return {
		entity_id: topic,
		state: messageValue(message.payload, row.path),
		name: topic.split("/").filter(Boolean).at(-1) ?? topic,
		unit: row.unit,
		icon: "",
		device_class: "",
		last_changed: new Date(message.changedAt).toISOString(),
		// When a message last arrived, repeated value or not: what "stale after" is measured from.
		attributes: { received: new Date(message.receivedAt).toISOString() },
	};
}

const resolvers: { [K in ElementType]?: Resolver<K> } = {
	weather,
	"air-quality": airQuality,

	calendar: calendarData,
	hours: hoursData,
	birthdays: birthdaysData,

	text: textStates,
	gallery: galleryPhotos,

	rss: rssData,
	transit,
	stocks,
	sports,
	uptime,
	json: jsonValue,
	chart,
	ticker: tickerData,
	social: socialPosts,
	video: videoData,
	twitch: twitchData,
	web: webData,

	"ha-entity": entityData,
	"ha-gauge": entityData,
	"ha-camera": (el): EntityData => ({ state: entityState(el.entity) }),
	"ha-media": (el): EntityData => ({ state: entityState(el.entity) }),
	"ha-entities": (el): EntitiesData => ({ states: el.entities.map((row) => entityState(row.entity)) }),

	"ha-graph": graphData,
	"ha-energy": energyData,
	"ha-climate": (el): EntityData => ({ state: entityState(el.entity) }),
	"ha-presence": presenceData,
	"ha-alerts": alertsData,
	"ha-stream": (el): EntityData => ({ state: entityState(el.entity) }),

	async "ha-todo"(el): Promise<TodoData> {
		if (!el.entity) return { items: [] };
		const response = await cached(`ha-todo:${el.entity}`, 20, () =>
			haServiceResponse<Record<string, { items?: { summary: string; status: string; due?: string }[] }>>(
				"todo",
				"get_items",
				{
					entity_id: el.entity,
				},
			),
		);
		return {
			items: (response[el.entity]?.items ?? []).map((item) => ({
				summary: item.summary,
				done: item.status === "completed",
				due: item.due ?? "",
			})),
		};
	},

	async "ha-template"(el): Promise<TemplateData> {
		if (!el.template.trim()) return { text: "" };
		const text = await cached(`ha-template:${Bun.hash(el.template)}`, Math.max(5, el.refresh) - 1, async () =>
			(await haFetch("/template", { method: "POST", body: JSON.stringify({ template: el.template }) })).text(),
		);
		return { text };
	},

	mqtt: async (el): Promise<EntityData> => ({ state: await topicState(el) }),
	// One topic that cannot be read must not blank the rows that can.
	"mqtt-list": async (el): Promise<EntitiesData> => ({
		states: await Promise.all(el.topics.map((row) => topicState(row).catch(() => null))),
	}),

	map,
};

/** Is the element's "only when this entity is…" condition met? */
function conditionMet(el: AnyEl): boolean {
	if (!el.showEntity) return true;
	const state = entityState(el.showEntity);
	// Without Home Assistant the condition cannot be checked: show rather than hide.
	if (!state) return !connection();
	return entityMatches(el, state.state) !== el.showNot;
}

/** Whether a state satisfies the element's condition: numeric bounds when given, else the list of states. */
export function entityMatches(el: Pick<AnyEl, "showState" | "showAbove" | "showBelow">, state: string): boolean {
	const above = el.showAbove.trim() === "" ? null : num(el.showAbove);
	const below = el.showBelow.trim() === "" ? null : num(el.showBelow);
	if (above !== null || below !== null) {
		const value = num(state);
		// "unavailable" is neither above nor below anything.
		return value !== null && (above === null || value > above) && (below === null || value < below);
	}
	const wanted = el.showState
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	return wanted.length === 0 || wanted.includes(state.toLowerCase());
}

export async function resolveElement(el: AnyEl): Promise<ElementData> {
	const show = conditionMet(el);
	const resolver = resolvers[el.type] as Resolver<ElementType> | undefined;
	if (!resolver || !show) return { show, data: null };
	try {
		return { show, data: await resolver(el as never, getSetting("general")) };
	} catch (err) {
		return { show, data: null, error: (err as Error).message };
	}
}

/**
 * Fetches the picture behind an element from Home Assistant: a camera or image
 * snapshot, or a media player's artwork. Returns null when there is none.
 */
export async function elementPicture(el: AnyEl, wanted?: string): Promise<Response | null> {
	// One of several pictures (the people of a presence element); the element decides which it may serve.
	if (el.type === "ha-presence") return presencePicture(el, wanted);
	if (el.type === "ha-stream") return cameraSnapshot(typeof el.entity === "string" ? el.entity : "");
	if (el.type === "web") return webPicture(el);
	if (el.type === "pdf") return pdfDocument(el);
	const entity = typeof el.entity === "string" ? el.entity : "";
	if (!entity) return null;
	let path: string | null = null;
	if (el.type === "ha-camera")
		path = entity.startsWith("image.") ? `/image_proxy/${entity}` : `/camera_proxy/${entity}`;
	if (el.type === "ha-media") {
		const picture = entityState(entity)?.attributes.entity_picture;
		// `entity_picture` is a path on Home Assistant, already under `/api/…`.
		if (typeof picture === "string" && picture.startsWith("/api/")) path = picture.slice(4);
	}
	if (!path) return null;
	const upstream = await haFetch(path, { headers: { "content-type": "" } });
	return new Response(upstream.body, {
		headers: { "content-type": upstream.headers.get("content-type") ?? "image/jpeg", "cache-control": "no-store" },
	});
}
