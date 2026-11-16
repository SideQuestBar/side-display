/**
 * In-process pub/sub behind every display's live stream (Server-Sent Events).
 *
 *   update    a layout, the playlist or the settings changed: refetch in place
 *   reload    hard-reload the page (manual button, new app version)
 *   identify  show the display's name on screen for a few seconds
 *   entities  Home Assistant entities the display uses changed state
 */
export interface StreamEvent {
	event: "connected" | "update" | "reload" | "identify" | "entities" | "ping";
	data: unknown;
}

interface Subscriber {
	displayId: string;
	send: (event: StreamEvent) => void;
}

const subscribers = new Set<Subscriber>();

export function subscribe(displayId: string, send: Subscriber["send"]): () => void {
	const sub = { displayId, send };
	subscribers.add(sub);
	return () => subscribers.delete(sub);
}

export function onlineCount(displayId: string): number {
	let n = 0;
	for (const s of subscribers) if (s.displayId === displayId) n++;
	return n;
}

export const connectedDisplayIds = () => new Set([...subscribers].map((s) => s.displayId));

/** Sends to the screens of some displays, or to all of them when `displayIds` is omitted. */
export function notify(event: StreamEvent, displayIds?: Iterable<string>) {
	const only = displayIds ? new Set(displayIds) : null;
	for (const s of subscribers) if (!only || only.has(s.displayId)) s.send(event);
}

/**
 * An async queue: producers `push`, one consumer iterates. Lets a callback-fed
 * source (the subscriptions above) drive a generator-based SSE response.
 */
export function createQueue<T>() {
	const items: T[] = [];
	let wake: (() => void) | null = null;
	let closed = false;
	return {
		push(item: T) {
			if (closed) return;
			// A screen that stopped reading must not grow the queue forever.
			if (items.length < 200) items.push(item);
			wake?.();
		},
		close() {
			closed = true;
			wake?.();
		},
		async *[Symbol.asyncIterator]() {
			while (true) {
				while (items.length) yield items.shift()!;
				if (closed) return;
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = null;
			}
		},
	};
}
