/**
 * Serves the built client: the admin app at `/`, the display page at
 * `/d/:id` (and `/p/:id` to preview a layout), and their assets.
 */
import { join, normalize } from "node:path";
import { Elysia } from "elysia";
import { config } from "../config";

const pages = new Map<string, string>();

async function page(name: "index.html" | "display.html", request: Request): Promise<Response> {
	let html = config.dev ? undefined : pages.get(name);
	if (html === undefined) {
		const file = Bun.file(join(config.clientDir, name));
		if (!(await file.exists())) {
			return new Response("The client is not built yet. Run `bun run build` (or `bun run dev`).", { status: 503 });
		}
		html = await file.text();
		pages.set(name, html);
	}
	// The client is built with relative URLs; a <base> makes them resolve from
	// any page depth and under a path prefix (Home Assistant ingress, a
	// reverse proxy mounting the app in a sub-folder).
	const prefix = request.headers.get("x-ingress-path") ?? request.headers.get("x-forwarded-prefix") ?? "";
	const base = /^\/[\w\-./]*$/.test(prefix) ? `${prefix.replace(/\/+$/, "")}/` : "/";
	return new Response(html.replace("<head>", `<head><base href="${base}">`), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-cache",
			"referrer-policy": "same-origin",
			"x-content-type-options": "nosniff",
		},
	});
}

async function asset(folder: string, path: string): Promise<Response> {
	const root = join(config.clientDir, folder);
	const target = normalize(join(root, path));
	const file = Bun.file(target);
	if (!target.startsWith(`${root}/`) || !(await file.exists())) return new Response("Not found", { status: 404 });
	return new Response(file, {
		headers: {
			// Bundles carry a content hash in their name; vendor files change with releases.
			"cache-control": folder === "assets" && !config.dev ? "public, max-age=31536000, immutable" : "no-cache",
			"x-content-type-options": "nosniff",
		},
	});
}

export const pageRoutes = new Elysia({ name: "routes.pages" })
	.get("/", ({ request }) => page("index.html", request))
	.get("/d/:id", ({ request }) => page("display.html", request))
	.get("/p/:id", ({ request }) => page("display.html", request))
	.get("/assets/*", ({ params }) => asset("assets", params["*"]))
	.get("/vendor/*", ({ params }) => asset("vendor", params["*"]))
	.get("/favicon.svg", () => asset("", "favicon.svg"));
