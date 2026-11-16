/**
 * SideDisplay: process entry.
 * Boot order: database migrations → password from the environment (if any) →
 * Home Assistant and MQTT connections → HTTP server.
 */
import { app } from "./app";
import { applyConfiguredPassword, hasPassword } from "./auth";
import { config } from "./config";
import { closeDb, runMigrations } from "./db";
import { haStatus, onEntitiesChanged, startHa, stopHa } from "./ha/client";
import { mqttStatus, onTopicsChanged, startMqtt, stopMqtt } from "./mqtt/client";
import { notifyEntities } from "./store";

runMigrations();
await applyConfiguredPassword();

onEntitiesChanged(notifyEntities);
startHa();
// Topics travel to the screens as entities do (see `mqttKey`).
onTopicsChanged(notifyEntities);
startMqtt();

app.listen({
	hostname: config.host,
	port: config.port,
	maxRequestBodySize: config.maxUploadBytes,
	// Live streams stay open for days; the 15 s heartbeat keeps them well under this.
	idleTimeout: 120,
});

console.log(
	`SideDisplay ${config.version} listening on http://${config.host}:${config.port} (data in ${config.dataDir})`,
);
if (!hasPassword()) console.log("No password set yet: open the address above to choose one.");
if (haStatus().source !== "none") console.log(`Home Assistant: using the connection from ${haStatus().source}.`);
if (mqttStatus().source !== "none") console.log(`MQTT: using the broker from ${mqttStatus().source}.`);

let stopping = false;
async function shutdown() {
	if (stopping) return;
	stopping = true;
	stopHa();
	stopMqtt();
	// `true` also closes open live streams, which would otherwise hold the server up.
	await app.stop(true);
	closeDb();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// An unattended service should log a stray rejection, not die of it.
process.on("unhandledRejection", (reason) => console.error("[unhandled rejection]", reason));
