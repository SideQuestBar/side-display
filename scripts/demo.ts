/**
 * `bun run demo`: SideDisplay with sample content and a simulated Home
 * Assistant, in a throwaway data directory. Nothing here touches `./data`.
 *
 *   password: sidedisplay
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_TOKEN, startFakeHa } from "../test/fake-ha";
import { build } from "./build";

const home = startFakeHa(Number(process.env.SIDEDISPLAY_DEMO_HA_PORT ?? 0));
process.env.SIDEDISPLAY_DATA_DIR ??= mkdtempSync(join(tmpdir(), "sidedisplay-demo-"));
process.env.SIDEDISPLAY_HA_URL = home.url;
process.env.SIDEDISPLAY_HA_TOKEN = FAKE_TOKEN;
process.env.SIDEDISPLAY_PASSWORD ??= "sidedisplay";

if (!(await Bun.file(join(import.meta.dir, "../dist/client/index.html")).exists())) await build();

// Imported only now: the server reads its configuration from the environment as it loads.
const { runMigrations } = await import("../src/server/db");
runMigrations();
const { seedDemo } = await import("./demo-content");
await seedDemo(home.url);
await import("../src/server/index");

// A little life: the simulated house changes every few seconds.
setInterval(() => {
	home.setState("sensor.power_consumption", String(Math.round(350 + Math.random() * 500)));
	home.setState("sensor.living_room_temperature", (21 + Math.random()).toFixed(1));
}, 5000);

console.log(`\nDemo ready. Sign in with the password "${process.env.SIDEDISPLAY_PASSWORD}".`);
