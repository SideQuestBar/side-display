/**
 * A stand-in for an MQTT broker: just enough of MQTT 3.1.1 for SideDisplay to
 * connect, subscribe and receive messages (QoS 0, retained messages, optional
 * user name and password, topics it refuses to hand out).
 */
import type { Socket } from "bun";
import { PacketReader, PacketType, packet, text, uint16 } from "../src/server/mqtt/packets";

interface Client {
	reader: PacketReader;
	accepted: boolean;
	subscriptions: Set<string>;
}

export interface FakeMqtt {
	url: string;
	port: number;
	/** Publishes to the subscribers of `topic`; retained messages also greet later subscribers. */
	publish: (topic: string, payload: string, retain?: boolean) => void;
	/** Topics currently subscribed to by anyone. */
	subscriptions: () => string[];
	/** Cuts every connection, as a restarting broker does. */
	dropClients: () => void;
	stop: () => void;
}

export function startFakeMqtt(options: { username?: string; password?: string; deny?: string[] } = {}): FakeMqtt {
	const decoder = new TextDecoder();
	const clients = new Set<Socket<Client>>();
	const retained = new Map<string, string>();
	const message = (topic: string, payload: string, retain: boolean) =>
		packet(PacketType.PUBLISH, retain ? 1 : 0, text(topic), new TextEncoder().encode(payload));

	/** Reads the length-prefixed strings of a packet body from `offset` on. */
	const strings = (body: Uint8Array, start: number): string[] => {
		const out: string[] = [];
		let offset = start;
		while (offset + 2 <= body.length) {
			const length = (body[offset]! << 8) | body[offset + 1]!;
			out.push(decoder.decode(body.subarray(offset + 2, offset + 2 + length)));
			offset += 2 + length;
		}
		return out;
	};

	const server = Bun.listen<Client>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { reader: new PacketReader(), accepted: false, subscriptions: new Set() };
				clients.add(socket);
			},
			close(socket) {
				clients.delete(socket);
			},
			data(socket, chunk) {
				for (const received of socket.data.reader.push(chunk)) {
					const { body } = received;
					switch (received.type) {
						case PacketType.CONNECT: {
							// "MQTT" (6 bytes), level, flags, keep-alive (2), then client id, user name, password.
							const flags = body[7]!;
							const [, username = "", password = ""] = strings(body, 10);
							const refused =
								options.username !== undefined &&
								(!(flags & 0x80) || username !== options.username || password !== (options.password ?? ""));
							socket.write(packet(PacketType.CONNACK, 0, [0, refused ? 4 : 0]));
							if (refused) socket.end();
							else socket.data.accepted = true;
							break;
						}
						case PacketType.SUBSCRIBE: {
							if (!socket.data.accepted) break;
							const topics: string[] = [];
							let offset = 2;
							while (offset + 2 <= body.length) {
								const length = (body[offset]! << 8) | body[offset + 1]!;
								topics.push(decoder.decode(body.subarray(offset + 2, offset + 2 + length)));
								offset += 2 + length + 1; // + the requested QoS
							}
							const granted = topics.map((topic) => (options.deny?.includes(topic) ? 0x80 : 0));
							socket.write(packet(PacketType.SUBACK, 0, [body[0]!, body[1]!], granted));
							topics.forEach((topic, i) => {
								if (granted[i] !== 0) return;
								socket.data.subscriptions.add(topic);
								const last = retained.get(topic);
								if (last !== undefined) socket.write(message(topic, last, true));
							});
							break;
						}
						case PacketType.UNSUBSCRIBE:
							for (const topic of strings(body, 2)) socket.data.subscriptions.delete(topic);
							socket.write(packet(PacketType.UNSUBACK, 0, uint16((body[0]! << 8) | body[1]!)));
							break;
						case PacketType.PINGREQ:
							socket.write(packet(PacketType.PINGRESP, 0));
							break;
						case PacketType.DISCONNECT:
							socket.end();
							break;
					}
				}
			},
		},
	});

	return {
		url: `mqtt://127.0.0.1:${server.port}`,
		port: server.port,
		publish(topic, payload, retain = false) {
			if (retain) retained.set(topic, payload);
			for (const client of clients)
				if (client.data.subscriptions.has(topic)) client.write(message(topic, payload, false));
		},
		subscriptions: () => [...new Set([...clients].flatMap((client) => [...client.data.subscriptions]))],
		dropClients() {
			for (const client of clients) client.end();
		},
		stop: () => server.stop(true),
	};
}
