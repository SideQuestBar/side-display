/**
 * The pure logic behind the text and gallery options: placeholders in a text,
 * and the capture date of a JPEG.
 */
import { describe, expect, test } from "bun:test";
import { exifDate } from "../src/server/data/exif";
import { entitiesOf, makeElement, needsData } from "../src/shared/layout";
import { fillPlaceholders, hasClockPlaceholder, placeholderEntities } from "../src/shared/placeholders";

describe("text placeholders", () => {
	const values = {
		time: () => "16:30",
		date: () => "Monday 16 November",
		entity: (id: string) => (id === "sensor.living_room" ? "21.4 °C" : "–"),
	};

	test("time, date and entities are filled in; other braces are left alone", () => {
		expect(fillPlaceholders("It is {time} on {date}.", values)).toBe("It is 16:30 on Monday 16 November.");
		expect(fillPlaceholders("**{entity:sensor.living_room}** inside", values)).toBe("**21.4 °C** inside");
		expect(fillPlaceholders("{ TIME } {Entity: Sensor.Living_Room } {entity:sensor.nope}", values)).toBe(
			"16:30 21.4 °C –",
		);
		expect(fillPlaceholders("{name} {entity:} {entity:nodomain} {}", values)).toBe(
			"{name} {entity:} {entity:nodomain} {}",
		);
		expect(fillPlaceholders("no braces", values)).toBe("no braces");
	});

	test("the entities a text names, once each", () => {
		expect(placeholderEntities("{entity:sensor.a} {time} {entity:light.b_2} {entity:SENSOR.A}")).toEqual([
			"sensor.a",
			"light.b_2",
		]);
		expect(placeholderEntities("Hello {time}")).toEqual([]);
		expect(placeholderEntities(undefined)).toEqual([]);
		expect(hasClockPlaceholder("at {time}")).toBe(true);
		expect(hasClockPlaceholder("{date}")).toBe(true);
		expect(hasClockPlaceholder("{entity:sensor.a} {clock}")).toBe(false);
	});

	test("a text only asks the server when it names an entity, and is told when it changes", () => {
		const plain = makeElement("text", { text: "Hello {time}" });
		expect(needsData(plain)).toBe(false);
		expect(entitiesOf(plain)).toEqual([]);
		const live = makeElement("text", { text: "{entity:sensor.living_room} and {entity:sensor.outside}" });
		expect(needsData(live)).toBe(true);
		expect(entitiesOf(live)).toEqual(["sensor.living_room", "sensor.outside"]);
		// The visibility condition still counts on its own.
		expect(needsData(makeElement("text", { showEntity: "binary_sensor.door" }))).toBe(true);
	});
});

/** An APP1 segment holding IFD0 → Exif IFD → one date tag, in either byte order. */
function exifSegment(date: string, tag = 0x9003, little = true): Uint8Array {
	const text = new TextEncoder().encode(`${date}\0`);
	const exifIfd = 8 + 2 + 12 + 4;
	const textAt = exifIfd + 2 + 12 + 4;
	const tiff = new Uint8Array(textAt + text.length);
	const view = new DataView(tiff.buffer);
	tiff.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
	view.setUint16(2, 42, little);
	view.setUint32(4, 8, little);
	const entry = (at: number, id: number, type: number, count: number, value: number) => {
		view.setUint16(at, id, little);
		view.setUint16(at + 2, type, little);
		view.setUint32(at + 4, count, little);
		view.setUint32(at + 8, value, little);
	};
	view.setUint16(8, 1, little);
	entry(10, 0x8769, 4, 1, exifIfd);
	view.setUint16(exifIfd, 1, little);
	entry(exifIfd + 2, tag, 2, text.length, textAt);
	tiff.set(text, textAt);
	return segment(0xe1, new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]));
}
function segment(marker: number, body: Uint8Array): Uint8Array {
	const length = body.length + 2;
	return new Uint8Array([0xff, marker, length >> 8, length & 0xff, ...body]);
}
const jpeg = (...segments: Uint8Array[]) =>
	new Uint8Array([0xff, 0xd8, ...segments.flatMap((s) => [...s]), 0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);

describe("EXIF capture date", () => {
	test("reads DateTimeOriginal in both byte orders", () => {
		expect(exifDate(jpeg(exifSegment("2024:05:03 14:22:10")))).toBe("2024-05-03T14:22:10");
		expect(exifDate(jpeg(exifSegment("2019:12:31 23:59:59", 0x9003, false)))).toBe("2019-12-31T23:59:59");
	});

	test("finds the block after other segments, and falls back to the digitised date", () => {
		const jfif = segment(0xe0, new TextEncoder().encode("JFIF\0 padding"));
		const xmp = segment(0xe1, new TextEncoder().encode("http://ns.adobe.com/xap/1.0/\0<x/>"));
		expect(exifDate(jpeg(jfif, xmp, exifSegment("2021:07:04 09:00:00", 0x9004)))).toBe("2021-07-04T09:00:00");
	});

	test("no date is null, never an error", () => {
		expect(exifDate(jpeg())).toBeNull();
		expect(exifDate(jpeg(exifSegment("0000:00:00 00:00:00")))).toBeNull();
		expect(exifDate(jpeg(exifSegment("                   ")))).toBeNull();
		expect(exifDate(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))).toBeNull();
		expect(exifDate(new Uint8Array())).toBeNull();
		// Cut off in the middle of the block, as when only the start of a file is read.
		const whole = jpeg(exifSegment("2024:05:03 14:22:10"));
		for (let length = 0; length < 60; length += 7) expect(exifDate(whole.subarray(0, length))).toBeNull();
	});
});
