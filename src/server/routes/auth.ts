import { Elysia, t } from "elysia";
import {
	clearLoginFailures,
	createSession,
	crossSite,
	destroyAllSessions,
	destroySession,
	fromIngress,
	hasPassword,
	ingressRefused,
	isAuthenticated,
	isOwner,
	loginBlockedFor,
	MIN_PASSWORD_LENGTH,
	recordLoginFailure,
	SESSION_COOKIE,
	setPassword,
	verifyPassword,
	viaIngress,
} from "../auth";
import { config } from "../config";

const sessionCookie = t.Object({ [SESSION_COOKIE]: t.Cookie(t.Optional(t.String())) });
const password = t.String({ minLength: 1, maxLength: 512 });

/** HttpOnly session cookie; `Secure` whenever the browser reached us over HTTPS. */
function cookieOptions(request: Request) {
	const https =
		request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https" ||
		new URL(request.url).protocol === "https:";
	return { httpOnly: true, sameSite: "lax" as const, secure: https, path: "/", maxAge: 30 * 24 * 60 * 60 };
}

const tooShort = `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;

export const authRoutes = new Elysia({ name: "routes.auth", prefix: "/api/auth" })
	.get("/status", ({ request, server }) => {
		const address = server?.requestIP(request)?.address;
		return {
			version: config.version,
			/** No password yet: the UI shows the first-run screen. */
			setup: !hasPassword(),
			authenticated: isAuthenticated(request, address),
			/** Running as a Home Assistant app: the first password is chosen from its sidebar. */
			setupViaIngress: config.trustIngress,
			/** Signed in by Home Assistant: there is nothing to sign out of. */
			ingress: fromIngress(request, address),
			/** A Home Assistant user who is not an administrator, while only they are let in. */
			restricted: ingressRefused(request, address),
			/** May change the password and which Home Assistant users get in. */
			owner: isOwner(request, address),
		};
	})
	.post(
		"/setup",
		{ body: t.Object({ password }), cookie: sessionCookie },
		async ({ body, cookie, request, server, status }) => {
			if (crossSite(request)) return status(403, { error: "cross-site request refused" });
			if (hasPassword()) return status(409, { error: "A password is already set." });
			// As a Home Assistant app the first password is chosen from inside Home
			// Assistant by an administrator, not by whoever reaches the open port first.
			const address = server?.requestIP(request)?.address;
			if (config.trustIngress && !(viaIngress(request, address) && isOwner(request, address))) {
				return status(403, {
					error: "Open SideDisplay from the Home Assistant sidebar and choose a password in Settings.",
				});
			}
			if (body.password.length < MIN_PASSWORD_LENGTH) return status(422, { error: tooShort });
			await setPassword(body.password);
			cookie[SESSION_COOKIE].set({
				value: createSession(request.headers.get("user-agent") ?? ""),
				...cookieOptions(request),
			});
			return { ok: true };
		},
	)
	.post(
		"/login",
		{ body: t.Object({ password }), cookie: sessionCookie },
		async ({ body, cookie, request, server, status }) => {
			if (crossSite(request)) return status(403, { error: "cross-site request refused" });
			const address = server?.requestIP(request)?.address ?? "unknown";
			const wait = loginBlockedFor(address);
			if (wait) return status(429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` });
			if (!(await verifyPassword(body.password))) {
				recordLoginFailure(address);
				return status(401, { error: "Wrong password." });
			}
			clearLoginFailures(address);
			cookie[SESSION_COOKIE].set({
				value: createSession(request.headers.get("user-agent") ?? ""),
				...cookieOptions(request),
			});
			return { ok: true };
		},
	)
	.post("/logout", { cookie: sessionCookie }, ({ cookie, request }) => {
		if (!crossSite(request)) destroySession(cookie[SESSION_COOKIE].value);
		cookie[SESSION_COOKIE].remove();
		return { ok: true };
	})
	.post(
		"/password",
		{ body: t.Object({ current: t.String({ maxLength: 512 }), next: password }), cookie: sessionCookie },
		async ({ body, cookie, request, server, status }) => {
			const address = server?.requestIP(request)?.address;
			if (!isOwner(request, address))
				return status(403, { error: "Only a Home Assistant administrator can change the password." });
			// Through ingress Home Assistant vouches for the user, who may never have known the password.
			if (hasPassword() && !viaIngress(request, address) && !(await verifyPassword(body.current)))
				return status(401, { error: "The current password is wrong." });
			if (body.next.length < MIN_PASSWORD_LENGTH) return status(422, { error: tooShort });
			await setPassword(body.next);
			// Every other browser has to sign in again.
			destroyAllSessions();
			cookie[SESSION_COOKIE].set({
				value: createSession(request.headers.get("user-agent") ?? ""),
				...cookieOptions(request),
			});
			return { ok: true };
		},
	);
