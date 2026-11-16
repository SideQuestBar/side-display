/**
 * MQTT connection: SideDisplay listens to the topics its elements show and
 * keeps the last message of each, so a display updates the moment something
 * is published. It never publishes anything itself.
 *
 * Only the topics in use are subscribed to (not `#`): a busy broker would
 * otherwise send everything it carries.
 *
 * Broker settings come from, in order: the settings page, the
 * `SIDEDISPLAY_MQTT_*` variables, then the Supervisor when running as a Home
 * Assistant app next to an MQTT broker (nothing to configure there).
 */
import type { Socket } from "bun";
import { mqttKey } from "../../shared/layout";
import type { MqttStatus } from "../../shared/types";
import { config } from "../config";
import { getSetting } from "../settings";
import {
	connectPacket,
	disconnectPacket,
	PacketReader,
	PacketType,
	pingPacket,
	pubackPacket,
	readPublish,
	subscribePacket,
	unsubscribePacket,
} from "./packets";

export interface Broker {
	source: MqttStatus["source"];
	host: string;
	port: number;
	tls: boolean;
	username: string;
	password: string;
}

export class MqttError extends Error {}

/** Reads `mqtt://host:1883`, `mqtts://host` or a bare `host[:port]`. */
export function parseBrokerUrl(raw: string): Pick<Broker, "host" | "port" | "tls" | "username" | "password"> {
	const value = raw.trim();
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `mqtt://${value}`);
	} catch {
		throw new MqttError("That is not a broker address.");
	}
	const scheme = url.protocol.slice(0, -1).toLowerCase();
	const tls = ["mqtts", "ssl", "tls"].includes(scheme);
	if (!tls && !["mqtt", "tcp"].includes(scheme))
		throw new MqttError("Use an address starting with mqtt:// or mqtts:// (WebSocket brokers are not supported).");
	if (!url.hostname) throw new MqttError("That is not a broker address.");
	return {
		// `URL` keeps the brackets of an IPv6 address; a socket does not want them.
		host: url.hostname.replace(/^\[|\]$/g, ""),
		port: Number(url.port) || (tls ? 8883 : 1883),
		tls,
		username: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password),
	};
}

/** Set once the Supervisor has said that Home Assistant has no broker to offer. */
let supervisorHasNone = false;

/** Where the broker settings come from, without resolving them. */
export function brokerSource(): MqttStatus["source"] {
	if (getSetting("mqtt").url) return "settings";
	if (config.mqtt.url) return "env";
	if (config.ha.supervisorToken && !supervisorHasNone) return "supervisor";
	return "none";
}

/** The broker Home Assistant offers its apps, if one is installed there. */
async function supervisorBroker(): Promise<Broker | null> {
	const response = await fetch("http://supervisor/services/mqtt", {
		headers: { authorization: `Bearer ${config.ha.supervisorToken}` },
		signal: AbortSignal.timeout(8000),
	});
	if (!response.ok) return null;
	const { data } = (await response.json()) as {
		data?: { host?: string; port?: number; ssl?: boolean; username?: string; password?: string };
	};
	if (!data?.host) return null;
	return {
		source: "supervisor",
		host: data.host,
		port: data.port ?? 1883,
		tls: Boolean(data.ssl),
		username: data.username ?? "",
		password: data.password ?? "",
	};
}

async function broker(): Promise<Broker | null> {
	const saved = getSetting("mqtt");
	const direct = (source: Broker["source"], url: string, username: string, password: string): Broker => {
		const parsed = parseBrokerUrl(url);
		// Credentials given separately win over ones written into the address.
		return { ...parsed, source, username: username || parsed.username, password: password || parsed.password };
	};
	if (saved.url) return direct("settings", saved.url, saved.username, saved.password);
	if (config.mqtt.url) return direct("env", config.mqtt.url, config.mqtt.username ?? "", config.mqtt.password ?? "");
	if (config.ha.supervisorToken) return supervisorBroker().catch(() => null);
	return null;
}

// ------------------------------------------------------------------ session

const KEEP_ALIVE_SECONDS = 30;
const CONNACK_REFUSALS: Record<number, string> = {
	1: "the broker does not speak MQTT 3.1.1",
	2: "the broker refused the client id",
	3: "the broker is unavailable",
	4: "wrong user name or password",
	5: "the broker refused the user name or password",
};

