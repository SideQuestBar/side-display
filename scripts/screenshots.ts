/**
 * `bun run screenshots`: regenerates the pictures in `docs/screenshots/` (and
 * the Home Assistant app's icon) from the demo content, with a headless
 * browser driven through `Bun.WebView`. Needs Chrome or Chromium installed.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_TOKEN, startFakeHa } from "../test/fake-ha";
import { build } from "./build";

const root = join(import.meta.dir, "..");
const out = join(root, "docs/screenshots");
mkdirSync(out, { recursive: true });

const PASSWORD = "sidedisplay";
const PORT = 4399;
const base = `http://127.0.0.1:${PORT}`;
/** Headless Chrome keeps this much of the requested height for itself. */
const CHROME = 87;

const home = startFakeHa();
process.env.SIDEDISPLAY_DATA_DIR = mkdtempSync(join(tmpdir(), "sidedisplay-shots-"));
process.env.SIDEDISPLAY_PORT = String(PORT);
process.env.SIDEDISPLAY_HOST = "127.0.0.1";
process.env.SIDEDISPLAY_HA_URL = home.url;
process.env.SIDEDISPLAY_HA_TOKEN = FAKE_TOKEN;
process.env.SIDEDISPLAY_PASSWORD = PASSWORD;

if (!(await build())) process.exit(1);
const { runMigrations } = await import("../src/server/db");
runMigrations();
const { seedDemo } = await import("./demo-content");
await seedDemo(home.url);
await import("../src/server/index");
const { listDisplays, listLayouts } = await import("../src/server/store");

const login = await fetch(`${base}/api/auth/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ password: PASSWORD }),
});
const session = /sd_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];

interface Shot {
	name: string;
	path: string;
	width?: number;
	height?: number;
	/** Signed in as the admin. */
	admin?: boolean;
	/** Script run in the page once it has loaded, e.g. to open a dialog. */
	script?: string;
	wait?: number;
}

async function shoot(shot: Shot) {
	const width = shot.width ?? 1440;
	const height = shot.height ?? 900;
	await using view = new Bun.WebView({ width, height: height + CHROME });
	// A page of the same origin first, so the cookie can be set (or cleared) before the real one loads.
	await view.navigate(`${base}/api/health`);
	await view.evaluate(
		shot.admin
			? `document.cookie = "sd_session=${session}; path=/"`
			: `document.cookie = "sd_session=; path=/; max-age=0"`,
	);
	await view.navigate(base + shot.path);
	await Bun.sleep(shot.wait ?? 2500);
	if (shot.script) {
		await view.evaluate(`(() => { ${shot.script} })()`);
		await Bun.sleep(1200);
	}
	await Bun.write(join(out, `${shot.name}.png`), await view.screenshot());
	console.log(`✓ ${shot.name}`);
}

/** Clicks the first element matching `selector` whose text contains `text`. */
const click = (selector: string, text: string) =>
	`[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)}))?.click()`;
/** Picks an option of the <select> labelled `label`. */
const choose = (label: string, value: string) =>
	`(() => { const s = document.querySelector('select[aria-label=${JSON.stringify(label)}]'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`;

const display = (name: string) => listDisplays().find((d) => d.name === name)!.id;
const layout = (name: string) => listLayouts().find((l) => l.name === name)!.id;

const shots: Shot[] = [
	{ name: "display-welcome", path: `/d/${display("Bar TV")}`, width: 1600, height: 900, wait: 4000 },
	{ name: "display-dashboard", path: `/d/${display("Hallway tablet")}`, width: 1600, height: 900, wait: 8000 },
	{ name: "display-epaper", path: `/d/${display("Kitchen frame")}`, width: 810, height: 1080, wait: 4000 },
	{ name: "display-epaper-6-colour", path: `/d/${display("Shelf frame")}`, width: 1200, height: 675, wait: 4000 },
	{ name: "admin-login", path: "/" },
	{ name: "admin-displays", path: "/#/displays", admin: true, wait: 3500 },
	{
		name: "admin-display-settings",
		path: "/#/displays",
		admin: true,
		script: `document.querySelector('button[aria-label="Edit"]').click(); setTimeout(() => ${click("button", "Advanced")}, 300)`,
	},
	{ name: "admin-layouts", path: "/#/layouts", admin: true, wait: 3500 },
	{ name: "admin-templates", path: "/#/layouts", admin: true, script: click("button", "New layout") },
	{
		name: "admin-editor",
		path: `/#/layouts/${layout("Bar · welcome board")}`,
		admin: true,
		width: 1600,
		wait: 3500,
		script: click("aside button", "Opening hours"),
	},
	{
		name: "admin-editor-free",
		path: `/#/layouts/${layout("Photo frame")}`,
		admin: true,
		width: 1600,
		wait: 3500,
		script: click("aside button", "Clock"),
	},
	{
		name: "admin-editor-epaper",
		path: `/#/layouts/${layout("Home · dashboard")}`,
		admin: true,
		width: 1600,
		wait: 7000,
		script: choose("Preview colour mode", "mono"),
	},
	{
		name: "admin-add-element",
		path: `/#/layouts/${layout("Bar · welcome board")}`,
		admin: true,
		width: 1600,
		height: 1000,
		script: click("button", "Add element"),
	},
	{ name: "admin-media", path: "/#/media", admin: true },
	{ name: "admin-settings", path: "/#/settings", admin: true, height: 1560 },
];

const only = process.argv.slice(2);
for (const shot of shots) if (!only.length || only.some((name) => shot.name.includes(name))) await shoot(shot);

// The Home Assistant app's icon and logo, rendered from the favicon.
if (!only.length) {
	const svg = await Bun.file(join(root, "src/client/favicon.svg")).text();
	for (const [file, width, height] of [
		["icon.png", 256, 256],
		["logo.png", 512, 256],
	] as const) {
		await using view = new Bun.WebView({ width, height: height + CHROME });
		const page = `<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:${file === "icon.png" ? "#1d2b36" : "transparent"}">${svg.replace("<svg ", '<svg style="height:100vh" ')}</body>`;
		await view.navigate(`data:text/html,${encodeURIComponent(page)}`);
		await Bun.sleep(400);
		await Bun.write(join(root, "sidedisplay", file), await view.screenshot());
	}
	console.log("✓ app icon and logo");
}

process.exit(0);
