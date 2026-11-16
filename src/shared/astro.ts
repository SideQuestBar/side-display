/**
 * Sunrise, sunset and the phase of the moon, computed on the spot from the
 * usual low-precision formulas (NOAA's solar calculator, the Astronomical
 * Almanac's lunar series). Good to about a minute for the sun below the polar
 * circles and to about an hour for the moon's phases, which is plenty for a
 * wall display and needs no network.
 */

const RAD = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);
const tan = (deg: number) => Math.tan(deg * RAD);
const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Julian centuries since J2000.0. */
const centuries = (ms: number) => (ms / 86_400_000 + 2440587.5 - 2451545) / 36525;

/** The sun's declination (degrees) and the equation of time (minutes) at an instant. */
function sunPosition(ms: number): { declination: number; equation: number } {
	const t = centuries(ms);
	const meanLongitude = wrap(280.46646 + t * (36000.76983 + t * 0.0003032));
	const anomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
	const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
	const centre =
		sin(anomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
		sin(2 * anomaly) * (0.019993 - 0.000101 * t) +
		sin(3 * anomaly) * 0.000289;
	const omega = 125.04 - 1934.136 * t;
	const longitude = meanLongitude + centre - 0.00569 - 0.00478 * sin(omega);
	const obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * cos(omega);
	const declination = Math.asin(sin(obliquity) * sin(longitude)) / RAD;
	const y = tan(obliquity / 2) ** 2;
	const equation =
		(4 / RAD) *
		(y * sin(2 * meanLongitude) -
			2 * eccentricity * sin(anomaly) +
			4 * eccentricity * y * sin(anomaly) * cos(2 * meanLongitude) -
			0.5 * y * y * sin(4 * meanLongitude) -
			1.25 * eccentricity * eccentricity * sin(2 * anomaly));
	return { declination, equation };
}

export interface SunTimes {
	/** Instants (ms); null on a day the sun does not rise or set. */
	rise: number | null;
	set: number | null;
	/** Solar noon. */
	noon: number;
	/** Minutes of daylight: 0 in the polar night, 1440 under the midnight sun. */
	dayLength: number;
	polar: "day" | "night" | null;
}

/**
 * The sun's times on a calendar date (`YYYY-MM-DD`, as the clocks at the place
 * show it). Longitude is positive to the east. Sunrise and sunset are when the
 * upper edge of the sun touches the horizon, refraction included (−0.833°).
 */
export function sunTimes(date: string, latitude: number, longitude: number): SunTimes {
	const midnight = Date.parse(`${date}T00:00:00Z`);
	// Local mean noon as a first guess, then once more with the position at the result.
	let noonMinutes = 720 - 4 * longitude;
	let position = sunPosition(midnight + noonMinutes * 60_000);
	noonMinutes = 720 - 4 * longitude - position.equation;
	const noon = midnight + noonMinutes * 60_000;
	const event = (direction: -1 | 1): number | null => {
		let minutes = noonMinutes;
		// The declination moves during the day: refine at the event itself.
		for (let i = 0; i < 2; i++) {
			const x = cos(90.833) / (cos(latitude) * cos(position.declination)) - tan(latitude) * tan(position.declination);
			if (x < -1 || x > 1) return null;
			const hourAngle = Math.acos(x) / RAD;
			minutes = 720 - 4 * longitude - position.equation + direction * 4 * hourAngle;
			position = sunPosition(midnight + minutes * 60_000);
		}
		return midnight + minutes * 60_000;
	};
	const atNoon = sunPosition(noon);
	position = atNoon;
	const rise = event(-1);
	position = atNoon;
	const set = event(1);
	if (rise === null || set === null) {
		// Which side of the horizon the sun stays on: its altitude at noon.
		const altitude = 90 - Math.abs(latitude - atNoon.declination);
		const up = altitude > -0.833;
		return { rise: null, set: null, noon, dayLength: up ? 1440 : 0, polar: up ? "day" : "night" };
	}
	return { rise, set, noon, dayLength: (set - rise) / 60_000, polar: null };
}

export type MoonPhaseName =
	| "new"
	| "waxing-crescent"
	| "first-quarter"
	| "waxing-gibbous"
	| "full"
	| "waning-gibbous"
	| "last-quarter"
	| "waning-crescent";

export interface MoonPhase {
	/** 0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter. */
	phase: number;
	/** Lit fraction of the disc, 0 to 1. */
	illumination: number;
	name: MoonPhaseName;
}

/** The moon's phase at an instant, from the angle between the moon and the sun. */
export function moonPhase(ms: number): MoonPhase {
	const t = centuries(ms);
	const moon =
		218.32 +
		481267.881 * t +
		6.29 * sin(135.0 + 477198.87 * t) -
		1.27 * sin(259.3 - 413335.36 * t) +
		0.66 * sin(235.7 + 890534.22 * t) +
		0.21 * sin(269.9 + 954397.74 * t) -
		0.19 * sin(357.5 + 35999.05 * t) -
		0.11 * sin(186.5 + 966404.03 * t);
	const anomaly = 357.528 + 35999.05 * t;
	const sun = 280.46 + 36000.771 * t + 1.915 * sin(anomaly) + 0.02 * sin(2 * anomaly);
	const elongation = wrap(moon - sun);
	const phase = elongation / 360;
	return { phase, illumination: (1 - cos(elongation)) / 2, name: moonPhaseName(phase) };
}

const PHASES: MoonPhaseName[] = [
	"new",
	"waxing-crescent",
	"first-quarter",
	"waxing-gibbous",
	"full",
	"waning-gibbous",
	"last-quarter",
	"waning-crescent",
];

/**
 * The name of a phase. The four principal phases are instants, so each gets a
 * narrow window (about a day and a half) and the rest belongs to the phases between.
 */
export function moonPhaseName(phase: number): MoonPhaseName {
	const p = ((phase % 1) + 1) % 1;
	const nearest = Math.round(p * 4) / 4;
	if (Math.abs(p - nearest) < 0.025) return PHASES[(nearest * 8) % 8]!;
	return PHASES[Math.floor(p * 4) * 2 + 1]!;
}

/**
 * The lit part of the moon as an SVG path on a disc of radius `r` centred on
 * 0,0. In the northern hemisphere the waxing moon is lit on the right; seen
 * from the south it is the other way round.
 */
export function moonPath(phase: number, r: number, southern = false): string {
	const p = ((phase % 1) + 1) % 1;
	const k = Math.cos(2 * Math.PI * p);
	const waxing = p < 0.5;
	// The lit limb is a half circle; the terminator is half an ellipse that
	// bulges towards the limb for a crescent and away from it when gibbous.
	const rx = (Math.abs(k) * r).toFixed(3);
	const right = waxing !== southern;
	const limb = right ? 1 : 0;
	const terminator = k > 0 ? 1 - limb : limb;
	return `M0 ${-r}A${r} ${r} 0 0 ${limb} 0 ${r}A${rx} ${r} 0 0 ${terminator} 0 ${-r}Z`;
}