interface SessionHandlers {
	onReady: () => void;
	onMessage: (topic: string, payload: Uint8Array) => void;
	/** Subscriptions the broker turned down (access rules). */
	onRefused: (topics: string[]) => void;
	/** Called once, however the connection ends, unless we closed it ourselves. */
	onClose: (reason: string) => void;
}

interface Session {
	subscribe: (topics: string[]) => void;
	unsubscribe: (topics: string[]) => void;
	close: () => void;
}

/** One connection to a broker, from CONNECT until it drops. */
function openSession(to: Broker, handlers: SessionHandlers): Session {
	let socket: Socket | null = null;
	let ready = false;
	let done = false;
	let awaitingPong = false;
	let nextId = 1;
	const reader = new PacketReader();
	const outbox: Uint8Array[] = [];
	const awaitingSuback = new Map<number, string[]>();
	let keepAlive: ReturnType<typeof setInterval> | undefined;
	// A broker that accepts the socket but never answers must not hang us.
	const deadline = setTimeout(() => finish("the broker did not answer"), 10_000);

	function finish(reason: string | null) {
		if (done) return;
		done = true;
		clearTimeout(deadline);
		clearInterval(keepAlive);
		if (socket) {
			if (reason === null && ready) socket.write(disconnectPacket());
			socket.end();
		}
		if (reason !== null) handlers.onClose(reason);
	}

	// Bun's sockets do not buffer: what a write does not take waits for `drain`.
	function flush() {
		while (socket && outbox.length) {
			const bytes = outbox[0]!;
			const written = socket.write(bytes);
			if (written < 0) return;
			if (written < bytes.length) {
				outbox[0] = bytes.subarray(written);
				return;
			}
			outbox.shift();
		}
	}
	function send(bytes: Uint8Array) {
		if (done) return;
		outbox.push(bytes);
		flush();
	}
	const packetId = () => {
		const id = nextId;
		nextId = nextId >= 0xffff ? 1 : nextId + 1;
		return id;
	};
	const greet = () =>
		send(
			connectPacket({
				clientId: `sidedisplay-${Bun.randomUUIDv7().slice(-12)}`,
				username: to.username,
				password: to.password,
				keepAlive: KEEP_ALIVE_SECONDS,
			}),
		);

	function receive(chunk: Uint8Array) {
		awaitingPong = false;
		for (const received of reader.push(chunk)) {
			switch (received.type) {
				case PacketType.CONNACK: {
					const code = received.body[1] ?? 0;
					if (code !== 0) return finish(CONNACK_REFUSALS[code] ?? `the broker refused the connection (${code})`);
					ready = true;
					clearTimeout(deadline);
					keepAlive = setInterval(() => {
						if (awaitingPong) return finish("the broker stopped answering");
						awaitingPong = true;
						send(pingPacket());
					}, KEEP_ALIVE_SECONDS * 1000);
					handlers.onReady();
					break;
				}
				case PacketType.PUBLISH: {
					const message = readPublish(received);
					// We only ask for QoS 0, but a broker that insists gets its acknowledgement.
					if (message.qos === 1 && message.id !== null) send(pubackPacket(message.id));
					handlers.onMessage(message.topic, message.payload);
					break;
				}
				case PacketType.SUBACK: {
					const id = ((received.body[0] ?? 0) << 8) | (received.body[1] ?? 0);
					const asked = awaitingSuback.get(id) ?? [];
					awaitingSuback.delete(id);
					const refused = asked.filter((_, i) => received.body[2 + i] === 0x80);
					if (refused.length) handlers.onRefused(refused);
					break;
				}
			}
		}
	}

	Bun.connect({
		hostname: to.host,
		port: to.port,
		tls: to.tls,
		socket: {
			open(opened) {
				if (done) {
					opened.end();
					return;
				}
				socket = opened;
				// With TLS the greeting waits for the handshake.
				if (!to.tls) greet();
			},
			handshake(_, success, error) {
				if (!to.tls) return;
				if (success && !error) greet();
				else finish(`the broker's certificate was not accepted${error ? `: ${error.message}` : ""}`);
			},
			data(_, chunk) {
				try {
					receive(chunk);
				} catch (err) {
					finish((err as Error).message);
				}
			},
			drain: flush,
			close: () => finish("connection closed"),
			end: () => finish("the broker closed the connection"),
			error: (_, error) => finish(error.message),
			connectError: (_, error) => finish(`could not reach ${to.host}:${to.port}: ${error.message}`),
			timeout: () => finish("connection timed out"),
		},
	}).catch((error: Error) => finish(`could not reach ${to.host}:${to.port}: ${error.message}`));

	// A SUBSCRIBE packet carries several topics; keep each one comfortably small.
	const batches = (topics: string[]) => {
		const out: string[][] = [];
		for (let i = 0; i < topics.length; i += 50) out.push(topics.slice(i, i + 50));
		return out;
	};
	return {
		subscribe(topics) {
			if (!ready) return;
			for (const batch of batches(topics)) {
				const id = packetId();
				awaitingSuback.set(id, batch);
				send(subscribePacket(id, batch));
			}
		},
		unsubscribe(topics) {
			if (!ready) return;
			for (const batch of batches(topics)) send(unsubscribePacket(packetId(), batch));
		},
		close: () => finish(null),
	};
}

