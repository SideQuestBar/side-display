/**
 * A stand-in for Home Assistant: just enough of its WebSocket and REST APIs
 * for SideDisplay to connect to. The tests use it to exercise the integration
 * end to end, and `bun run demo` uses it so the app can be tried (and
 * screenshotted) without a real Home Assistant.
 *
 * It also serves a sample iCal calendar and RSS feed for the same purpose.
 */
import { deflateSync } from "node:zlib";
import type { Server, ServerWebSocket } from "bun";

export const FAKE_TOKEN = "fake-long-lived-token";

interface State {
	entity_id: string;
	state: string;
	attributes: Record<string, unknown>;
	last_changed: string;
}

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function initialStates(): State[] {
	const entity = (
		entity_id: string,
		state: string,
		attributes: Record<string, unknown> = {},
		changedAgo = 20 * 60_000,
	): State => ({
		entity_id,
		state,
		attributes,
		last_changed: iso(-changedAgo),
	});
	return [
		entity("sensor.living_room_temperature", "21.4", {
			friendly_name: "Living room",
			unit_of_measurement: "°C",
			device_class: "temperature",
		}),
		entity("sensor.bedroom_temperature", "19.2", {
			friendly_name: "Bedroom",
			unit_of_measurement: "°C",
			device_class: "temperature",
		}),
		entity("sensor.outdoor_temperature", "7.8", {
			friendly_name: "Outside",
			unit_of_measurement: "°C",
			device_class: "temperature",
		}),
		entity("sensor.living_room_humidity", "46", {
			friendly_name: "Humidity",
			unit_of_measurement: "%",
			device_class: "humidity",
		}),
		entity("sensor.power_consumption", "412", {
			friendly_name: "Power",
			unit_of_measurement: "W",
			device_class: "power",
		}),
		entity("sensor.solar_production", "1.84", {
			friendly_name: "Solar",
			unit_of_measurement: "kW",
			device_class: "power",
		}),
		entity("binary_sensor.front_door", "off", { friendly_name: "Front door", device_class: "door" }, 3 * HOUR),
		entity("light.kitchen", "on", { friendly_name: "Kitchen light" }),
		entity("person.alex", "home", {
			friendly_name: "Alex",
			latitude: 47.4979,
			longitude: 19.0402,
			entity_picture: "/api/image/serve/alex/512x512",
		}),
		entity("person.jo_miller", "Work", { friendly_name: "Jo Miller" }),
		entity("person.sam", "not_home", { friendly_name: "Sam", latitude: 47.5145, longitude: 19.0773 }),
		entity("weather.home", "partlycloudy", {
			friendly_name: "Home",
			temperature: 8,
			apparent_temperature: 6,
			humidity: 71,
			wind_speed: 14,
			temperature_unit: "°C",
			wind_speed_unit: "km/h",
		}),
		entity("calendar.family", "off", { friendly_name: "Family" }),
		entity("todo.shopping_list", "4", { friendly_name: "Shopping list" }),
		entity("camera.front_door", "idle", { friendly_name: "Front door camera" }),
		// A camera that only offers HLS or WebRTC: asking it for MJPEG fails.
		entity("camera.garden", "idle", { friendly_name: "Garden camera", frontend_stream_type: "hls" }),
		entity("sensor.grid_power", "-620", { friendly_name: "Grid", unit_of_measurement: "W", device_class: "power" }),
		entity("sensor.battery_power", "-810", {
			friendly_name: "Battery",
			unit_of_measurement: "W",
			device_class: "power",
		}),
		entity("sensor.battery_level", "78", {
			friendly_name: "House battery",
			unit_of_measurement: "%",
			device_class: "battery",
		}),
		entity("sensor.solar_energy_today", "12.4", {
			friendly_name: "Solar today",
			unit_of_measurement: "kWh",
			device_class: "energy",
		}),
		entity("sensor.grid_import_today", "3.1", {
			friendly_name: "Bought today",
			unit_of_measurement: "kWh",
			device_class: "energy",
		}),
		entity("sensor.grid_export_today", "5.6", {
			friendly_name: "Sold today",
			unit_of_measurement: "kWh",
			device_class: "energy",
		}),
		entity("climate.living_room", "heat", {
			friendly_name: "Living room thermostat",
			current_temperature: 20.6,
			temperature: 22,
			hvac_action: "heating",
			current_humidity: 46,
			min_temp: 7,
			max_temp: 30,
			hvac_modes: ["off", "heat", "cool"],
		}),
		entity("binary_sensor.kitchen_window", "on", { friendly_name: "Kitchen window", device_class: "window" }),
		entity("binary_sensor.bathroom_leak", "off", { friendly_name: "Bathroom leak", device_class: "moisture" }),
		entity("binary_sensor.hallway_motion", "on", { friendly_name: "Hallway motion", device_class: "motion" }),
		entity("sensor.remote_battery", "12", {
			friendly_name: "Remote battery",
			unit_of_measurement: "%",
			device_class: "battery",
		}),
		entity("sensor.door_sensor_battery", "64", {
			friendly_name: "Door sensor battery",
			unit_of_measurement: "%",
			device_class: "battery",
		}),
		entity("media_player.living_room", "playing", {
			friendly_name: "Living room speaker",
			media_title: "Weightless",
			media_artist: "Marconi Union",
			media_album_name: "Ambient Transmissions",
			media_duration: 480,
			media_position: 151,
			media_position_updated_at: iso(-20_000),
			entity_picture: "/api/media_player_proxy/media_player.living_room?token=x",
		}),
	];
}

