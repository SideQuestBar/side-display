/**
 * The HTTP application, without a listening socket (tests drive it through
 * `app.handle`). `index.ts` is the process entry that starts it.
 */
import { Elysia } from "elysia";
import { gate } from "./auth";
import { config } from "./config";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { pageRoutes } from "./routes/pages";
import { viewRoutes } from "./routes/view";

export const app = new Elysia()
	.onError(({ error, request }) => {
		// Expected failures (404, validation…) keep Elysia's own responses; anything else is a bug worth a log line.
		const statusCode = (error as { status?: number }).status;
		if (typeof statusCode !== "number" || statusCode >= 500) {
			console.error(`[http] ${request.method} ${new URL(request.url).pathname} failed:`, error);
		}
	})
	.onRequest(({ request, server, status }) => {
		const refusal = gate(request, server?.requestIP(request)?.address);
		if (refusal) return status(refusal.status, { error: refusal.error });
	})
	.get("/api/health", () => ({ ok: true, version: config.version }))
	.use(authRoutes)
	.use(adminRoutes)
	.use(viewRoutes)
	.use(pageRoutes);

export type App = typeof app;
