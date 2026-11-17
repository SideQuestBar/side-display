/**
 * Single-password authentication.
 *
 * There are no user names: one password protects the admin UI. Sessions are
 * random tokens kept in an HttpOnly cookie; the database only stores their
 * SHA-256, so a leaked database cannot be replayed as a session.
 */
import { eq, lt } from "drizzle-orm";
import { config } from "./config";
import { db, schema } from "./db";
import { getSetting, setSetting } from "./settings";

export const SESSION_COOKIE = "sd_session";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

export const hasPassword = () => Boolean(getSetting("auth.passwordHash"));

export async function setPassword(password: string) {
	setSetting("auth.passwordHash", await Bun.password.hash(password, { algorithm: "argon2id" }));
}

export async function verifyPassword(password: string): Promise<boolean> {
	const hash = getSetting("auth.passwordHash");
	if (!hash) return false;
	return Bun.password.verify(password, hash).catch(() => false);
}

/** Applies `SIDEDISPLAY_PASSWORD` when set, so deployments can be configured without the setup screen. */
export async function applyConfiguredPassword() {
	if (!config.password) return;
	if (!(await verifyPassword(config.password))) await setPassword(config.password);
}

const hashToken = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

export function createSession(userAgent: string): string {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
	const now = Date.now();
	db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, now)).run();
	db.insert(schema.sessions)
		.values({ id: hashToken(token), createdAt: now, expiresAt: now + SESSION_MS, userAgent: userAgent.slice(0, 300) })
		.run();
	return token;
}

export function validSession(token: string | undefined | null): boolean {
	if (!token) return false;
	const id = hashToken(token);
	const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
	if (!row) return false;
	const now = Date.now();
	if (row.expiresAt < now) {
		db.delete(schema.sessions).where(eq(schema.sessions.id, id)).run();
		return false;
	}
	// Sliding expiry, written at most once a day.
	if (row.expiresAt - now < SESSION_MS - 24 * 60 * 60 * 1000) {
		db.update(schema.sessions)
			.set({ expiresAt: now + SESSION_MS })
			.where(eq(schema.sessions.id, id))
			.run();
	}
	return true;
}

export function destroySession(token: string | undefined | null) {
	if (token)
		db.delete(schema.sessions)
			.where(eq(schema.sessions.id, hashToken(token)))
			.run();
}

export const destroyAllSessions = () => db.delete(schema.sessions).run();

// ------------------------------------------------------------- brute force
// Failed logins are counted per client address; after a few, further attempts
// from that address are refused for a while.
const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; resetAt: number }>();

export function loginBlockedFor(address: string): number {
	const entry = failures.get(address);
	if (!entry || entry.resetAt < Date.now()) return 0;
	return entry.count >= MAX_FAILURES ? Math.ceil((entry.resetAt - Date.now()) / 1000) : 0;
}

export function recordLoginFailure(address: string) {
	const now = Date.now();
	const entry = failures.get(address);
	if (!entry || entry.resetAt < now) failures.set(address, { count: 1, resetAt: now + WINDOW_MS });
	else entry.count++;
	if (failures.size > 5000) for (const [key, value] of failures) if (value.resetAt < now) failures.delete(key);
}

export const clearLoginFailures = (address: string) => failures.delete(address);

/** Supervisor's ingress proxy always connects from this address. */
const INGRESS_ADDRESS = "172.30.32.2";
/** Home Assistant's administrators, as Supervisor names them in `X-Remote-User-Groups`. */
const HA_ADMIN_GROUP = "system-admin";

/** True for requests relayed by Home Assistant's ingress proxy, which has signed the user in. */
export function viaIngress(request: Request, remoteAddress: string | undefined): boolean {
	if (!config.trustIngress || !request.headers.has("x-ingress-path")) return false;
	return remoteAddress?.replace(/^::ffff:/, "") === INGRESS_ADDRESS;
}

/**
 * Whether the Home Assistant user behind an ingress request is an administrator.
 * Supervisor sets the header itself and drops whatever the browser sent; without
 * it (Supervisor older than 2026.10.4) nobody counts as one.
 */
const ingressAdmin = (request: Request) =>
	(request.headers.get("x-remote-user-groups") ?? "").split(",").some((group) => group.trim() === HA_ADMIN_GROUP);

/**
 * True for ingress requests whose user may manage SideDisplay. The sidebar panel
 * is offered to every Home Assistant user (`panel_admin: false`); the setting
 * decides whether those who are not administrators get in.
 */
export function fromIngress(request: Request, remoteAddress: string | undefined): boolean {
	return viaIngress(request, remoteAddress) && (getSetting("auth.haAccess") === "everyone" || ingressAdmin(request));
}

/** True for a Home Assistant user the setting keeps out. */
export const ingressRefused = (request: Request, remoteAddress: string | undefined) =>
	viaIngress(request, remoteAddress) && !fromIngress(request, remoteAddress);

const cookieValue = (request: Request, name: string) =>
	new Bun.CookieMap(request.headers.get("cookie") ?? "").get(name);

export function isAuthenticated(request: Request, remoteAddress: string | undefined): boolean {
	return fromIngress(request, remoteAddress) || validSession(cookieValue(request, SESSION_COOKIE));
}

/**
 * True for whoever may decide who gets in (the password, and which Home
 * Assistant users): a Home Assistant administrator, or someone signed in with
 * the password. Other Home Assistant users manage everything else.
 */
export function isOwner(request: Request, remoteAddress: string | undefined): boolean {
	if (viaIngress(request, remoteAddress)) return ingressAdmin(request);
	return validSession(cookieValue(request, SESSION_COOKIE));
}

/**
 * Rejects state-changing requests sent by another site. The session cookie is
 * SameSite=Lax already; this also covers browsers and proxies that drop that.
 */
export function crossSite(request: Request): boolean {
	if (request.method === "GET" || request.method === "HEAD") return false;
	const origin = request.headers.get("origin");
	if (!origin || origin === "null") return false;
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return true;
	}
	const hosts = [request.headers.get("host"), request.headers.get("x-forwarded-host"), new URL(request.url).host];
	return !hosts.some((h) => h && h.split(",")[0]!.trim() === originHost);
}

/** API routes that work without a session; every other `/api/` route requires one. */
const PUBLIC_API = [
	"/api/health",
	"/api/auth/status",
	"/api/auth/setup",
	"/api/auth/login",
	"/api/auth/logout",
	"/api/view/",
];

/**
 * The gate in front of the admin API. It runs before routing and before the
 * request body is read, so an anonymous client can neither reach a route that
 * forgot to ask for authentication nor make the server parse a large upload.
 * Returns the refusal to send, or nothing to let the request through.
 */
export function gate(
	request: Request,
	remoteAddress: string | undefined,
): { status: 401 | 403; error: string } | undefined {
	const path = new URL(request.url).pathname;
	if (
		!path.startsWith("/api/") ||
		PUBLIC_API.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix))
	)
		return;
	if (crossSite(request)) return { status: 403, error: "cross-site request refused" };
	if (!isAuthenticated(request, remoteAddress)) return { status: 401, error: "not signed in" };
}