/** A smooth, repeatable pseudo-history for graphs. */
function history(entityId: string, startMs: number): { state: string; last_changed: string }[] {
	const seed = [...entityId].reduce((sum, c) => sum + c.charCodeAt(0), 0);
	const points: { state: string; last_changed: string }[] = [];
	const base = entityId.includes("power") ? 420 : entityId.includes("outdoor") ? 7 : 21;
	const swing = entityId.includes("power") ? 260 : 3.2;
	for (let t = startMs; t <= Date.now(); t += 15 * 60_000) {
		const day = (t % DAY) / DAY;
		const value = base + Math.sin(day * Math.PI * 2 - 1.6) * swing + Math.sin(t / 2_400_000 + seed) * swing * 0.25;
		points.push({ state: value.toFixed(entityId.includes("power") ? 0 : 1), last_changed: new Date(t).toISOString() });
	}
	return points;
}

const picture = (label: string, from: string, to: string) =>
	`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><path d="M0 300 L150 190 L250 250 L400 140 L640 280 L640 360 L0 360Z" fill="#0006"/><text x="24" y="44" font-family="sans-serif" font-size="22" font-weight="700" fill="#fff">${label}</text><text x="24" y="340" font-family="monospace" font-size="16" fill="#fffc">${new Date().toISOString().slice(11, 19)}</text></svg>`;

/** A PNG chunk: length, type, data, checksum. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, Bun.hash.crc32(out.subarray(4, 8 + data.length)));
	return out;
}

let frames: Promise<Uint8Array[]> | null = null;
/**
 * A few JPEG frames of a bar sweeping over a gradient, for the fake camera's
 * MJPEG stream: browsers only play motion JPEG, so the SVG snapshots will not do.
 */
function streamFrames(): Promise<Uint8Array[]> {
	const WIDTH = 320;
	const HEIGHT = 180;
	const COUNT = 8;
	frames ??= Promise.all(
		Array.from({ length: COUNT }, async (_, frame) => {
			const raw = new Uint8Array((WIDTH * 3 + 1) * HEIGHT);
			const bar = Math.round(((frame + 0.5) / COUNT) * WIDTH);
			for (let y = 0; y < HEIGHT; y++) {
				const row = y * (WIDTH * 3 + 1);
				for (let x = 0; x < WIDTH; x++) {
					const lit = Math.abs(x - bar) < 10;
					raw.set(lit ? [255, 240, 120] : [40 + (x >> 2), 70 + (y >> 1), 110], row + 1 + x * 3);
				}
			}
			const header = new Uint8Array(13);
			const view = new DataView(header.buffer);
			view.setUint32(0, WIDTH);
			view.setUint32(4, HEIGHT);
			header.set([8, 2, 0, 0, 0], 8);
			const png = Buffer.concat([
				Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
				pngChunk("IHDR", header),
				pngChunk("IDAT", deflateSync(raw)),
				pngChunk("IEND", new Uint8Array(0)),
			]);
			return new Bun.Image(png).jpeg({ quality: 70 }).bytes();
		}),
	);
	return frames;
}

