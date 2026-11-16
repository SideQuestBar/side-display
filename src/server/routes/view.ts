/**
 * What a screen talks to. These routes are public: a display is addressed by
 * its unguessable id, like a share link, because the devices showing it
 * (TVs, ePaper frames, kiosk browsers) cannot sign in. A display that was
 * given a slug answers to that as well, which trades the secrecy of the
 * address for one that can be typed; `:id` below is either of the two.
 *
 * A display only ever receives its own layouts and the data of the elements
 * on them; nothing here accepts input beyond ids.
 */
import { Elysia, sse, t } from "elysia";
import { config } from "../config";
import { elementPicture, resolveElement } from "../data";
import { cameraStream } from "../data/home";
import { createQueue, type StreamEvent, subscribe } from "../events";
import { serveMedia } from "../media";
import { touchDisplay, viewElement, viewPayload } from "../store";

const notFound = { error: "not found" };

export const viewRoutes = new Elysia({ name: "routes.view" })
	.get("/api/view/:id", { params: t.Object({ id: t.String() }) }, ({ params, status, set }) => {
		set.headers["cache-control"] = "no-store";
		return viewPayload(params.id) ?? status(404, notFound);
	})
	.get(
		"/api/view/:id/data/:element",
		{ params: t.Object({ id: t.String(), element: t.String() }) },
		async ({ params, status, set }) => {
			const element = viewElement(params.id, params.element);
			if (!element) return status(404, notFound);
			set.headers["cache-control"] = "no-store";
			return resolveElement(element);
		},
	)
	.get(
		"/api/view/:id/picture/:element",
		{
			params: t.Object({ id: t.String(), element: t.String() }),
			// Which of an element's several pictures (a person of a presence element): only ever one it lists.
			query: t.Object({ entity: t.Optional(t.String({ maxLength: 255 })) }),
		},
		async ({ params, query, status }) => {
			const element = viewElement(params.id, params.element);
			const picture = element ? await elementPicture(element, query.entity).catch(() => null) : null;
			return picture ?? status(404, notFound);
		},
	)
	/** The MJPEG stream of a camera stream element; 404 tells the display to use snapshots instead. */
	.get(
		"/api/view/:id/live/:element",
		{ params: t.Object({ id: t.String(), element: t.String() }) },
		async ({ params, request, status }) => {
			const element = viewElement(params.id, params.element);
			const entity = element?.type === "ha-stream" ? String(element.entity ?? "") : "";
			return (await cameraStream(entity, request.signal)) ?? status(404, notFound);
		},
	)
	.get(
		"/api/view/:id/stream",
		{ params: t.Object({ id: t.String() }) },
		async function* ({ params, request, status, set }) {
			const payload = viewPayload(params.id);
			if (!payload) return status(404, notFound);
			// The address may have named the display by its slug; events are sent by id.
			const displayId = payload.display.id;
			// Tell reverse proxies (nginx, Home Assistant ingress) not to buffer the stream.
			set.headers["x-accel-buffering"] = "no";
			set.headers["cache-control"] = "no-store";
			const queue = createQueue<StreamEvent>();
			const unsubscribe = subscribe(displayId, (event) => queue.push(event));
			// Keep-alive, shorter than the idle timeout of any proxy in front of us.
			const heartbeat = setInterval(() => queue.push({ event: "ping", data: "" }), 15_000);
			request.signal.addEventListener("abort", () => queue.close());
			touchDisplay(displayId);
			try {
				yield sse({ event: "connected", data: { version: config.version } });
				for await (const event of queue) yield sse({ event: event.event, data: event.data ?? "" });
			} finally {
				clearInterval(heartbeat);
				unsubscribe();
				touchDisplay(displayId);
			}
		},
	)
	.get(
		"/media/:file",
		{
			params: t.Object({ file: t.String() }),
			query: t.Object({ w: t.Optional(t.Numeric({ minimum: 16, maximum: 4096 })) }),
		},
		({ params, query, request }) => serveMedia(params.file, request, query.w),
	);
