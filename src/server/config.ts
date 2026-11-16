/**
 * Runtime configuration, read once from the environment.
 * Every variable is optional; see `.env.example`.
 */
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../../package.json";

const env = process.env;
const root = resolve(import.meta.dir, "../..");
const dataDir = resolve(env.SIDEDISPLAY_DATA_DIR ?? join(root, "data"));
const mediaDir = join(dataDir, "media");
mkdirSync(mediaDir, { recursive: true });

export const config = {
	version: pkg.version,
	dev: env.SIDEDISPLAY_DEV === "1",
	host: env.SIDEDISPLAY_HOST ?? "0.0.0.0",
	port: Number(env.SIDEDISPLAY_PORT ?? env.PORT ?? 4380),
	root,
	dataDir,
	mediaDir,
	dbPath: join(dataDir, "sidedisplay.db"),
	clientDir: resolve(env.SIDEDISPLAY_CLIENT_DIR ?? join(root, "dist/client")),
	migrationsDir: join(root, "drizzle"),
	/** Sets (and keeps resetting) the admin password, for hands-off deployments. */
	password: env.SIDEDISPLAY_PASSWORD || null,
	maxUploadBytes: Number(env.SIDEDISPLAY_MAX_UPLOAD_MB ?? 500) * 1024 * 1024,
	ha: {
		url: env.SIDEDISPLAY_HA_URL || null,
		token: env.SIDEDISPLAY_HA_TOKEN || null,
		/** Present when running as a Home Assistant app: grants API access without a token of our own. */
		supervisorToken: env.SUPERVISOR_TOKEN || null,
	},
	mqtt: {
		url: env.SIDEDISPLAY_MQTT_URL || null,
		username: env.SIDEDISPLAY_MQTT_USERNAME || null,
		password: env.SIDEDISPLAY_MQTT_PASSWORD || null,
	},
	/** Requests arriving through Home Assistant's ingress are already authenticated by it. */
	trustIngress: env.SIDEDISPLAY_TRUST_INGRESS ? env.SIDEDISPLAY_TRUST_INGRESS === "1" : Boolean(env.SUPERVISOR_TOKEN),
};