/** `multipart/x-mixed-replace`: one JPEG after the other until the viewer leaves, as Home Assistant sends it. */
function mjpeg(signal: AbortSignal): Response {
	let timer: ReturnType<typeof setInterval> | undefined;
	const stop = () => clearInterval(timer);
	const body = new ReadableStream<Uint8Array>({
		async start(controller) {
			const all = await streamFrames();
			let index = 0;
			const send = () => {
				const frame = all[index++ % all.length]!;
				try {
					controller.enqueue(
						Buffer.concat([
							Buffer.from(`--frameboundary\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`),
							frame,
							Buffer.from("\r\n"),
						]),
					);
				} catch {
					stop();
				}
			};
			send();
			timer = setInterval(send, 200);
			signal.addEventListener("abort", () => {
				stop();
				try {
					controller.close();
				} catch {
					// Already closed by the cancel below.
				}
			});
		},
		cancel: stop,
	});
	return new Response(body, { headers: { "content-type": "multipart/x-mixed-replace;boundary=frameboundary" } });
}

const icsDate = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const icsDay = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, "");

/** Events relative to today, so the sample calendar never looks stale. */
function sampleEvents() {
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	const at = (dayOffset: number, hour: number, minute = 0) =>
		new Date(midnight.getTime() + dayOffset * DAY + hour * HOUR + minute * 60_000);
	return [
		{ summary: "Quiz night", start: at(0, 19, 30), end: at(0, 22), location: "Main room" },
		{ summary: "Board game meetup", start: at(1, 18), end: at(1, 23), location: "Upstairs" },
		{ summary: "Live acoustic set", start: at(2, 20), end: at(2, 22, 30), location: "Stage" },
		{ summary: "Retro console tournament", start: at(4, 17), end: at(4, 21), location: "Arcade corner" },
		{ summary: "Pub quiz: movie edition", start: at(7, 19, 30), end: at(7, 22), location: "Main room" },
		{ summary: "Brunch & puzzles", start: at(8, 11), end: at(8, 14), location: "" },
	];
}

function sampleCalendar(): string {
	const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SideDisplay//Demo//EN"];
	for (const [i, event] of sampleEvents().entries()) {
		lines.push(
			"BEGIN:VEVENT",
			`UID:demo-${i}@sidedisplay`,
			`DTSTAMP:${icsDate(new Date())}`,
			`DTSTART:${icsDate(event.start)}`,
			`DTEND:${icsDate(event.end)}`,
			`SUMMARY:${event.summary}`,
			`LOCATION:${event.location}`,
			"END:VEVENT",
		);
	}
	const today = new Date();
	// A weekly recurring event and an all-day one, to cover both paths.
	lines.push(
		"BEGIN:VEVENT",
		"UID:demo-weekly@sidedisplay",
		`DTSTAMP:${icsDate(today)}`,
		`DTSTART:${icsDate(new Date(today.getTime() - 21 * DAY)).slice(0, 9)}160000Z`,
		`DTEND:${icsDate(new Date(today.getTime() - 21 * DAY)).slice(0, 9)}180000Z`,
		"RRULE:FREQ=WEEKLY",
		"SUMMARY:Happy hour",
		"END:VEVENT",
	);
	lines.push(
		"BEGIN:VEVENT",
		"UID:demo-allday@sidedisplay",
		`DTSTAMP:${icsDate(today)}`,
		`DTSTART;VALUE=DATE:${icsDay(new Date(today.getTime() + 3 * DAY))}`,
		`DTEND;VALUE=DATE:${icsDay(new Date(today.getTime() + 4 * DAY))}`,
		"SUMMARY:Closed for a private event",
		"END:VEVENT",
	);
	lines.push("END:VCALENDAR");
	return lines.join("\r\n");
}

