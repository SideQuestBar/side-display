import { describe, expect, test } from "bun:test";
import { overlayFeatures } from "../src/server/data/weather";
import {
	aqiBand,
	beaufort,
	convertWind,
	derivedAlerts,
	haAlerts,
	pollenBand,
	thin,
	windUnitOf,
} from "../src/shared/weather";

describe("weather arithmetic", () => {
	test("wind converts between the units the sources use", () => {
		expect(windUnitOf("km/h")).toBe("kmh");
		expect(windUnitOf("kt")).toBe("kn");
		expect(windUnitOf("furlongs")).toBeNull();
		expect(convertWind(36, "km/h", "ms")).toBeCloseTo(10);
		expect(convertWind(10, "m/s", "mph")).toBeCloseTo(22.37, 1);
		expect(convertWind(10, "m/s", "kn")).toBeCloseTo(19.44, 1);
		expect(convertWind(14, "km/h", "kmh")).toBe(14);
		// An unknown unit, and Beaufort as a source, cannot be converted.
		expect(convertWind(5, "furlongs", "ms")).toBeNull();
		expect(convertWind(5, "Beaufort", "kmh")).toBeNull();
	});

	test("Beaufort forces follow the scale", () => {
		expect(beaufort(0.2)).toBe(0);
		expect(beaufort(5.4)).toBe(3);
		expect(beaufort(5.5)).toBe(4);
		expect(beaufort(20)).toBe(8);
		expect(beaufort(40)).toBe(12);
		expect(convertWind(75, "km/h", "bft")).toBe(9);
	});

	test("air-quality bands differ between the European and the US scale", () => {
		expect(aqiBand("european", 42)).toMatchObject({ level: 2, label: "Moderate" });
		expect(aqiBand("european", 20)).toMatchObject({ level: 0, label: "Good" });
		expect(aqiBand("european", 250).label).toBe("Extremely poor");
		expect(aqiBand("us", 42).label).toBe("Good");
		expect(aqiBand("us", 151).label).toBe("Unhealthy");
		expect(aqiBand("us", 900).label).toBe("Hazardous");
	});

	test("pollen levels depend on the plant", () => {
		expect(pollenBand("grass", 0).label).toBe("None");
		expect(pollenBand("grass", 25).label).toBe("High");
		expect(pollenBand("birch", 25).label).toBe("Moderate");
		expect(pollenBand("ragweed", 600).label).toBe("Very high");
	});

	test("warnings are derived from today and tomorrow only, one per kind", () => {
		const calm = { gusts: 30, precipitation: 2, snowfall: 0, feelsMax: 20, feelsMin: 8, thunder: false };
		expect(derivedAlerts([calm, calm])).toEqual([]);
		expect(derivedAlerts([calm, calm, { ...calm, gusts: 120 }])).toEqual([]);
		expect(
			derivedAlerts([
				{ ...calm, gusts: 80 },
				{ ...calm, gusts: 110, precipitation: 40 },
			]),
		).toEqual([
			{ title: "Gale-force gusts today", derived: true },
			{ title: "Heavy rain tomorrow", derived: true },
		]);
		expect(derivedAlerts([{ ...calm, feelsMin: -20, snowfall: 15, precipitation: 40 }]).map((a) => a.title)).toEqual([
			"Heavy snow today",
			"Severe frost today",
		]);
		// Missing values are not zero degrees of frost.
		expect(
			derivedAlerts([
				{ gusts: null, precipitation: null, snowfall: null, feelsMax: null, feelsMin: null, thunder: false },
			]),
		).toEqual([]);
	});

	test("Home Assistant alert entities are read in their various shapes", () => {
		expect(haAlerts("off", { headline: "Old warning" })).toEqual([]);
		expect(haAlerts("unavailable", {})).toEqual([]);
		expect(haAlerts("on", { headline: "Orange wind warning", event: "Wind" })).toEqual([
			{ title: "Orange wind warning", derived: false },
		]);
		expect(
			haAlerts("2", { Alerts: [{ Event: "Flood Watch" }, { Headline: "Winter Storm Warning", Event: "x" }] }),
		).toEqual([
			{ title: "Flood Watch", derived: false },
			{ title: "Winter Storm Warning", derived: false },
		]);
		expect(haAlerts("on", {})).toEqual([{ title: "Weather alert", derived: false }]);
		expect(haAlerts("Storm warning", {})).toEqual([{ title: "Storm warning", derived: false }]);
	});

	test("a long path is thinned but keeps both ends", () => {
		const path = Array.from({ length: 1000 }, (_, i) => i);
		const short = thin(path, 50);
		expect(short).toHaveLength(50);
		expect(short[0]).toBe(0);
		expect(short.at(-1)).toBe(999);
		expect(thin([1, 2, 3], 50)).toEqual([1, 2, 3]);
	});

	test("a GeoJSON overlay is reduced to rounded geometries", () => {
		const collection = overlayFeatures({
			type: "FeatureCollection",
			features: [
				{
					type: "Feature",
					properties: { secret: "x" },
					geometry: { type: "Point", coordinates: [19.0402123456, 47.4979] },
				},
				{ type: "Feature", properties: {}, geometry: null },
				{ type: "Feature", geometry: { type: "Nonsense", coordinates: [] } },
			],
		});
		expect(collection.features).toEqual([
			{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [19.04021, 47.4979] } },
		]);
		expect(
			overlayFeatures({
				type: "LineString",
				coordinates: [
					[0, 0],
					[1, 1],
				],
			}).features,
		).toHaveLength(1);
		expect(() => overlayFeatures({ hello: "world" })).toThrow("GeoJSON");
		expect(() => overlayFeatures(null)).toThrow("GeoJSON");
	});
});
