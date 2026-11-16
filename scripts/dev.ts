/**
 * `bun run dev`: the server restarting on change (`bun --watch`) plus the
 * client rebuilt whenever a file under `src/client` or `src/shared` changes.
 * Reload the browser to see client changes.
 */
import { watch } from "node:fs";
import { join } from "node:path";
import { build } from "./build";

const root = join(import.meta.dir, "..");
await build(true);

let timer: ReturnType<typeof setTimeout> | undefined;
let building = false;
let again = false;
async function rebuild() {
	if (building) {
		again = true;
		return;
	}
	building = true;
	await build(true).catch((err) => console.error(err));
	building = false;
	if (again) {
		again = false;
		void rebuild();
	}
}
for (const dir of ["src/client", "src/shared"]) {
	watch(join(root, dir), { recursive: true }, () => {
		clearTimeout(timer);
		timer = setTimeout(rebuild, 120);
	});
}

const server = Bun.spawn(["bun", "--watch", "src/server/index.ts"], {
	cwd: root,
	env: { ...process.env, SIDEDISPLAY_DEV: "1" },
	stdio: ["inherit", "inherit", "inherit"],
});
process.on("SIGINT", () => server.kill());
process.on("SIGTERM", () => server.kill());
await server.exited;
process.exit(0);
