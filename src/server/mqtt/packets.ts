/**
 * The few MQTT 3.1.1 packets SideDisplay needs, as bytes. It only ever
 * listens (subscriptions at QoS 0), so this is a small part of the protocol:
 * enough to connect, subscribe, stay alive and read what is published.
 */

export const PacketType = {
	CONNECT: 1,
	CONNACK: 2,
	PUBLISH: 3,
	PUBACK: 4,
	SUBSCRIBE: 8,
	SUBACK: 9,
	UNSUBSCRIBE: 10,
	UNSUBACK: 11,
	PINGREQ: 12,
	PINGRESP: 13,
	DISCONNECT: 14,
} as const;

/** Larger packets are skipped, not buffered: a screen has no use for them. */
export const MAX_PACKET_BYTES = 256 * 1024;

export interface Packet {
	type: number;
	flags: number;
	body: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Part = Uint8Array | number[];

/** A length-prefixed UTF-8 string, as the protocol writes every string. */
export function text(value: string): Uint8Array {
	const bytes = encoder.encode(value);
	if (bytes.length > 0xffff) throw new Error("string too long for MQTT");
	const out = new Uint8Array(bytes.length + 2);
	out[0] = bytes.length >> 8;
	out[1] = bytes.length & 0xff;
	out.set(bytes, 2);
	return out;
}

export const uint16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];

/** Assembles a packet: fixed header, "remaining length" varint, then the parts. */
export function packet(type: number, flags: number, ...parts: Part[]): Uint8Array {
	let length = 0;
	for (const part of parts) length += part.length;
	const header = [(type << 4) | flags];
	let rest = length;
	do {
		const byte = rest % 128;
		rest = Math.floor(rest / 128);
		header.push(rest > 0 ? byte | 0x80 : byte);
	} while (rest > 0);
	const out = new Uint8Array(header.length + length);
	out.set(header);
	let offset = header.length;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function connectPacket(options: {
	clientId: string;
	username?: string;
	password?: string;
	keepAlive: number;
}): Uint8Array {
	// Clean session: nothing is queued for us while we are away.
	let flags = 0x02;
	const payload: Part[] = [text(options.clientId)];
	if (options.username) {
		flags |= 0x80;
		payload.push(text(options.username));
		// The protocol only allows a password next to a user name.
		if (options.password) {
			flags |= 0x40;
			payload.push(text(options.password));
		}
	}
	return packet(PacketType.CONNECT, 0, text("MQTT"), [4, flags], uint16(options.keepAlive), ...payload);
}

export const subscribePacket = (id: number, topics: string[]): Uint8Array =>
	packet(PacketType.SUBSCRIBE, 0b0010, uint16(id), ...topics.flatMap((topic) => [text(topic), [0]]));

export const unsubscribePacket = (id: number, topics: string[]): Uint8Array =>
	packet(PacketType.UNSUBSCRIBE, 0b0010, uint16(id), ...topics.map(text));

export const pingPacket = (): Uint8Array => packet(PacketType.PINGREQ, 0);
export const disconnectPacket = (): Uint8Array => packet(PacketType.DISCONNECT, 0);
export const pubackPacket = (id: number): Uint8Array => packet(PacketType.PUBACK, 0, uint16(id));

export interface Publication {
	topic: string;
	payload: Uint8Array;
	qos: number;
	retain: boolean;
	/** Only present above QoS 0. */
	id: number | null;
}

export function readPublish(received: Packet): Publication {
	const { body, flags } = received;
	const qos = (flags >> 1) & 0b11;
	const topicEnd = 2 + (((body[0] ?? 0) << 8) | (body[1] ?? 0));
	const payloadStart = topicEnd + (qos > 0 ? 2 : 0);
	if (body.length < 2 || payloadStart > body.length) throw new Error("malformed MQTT message");
	return {
		topic: decoder.decode(body.subarray(2, topicEnd)),
		payload: body.subarray(payloadStart),
		qos,
		retain: (flags & 1) === 1,
		id: qos > 0 ? (body[topicEnd]! << 8) | body[topicEnd + 1]! : null,
	};
}

/** Cuts a byte stream back into packets, whatever way the network chunked it. */
export class PacketReader {
	private pending: Uint8Array = new Uint8Array(0);
	/** Bytes of an oversized packet still to let pass. */
	private skip = 0;

	/** The packets completed by this chunk. Their bodies are only valid until the next call. */
	push(chunk: Uint8Array): Packet[] {
		let data = chunk;
		if (this.skip) {
			const skipped = Math.min(this.skip, data.length);
			this.skip -= skipped;
			data = data.subarray(skipped);
		}
		if (this.pending.length) {
			const joined = new Uint8Array(this.pending.length + data.length);
			joined.set(this.pending);
			joined.set(data, this.pending.length);
			data = joined;
		}
		const packets: Packet[] = [];
		let offset = 0;
		while (data.length - offset >= 2) {
			// Remaining length: 7 bits per byte, least significant first, at most 4 bytes.
			let length = 0;
			let size = 0;
			let complete = false;
			while (offset + 1 + size < data.length) {
				const byte = data[offset + 1 + size]!;
				length += (byte & 0x7f) * 128 ** size;
				size++;
				if (!(byte & 0x80)) {
					complete = true;
					break;
				}
				if (size === 4) throw new Error("malformed MQTT packet");
			}
			if (!complete) break;
			const start = offset + 1 + size;
			if (length > MAX_PACKET_BYTES) {
				const available = data.length - start;
				if (available < length) this.skip = length - available;
				offset = Math.min(data.length, start + length);
				continue;
			}
			if (data.length - start < length) break;
			packets.push({
				type: data[offset]! >> 4,
				flags: data[offset]! & 0x0f,
				body: data.subarray(start, start + length),
			});
			offset = start + length;
		}
		// Copied: the chunk belongs to the socket and is reused.
		this.pending = new Uint8Array(data.subarray(offset));
		return packets;
	}
}