// --------------------------------------------------------------- live state

interface Topic {
	/** The last message, as text; null until one arrives. */
	payload: string | null;
	/** When the payload last became different. */
	changedAt: number;
	/** When a message last arrived, changed or not: what "no news for a while" is measured from. */
	receivedAt: number;
	/** When screens were last told about this topic. */
	toldAt: number;
	readAt: number;
	subscribedAt: number;
	refused: boolean;
	waiters: Set<() => void>;
}

/** The editor can ask for any topic; the least recently shown ones make room. */
const MAX_TOPICS = 500;
/** How long a first read waits for the broker's retained message. */
const FIRST_MESSAGE_MS = 1500;
/** How often, at most, screens are told that a topic repeated its value. */
const REPEAT_NOTICE_MS = 30_000;

const topics = new Map<string, Topic>();
const decoder = new TextDecoder();
let session: Session | null = null;
let current: Broker | null = null;
let connected = false;
let lastError: string | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 2000;
let generation = 0;

let onChange: (keys: string[]) => void = () => {};
/** Registers the listener told which topics changed, as `mqttKey`s (batched). */
export const onTopicsChanged = (listener: typeof onChange) => {
	onChange = listener;
};

const pending = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function queueChange(topic: string) {
	pending.add(mqttKey(topic));
	if (flushTimer) return;
	// A sensor publishing many times a second still refreshes screens a few times a second at most.
	flushTimer = setTimeout(() => {
		flushTimer = null;
		const keys = [...pending];
		pending.clear();
		onChange(keys);
	}, 300);
}

async function connect() {
	const mine = ++generation;
	let to: Broker | null;
	try {
		to = await broker();
	} catch (err) {
		// A bad address will not get better by retrying.
		lastError = (err as Error).message;
		return;
	}
	if (mine !== generation) return;
	current = to;
	if (!to) {
		if (config.ha.supervisorToken) {
			// No broker in Home Assistant (yet): MQTT counts as not set up, but one
			// installed later is picked up without a restart.
			supervisorHasNone = true;
			retryTimer = setTimeout(connect, 60_000);
		}
		return;
	}
	supervisorHasNone = false;
	const opened = openSession(to, {
		onReady() {
			if (mine !== generation) return;
			connected = true;
			lastError = null;
			retryMs = 2000;
			const now = Date.now();
			for (const topic of topics.values()) {
				topic.subscribedAt = now;
				topic.refused = false;
			}
			opened.subscribe([...topics.keys()]);
		},
		onMessage(name, payload) {
			const topic = mine === generation ? topics.get(name) : undefined;
			if (!topic) return;
			const value = decoder.decode(payload);
			const now = Date.now();
			topic.receivedAt = now;
			if (value !== topic.payload) {
				topic.payload = value;
				topic.changedAt = now;
				topic.toldAt = now;
				queueChange(name);
			} else if (now - topic.toldAt > REPEAT_NOTICE_MS) {
				// The same value again is still news to an element that warns about silent topics.
				topic.toldAt = now;
				queueChange(name);
			}
			for (const wake of topic.waiters) wake();
		},
		onRefused(names) {
			if (mine !== generation) return;
			for (const name of names) {
				const topic = topics.get(name);
				if (!topic) continue;
				topic.refused = true;
				for (const wake of topic.waiters) wake();
			}
		},
		onClose(reason) {
			if (mine !== generation) return;
			connected = false;
			session = null;
			lastError = reason;
			if (retryTimer) clearTimeout(retryTimer);
			retryTimer = setTimeout(connect, retryMs);
			retryMs = Math.min(retryMs * 2, 60_000);
		},
	});
	session = opened;
}

