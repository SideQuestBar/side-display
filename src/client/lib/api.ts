/**
 * Tiny fetch wrapper. Every URL is resolved against the document's <base>, so
 * the app works at `/`, behind Home Assistant ingress, or under any prefix.
 */
export const url = (path: string) => new URL(path.replace(/^\//, ""), document.baseURI).href;

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (handler: () => void) => {
	onUnauthorized = handler;
};

export async function api<T = unknown>(
	path: string,
	init: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {},
): Promise<T> {
	const response = await fetch(url(path), {
		method: init.method ?? (init.body !== undefined || init.form ? "POST" : "GET"),
		headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
		body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
		credentials: "same-origin",
		signal: init.signal,
	});
	if (!response.ok) {
		const payload = (await response.json().catch(() => null)) as {
			error?: string;
			detail?: string;
			title?: string;
		} | null;
		if (response.status === 401 && !path.startsWith("api/auth/")) onUnauthorized();
		throw new ApiError(
			payload?.error ?? payload?.detail ?? payload?.title ?? `Request failed (${response.status})`,
			response.status,
		);
	}
	return response.json() as Promise<T>;
}

/** URL of a picture or video: library files are relative (`media/…`), anything else is used as is. */
export function mediaUrl(src: string, width?: number): string {
	if (!src) return "";
	if (!src.startsWith("media/")) return src;
	return url(width ? `${src}?w=${Math.round(width)}` : src);
}