const sampleFeed = () => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Neighbourhood news</title>
<item><title>New tram line opens next month</title><link>https://example.com/1</link><pubDate>${new Date(Date.now() - 2 * HOUR).toUTCString()}</pubDate><description><![CDATA[<p>The long-awaited line will connect the old town to the riverside.</p>]]></description></item>
<item><title>Farmers&apos; market moves to Saturdays</title><link>https://example.com/2</link><pubDate>${new Date(Date.now() - 9 * HOUR).toUTCString()}</pubDate><description>Stalls open from 8 until noon on the main square.</description></item>
<item><title>Library extends its evening hours</title><link>https://example.com/3</link><pubDate>${new Date(Date.now() - 26 * HOUR).toUTCString()}</pubDate><description>Open until 21:00 on weekdays from now on.</description></item>
<item><title>Street festival: road closures this weekend</title><link>https://example.com/4</link><pubDate>${new Date(Date.now() - 50 * HOUR).toUTCString()}</pubDate><description>Expect music, food and detours.</description></item>
</channel></rss>`;

export interface FakeHa {
	url: string;
	server: Server<unknown>;
	/** Changes an entity and notifies connected clients, like a real state change. */
	setState: (entityId: string, state: string, attributes?: Record<string, unknown>) => void;
	stop: () => Promise<void>;
	/** How many camera streams are being watched right now. */
	streams: () => number;
}

export function startFakeHa(port = 0): FakeHa {
	const states = new Map(initialStates().map((s) => [s.entity_id, s]));
	const sockets = new Map<ServerWebSocket<unknown>, number | null>();
	const json = (value: unknown, status = 200) => Response.json(value, { status });
	let watching = 0;

	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(request, srv) {
			const { pathname, searchParams } = new URL(request.url);
			if (pathname === "/api/websocket")
				return srv.upgrade(request) ? undefined : new Response("upgrade failed", { status: 400 });
			if (pathname === "/calendar.ics")
				return new Response(sampleCalendar(), { headers: { "content-type": "text/calendar" } });
			if (pathname === "/feed.xml")
				return new Response(sampleFeed(), { headers: { "content-type": "application/rss+xml" } });
			if (!pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
			if (request.headers.get("authorization") !== `Bearer ${FAKE_TOKEN}`)
				return new Response("401: Unauthorized", { status: 401 });

			if (pathname === "/api/config")
				return json({
					version: "2026.11.0",
					location_name: "Demo home",
					latitude: 47.4979,
					longitude: 19.0402,
					time_zone: "Europe/Budapest",
					language: "en",
					country: "HU",
					unit_system: { temperature: "°C" },
				});
			if (pathname.startsWith("/api/history/period/")) {
				const start = Date.parse(decodeURIComponent(pathname.slice("/api/history/period/".length)));
				const id = searchParams.get("filter_entity_id") ?? "";
				// People and trackers have a position in their attributes, when those are asked for:
				// a walk that ends where the entity is now.
				const here = states.get(id)?.attributes;
				if (/^(person|device_tracker)\./.test(id) && !searchParams.has("no_attributes") && here) {
					const steps = 40;
					return json([
						Array.from({ length: steps }, (_, i) => {
							const left = (steps - 1 - i) / steps;
							return {
								entity_id: id,
								state: "not_home",
								attributes: {
									latitude: Number(here.latitude) + left * 0.02 + Math.sin(i / 3) * 0.002 * left,
									longitude: Number(here.longitude) - left * 0.03 + Math.cos(i / 4) * 0.004 * left,
								},
								last_changed: new Date(start + (i / steps) * (Date.now() - start)).toISOString(),
							};
						}),
					]);
				}
				return json([history(id, start)]);
			}
			if (pathname.startsWith("/api/calendars/")) {
				const day = (offset: number, hour: number) => {
					const date = new Date(Date.now() + offset * DAY);
					date.setHours(hour, 0, 0, 0);
					return date.toISOString();
				};
				return json([
					{
						summary: "Dentist",
						start: { dateTime: day(1, 9) },
						end: { dateTime: day(1, 10) },
						location: "Main street 12",
					},
					{
						summary: "School holiday",
						start: { date: iso(2 * DAY).slice(0, 10) },
						end: { date: iso(3 * DAY).slice(0, 10) },
					},
					{ summary: "Dinner with the neighbours", start: { dateTime: day(3, 19) }, end: { dateTime: day(3, 22) } },
				]);
			}
			if (pathname === "/api/services/weather/get_forecasts") {
				const { entity_id, type } = (await request.json()) as { entity_id: string; type?: string };
				const conditions = ["partlycloudy", "rainy", "cloudy", "sunny", "sunny", "snowy", "fog"];
				// Hourly forecasts start at the next full hour, as Home Assistant's do.
				if (type === "hourly") {
					const next = Math.ceil(Date.now() / HOUR) * HOUR;
					return json({
						service_response: {
							[entity_id]: {
								forecast: Array.from({ length: 24 }, (_, i) => ({
									datetime: new Date(next + i * HOUR).toISOString(),
									condition: conditions[Math.floor(i / 4) % conditions.length],
									temperature: 8 + Math.round(Math.sin(i / 4) * 3),
									precipitation_probability: Math.floor(i / 4) % conditions.length === 1 ? 70 : 5,
								})),
							},
						},
					});
				}
				return json({
					service_response: {
						[entity_id]: {
							forecast: conditions.map((condition, i) => ({
								datetime: iso(i * DAY),
								condition,
								temperature: 9 + ((i * 3) % 6),
								templow: 2 + ((i * 2) % 4),
								precipitation_probability: condition === "rainy" ? 80 : 10,
							})),
						},
					},
				});
			}
			if (pathname === "/api/services/todo/get_items") {
				const { entity_id } = (await request.json()) as { entity_id: string };
				return json({
					service_response: {
						[entity_id]: {
							items: [
								{ summary: "Oat milk", status: "needs_action" },
								{ summary: "Coffee beans", status: "needs_action" },
								{ summary: "Limes", status: "needs_action" },
								{ summary: "Dish soap", status: "needs_action" },
								{ summary: "Bread", status: "completed" },
							],
						},
					},
				});
			}
			if (pathname === "/api/template") {
				const { template } = (await request.json()) as { template: string };
				// Only `states('entity')` is understood: enough for the demo and the tests.
				return new Response(
					template.replace(/\{\{\s*states\('([^']+)'\)\s*\}\}/g, (_, id: string) => states.get(id)?.state ?? "unknown"),
				);
			}
			if (pathname.startsWith("/api/camera_proxy_stream/")) {
				if (!pathname.endsWith("/camera.front_door")) return new Response("no MJPEG stream", { status: 500 });
				watching++;
				request.signal.addEventListener("abort", () => watching--, { once: true });
				return mjpeg(request.signal);
			}
			if (pathname.startsWith("/api/image/serve/"))
				return new Response(picture("Alex", "#0f766e", "#f59e0b"), { headers: { "content-type": "image/svg+xml" } });
			if (pathname.startsWith("/api/camera_proxy/"))
				return new Response(picture("Front door", "#31506b", "#8d6a4f"), {
					headers: { "content-type": "image/svg+xml" },
				});
			if (pathname.startsWith("/api/media_player_proxy/"))
				return new Response(picture("♪", "#7b2ff7", "#f107a3"), { headers: { "content-type": "image/svg+xml" } });
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				sockets.set(ws, null);
				ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.0" }));
			},
			message(ws, raw) {
				const message = JSON.parse(String(raw)) as { type: string; id?: number; access_token?: string };
				if (message.type === "auth") {
					if (message.access_token === FAKE_TOKEN)
						ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.0" }));
					else {
						ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
						ws.close();
					}
				} else if (message.type === "get_states") {
					ws.send(JSON.stringify({ id: message.id, type: "result", success: true, result: [...states.values()] }));
				} else if (message.type === "subscribe_events") {
					sockets.set(ws, message.id ?? null);
					ws.send(JSON.stringify({ id: message.id, type: "result", success: true, result: null }));
				}
			},
			close(ws) {
				sockets.delete(ws);
			},
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		server,
		setState(entityId, state, attributes) {
			const previous = states.get(entityId);
			const next: State = {
				entity_id: entityId,
				state,
				attributes: { ...previous?.attributes, ...attributes },
				last_changed: iso(),
			};
			states.set(entityId, next);
			for (const [ws, id] of sockets) {
				if (id !== null)
					ws.send(
						JSON.stringify({
							id,
							type: "event",
							event: { event_type: "state_changed", data: { entity_id: entityId, new_state: next } },
						}),
					);
			}
		},
		stop: () => server.stop(true),
		streams: () => watching,
	};
}