/** (Re)starts the connection: at boot, and whenever the settings change. */
export function startMqtt() {
	stopMqtt();
	lastError = null;
	retryMs = 2000;
	void connect();
}

export function stopMqtt() {
	generation++;
	if (retryTimer) clearTimeout(retryTimer);
	retryTimer = null;
	session?.close();
	session = null;
	current = null;
	connected = false;
	for (const topic of topics.values()) for (const wake of topic.waiters) wake();
	topics.clear();
}

export function mqttStatus(): MqttStatus {
	const source = brokerSource();
	return {
		source,
		connected,
		broker: current ? `${current.host}:${current.port}` : null,
		error: source !== "none" && !connected ? lastError : null,
		topics: topics.size,
	};
}

export interface TopicMessage {
	payload: string;
	/** When the payload last became different (ms). */
	changedAt: number;
	/** When a message last arrived, changed or not (ms). */
	receivedAt: number;
}

/**
 * The last message of a topic, subscribing to it on first use. The first read
 * waits a moment, so a retained message is there at once; null means nothing
 * has been published yet.
 */
export async function topicMessage(name: string): Promise<TopicMessage | null> {
	if (brokerSource() === "none") throw new MqttError("MQTT is not set up (see Settings)");
	if (/[+#]/.test(name)) throw new MqttError("wildcards (+ and #) are not supported: enter one topic");
	let topic = topics.get(name);
	const now = Date.now();
	if (!topic) {
		if (topics.size >= MAX_TOPICS) {
			const [oldest] = [...topics].sort(([, a], [, b]) => a.readAt - b.readAt)[0]!;
			topics.delete(oldest);
			session?.unsubscribe([oldest]);
		}
		topic = {
			payload: null,
			changedAt: 0,
			receivedAt: 0,
			toldAt: 0,
			readAt: now,
			subscribedAt: now,
			refused: false,
			waiters: new Set(),
		};
		topics.set(name, topic);
		session?.subscribe([name]);
	}
	topic.readAt = now;
	const wait = topic.subscribedAt + FIRST_MESSAGE_MS - now;
	if (topic.payload === null && !topic.refused && connected && wait > 0) {
		const waiting = topic;
		await new Promise<void>((resolve) => {
			const wake = () => {
				clearTimeout(timer);
				waiting.waiters.delete(wake);
				resolve();
			};
			const timer = setTimeout(wake, wait);
			waiting.waiters.add(wake);
		});
	}
	if (topic.refused) throw new MqttError(`the broker does not allow reading ${name}`);
	return topic.payload === null
		? null
		: { payload: topic.payload, changedAt: topic.changedAt, receivedAt: topic.receivedAt };
}

/**
 * Picks a value out of a message. Without a path it is the message itself;
 * with one (`temperature`, `sensors.0.value`, `rooms[2].name`) the message is
 * read as JSON.
 */
export function messageValue(payload: string, path: string): string {
	const keys = path
		.replace(/\[(\w+)\]/g, ".$1")
		.split(".")
		.map((key) => key.trim())
		.filter(Boolean);
	if (!keys.length) return payload.trim();
	let value: unknown;
	try {
		value = JSON.parse(payload);
	} catch {
		throw new MqttError("the message is not JSON, so nothing can be picked out of it");
	}
	for (const key of keys) {
		if (value === null || typeof value !== "object" || !(key in value))
			throw new MqttError(`"${path.trim()}" is not in the message`);
		value = (value as Record<string, unknown>)[key];
	}
	if (value === null || value === undefined) return "unknown";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Checks broker settings without touching the live connection. */
export function testBroker(url: string, username: string, password: string): Promise<{ ok: boolean; message: string }> {
	return new Promise((resolve) => {
		let to: Broker;
		try {
			const parsed = parseBrokerUrl(url);
			to = {
				...parsed,
				source: "settings",
				username: username || parsed.username,
				password: password || parsed.password,
			};
		} catch (err) {
			return resolve({ ok: false, message: (err as Error).message });
		}
		const probe = openSession(to, {
			onReady() {
				probe.close();
				resolve({ ok: true, message: `Connected to the broker at ${to.host}:${to.port}.` });
			},
			onMessage() {},
			onRefused() {},
			onClose: (reason) => resolve({ ok: false, message: `${reason[0]!.toUpperCase()}${reason.slice(1)}.` }),
		});
	});
}
