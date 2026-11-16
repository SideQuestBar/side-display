/**
 * bun test preload: points the server modules at a fresh temporary data
 * directory (so tests never touch `./data`) and creates the database there.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SIDEDISPLAY_DATA_DIR = mkdtempSync(join(tmpdir(), "sidedisplay-test-"));
delete process.env.SIDEDISPLAY_PASSWORD;
delete process.env.SIDEDISPLAY_HA_URL;
delete process.env.SIDEDISPLAY_HA_TOKEN;
delete process.env.SIDEDISPLAY_MQTT_URL;
delete process.env.SIDEDISPLAY_MQTT_USERNAME;
delete process.env.SIDEDISPLAY_MQTT_PASSWORD;
delete process.env.SUPERVISOR_TOKEN;

const { runMigrations } = await import("../src/server/db");
runMigrations();
