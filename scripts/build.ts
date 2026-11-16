/**
 * Builds the client into `dist/client`: the admin app (`index.html`) and the
 * display page (`display.html`), with relative URLs so the result works under
 * any path prefix (the server adds a matching <base>).
 *
 *   bun run build            production build
 *   bun scripts/build.ts --dev   unminified, with source maps
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import solid from "./solid-plugin";

const root = join(import.meta.dir, "..");
const out = join(root, "dist/client");

export async function build(dev = false): Promise<boolean> {
	const started = performance.now();
	const result = await Bun.build({
		entrypoints: [join(root, "src/client/index.html"), join(root, "src/client/display.html")],
		outdir: out,
		target: "browser",
		splitting: true,
		minify: !dev,
		sourcemap: dev ? "linked" : "none",
		naming: { entry: "[name].[ext]", chunk: "assets/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
		define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
		plugins: [tailwind, solid],
		throw: false,
	});
	for (const log of result.logs) console.log(log);
	if (!result.success) {
		console.error("client build failed");
		return false;
	}
	// MapLibre is loaded on demand by map elements, straight from these files.
	const maplibre = join(root, "node_modules/maplibre-gl/dist");
	await mkdir(join(out, "vendor/maplibre"), { recursive: true });
	for (const file of ["maplibre-gl.mjs", "maplibre-gl-shared.mjs", "maplibre-gl-worker.mjs", "maplibre-gl.css"]) {
		await cp(join(maplibre, file), join(out, "vendor/maplibre", file));
	}
	// So is pdf.js, by PDF elements: the library, its worker, and the fonts and decoders some documents need.
	const pdfjs = join(root, "node_modules/pdfjs-dist");
	await mkdir(join(out, "vendor/pdfjs"), { recursive: true });
	for (const file of ["pdf.min.mjs", "pdf.worker.min.mjs"]) {
		await cp(join(pdfjs, "build", file), join(out, "vendor/pdfjs", file));
	}
	for (const folder of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
		await cp(join(pdfjs, folder), join(out, "vendor/pdfjs", folder), { recursive: true });
	}
	await cp(join(root, "src/client/favicon.svg"), join(out, "favicon.svg"));
	console.log(`client built in ${Math.round(performance.now() - started)} ms → dist/client`);
	return true;
}

if (import.meta.main) {
	await rm(out, { recursive: true, force: true });
	if (!(await build(process.argv.includes("--dev")))) process.exit(1);
}
