import type Hls from "hls.js";
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { encode } from "uqr";
import type { FeedData, GalleryData, TextData, TickerData, TwitchData, VideoData, WebData } from "../../../shared/data";
import type { El } from "../../../shared/elements";
import { renderMarkdown } from "../../../shared/markdown";
import { fillPlaceholders, hasClockPlaceholder } from "../../../shared/placeholders";
import { timeFormatter } from "../../../shared/time";
import { twitchAllows, twitchChannel } from "../../../shared/twitch";
import type { AnyEl } from "../../../shared/types";
import { mediaUrl, url } from "../../lib/api";
import { type LayoutEnv, px, useDisplay, useMinute, useSlide } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";
import { Picture } from "../Picture";

/** Rendered Markdown. The renderer escapes everything, so injecting it is safe. */
export function Markdown(props: { text: string; class?: string; style?: JSX.CSSProperties }) {
	return <div class={`sd-md ${props.class ?? ""}`} style={props.style} innerHTML={renderMarkdown(props.text)} />;
}

/**
 * Steps through `count` items, wrapping around. `seconds` is how long the item
 * at an index stays (never under two seconds), so each can have its own time.
 */
export function useRotation(count: () => number, seconds: (index: number) => number) {
	const [index, setIndex] = createSignal(0);
	createEffect(() => {
		const total = count();
		const current = index();
		if (current >= total) {
			setIndex(0);
			return;
		}
		if (total <= 1) return;
		const timer = setTimeout(() => setIndex((current + 1) % total), Math.max(2, seconds(current) || 0) * 1000);
		onCleanup(() => clearTimeout(timer));
	});
	return index;
}

/** A date formatter that survives a mistyped locale or time zone by falling back to the device's. */
function dateFormatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat(locale || undefined, options);
	} catch {
		return new Intl.DateTimeFormat(undefined, { ...options, timeZone: options.timeZone === "UTC" ? "UTC" : undefined });
	}
}

/** How many lines of text a rendered Markdown block takes, from the height of its paragraphs. */
function countLines(block: HTMLElement): number {
	let lines = 0;
	for (const child of block.querySelectorAll<HTMLElement>(":scope > :not(ul), :scope > ul > li")) {
		const line = Number.parseFloat(getComputedStyle(child).lineHeight);
		lines += line > 0 ? Math.max(1, Math.round(child.offsetHeight / line)) : 1;
	}
	return lines;
}

export function Text(props: RendererProps<El<"text">, TextData>) {
	const env = useDisplay();
	const slide = useSlide();
	const minute = useMinute();
	const text = createMemo(() => {
		const raw = props.el.text;
		if (!raw.includes("{")) return raw;
		const { locale, timezone, hourCycle } = env.general();
		// Only a text that shows the time or the date is redrawn every minute.
		const now = hasClockPlaceholder(raw) ? minute() : 0;
		return fillPlaceholders(raw, {
			time: () => timeFormatter(locale, hourCycle, timezone).format(now),
			date: () => dateFormatter(locale, { dateStyle: "full", timeZone: timezone || undefined }).format(now),
			entity: (id) => {
				const state = props.data()?.states?.[id];
				if (!state) return "–";
				return state.unit ? `${state.state} ${state.unit}` : state.state;
			},
		});
	});

	// Fitting needs a box whose height does not come from the text itself.
	const fitted = () =>
		props.el.autoFit &&
		(props.el.placement === "free" ||
			props.el.height > 0 ||
			props.el.grow === "yes" ||
			(slide && props.el.grow !== "no"));
	let box: HTMLDivElement | undefined;
	const fit = () => {
		const inner = box?.firstElementChild as HTMLElement | null;
		// The stage is scaled with a CSS transform: these are stage pixels, which is what font sizes are in.
		const width = box?.clientWidth ?? 0;
		const height = box?.clientHeight ?? 0;
		if (!box || !inner || !width || !height) return;
		const maxLines = props.el.maxLines;
		// Measured without the ellipsis, which would hide how much text there really is.
		inner.classList.remove("sd-text-clamp");
		const fits = (size: number) => {
			inner.style.fontSize = `${size}px`;
			if (inner.scrollHeight > height || inner.scrollWidth > width) return false;
			return maxLines <= 0 || countLines(inner) <= maxLines;
		};
		let low = 6;
		let high = Math.max(low, height);
		for (let i = 0; i < 12 && high - low > 0.5; i++) {
			const middle = (low + high) / 2;
			if (fits(middle)) low = middle;
			else high = middle;
		}
		inner.style.fontSize = `${Math.floor(low)}px`;
		inner.classList.toggle("sd-text-clamp", maxLines > 0);
	};
	createEffect(() => {
		if (!fitted()) return;
		// Everything that changes how much room the text takes.
		void [text(), props.el.weight, props.el.lineHeight, props.el.letterSpacing, props.el.uppercase, props.el.maxLines];
		fit();
		if (!box) return;
		const observer = new ResizeObserver(fit);
		observer.observe(box);
		// A web font that arrives later changes every measurement.
		let live = true;
		document.fonts?.ready.then(() => live && fit());
		onCleanup(() => {
			live = false;
			observer.disconnect();
		});
	});

	const content = () => (
		<Markdown
			text={text()}
			class={`sd-text ${props.el.maxLines > 0 ? "sd-text-clamp" : ""}`}
			style={{
				// A fitted text gets its size from `fit`, not from here.
				"font-size": fitted() ? undefined : px(props.el.size),
				"text-align": props.el.align,
				"font-weight": props.el.weight,
				"line-height": String(props.el.lineHeight),
				"letter-spacing": props.el.letterSpacing ? `${props.el.letterSpacing}em` : undefined,
				"text-transform": props.el.uppercase ? "uppercase" : undefined,
				"text-shadow": props.el.shadow ? "var(--sd-shadow)" : "none",
				"--sd-lines": props.el.maxLines > 0 ? String(Math.round(props.el.maxLines)) : undefined,
			}}
		/>
	);
	return (
		<Show when={fitted()} fallback={content()}>
			<div ref={box} class="sd-text-fit">
				{content()}
			</div>
		</Show>
	);
}

/** The image shapes that are cut with `clip-path` ("none" and "soft" are plain corner radii). */
const IMAGE_MASKS: Record<string, string | undefined> = {
	circle: "circle(closest-side)",
	ellipse: "ellipse(50% 50%)",
	hexagon: "polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)",
	diamond: "polygon(50% 0, 100% 50%, 50% 100%, 0 50%)",
	// Radii larger than the box are scaled down to half its width: a round-topped window.
	arch: "inset(0 round 9999px 9999px 0 0)",
};

export function Image(props: RendererProps<El<"image">>) {
	// With a fixed height (or when growing or freely placed) the picture fills
	// its box; otherwise it keeps its own proportions at the chosen width.
	const env = useDisplay();
	const slide = useSlide();
	const boxed = () =>
		props.el.placement === "free" ||
		props.el.height > 0 ||
		props.el.grow === "yes" ||
		(slide && props.el.grow !== "no");

	// A webcam picture is fetched again under a new address, and only swapped
	// in once it has loaded, so the screen never shows a half-loaded frame.
	const address = () => mediaUrl(props.el.src, 1920);
	const [fresh, setFresh] = createSignal("");
	createEffect(() => {
		const url = address();
		setFresh("");
		// Library files never change; only a web address is worth asking again.
		if (props.el.reload <= 0 || !/^https?:\/\//i.test(url)) return;
		let live = true;
		const timer = setInterval(() => {
			const [base = "", hash = ""] = url.split("#");
			const next = `${base}${base.includes("?") ? "&" : "?"}_=${Date.now()}${hash ? `#${hash}` : ""}`;
			const probe = document.createElement("img");
			// A failed fetch keeps the last good picture.
			probe.onload = () => live && setFresh(next);
			probe.src = next;
		}, Math.max(5, props.el.reload) * 1000);
		onCleanup(() => {
			live = false;
			clearInterval(timer);
		});
	});

	const look = createMemo((): JSX.CSSProperties => {
		const mask = props.el.mask;
		const radius =
			mask === "soft" ? "calc(var(--sd-radius) * 3)" : mask === "none" && props.el.rounded ? "var(--sd-radius)" : "0";
		const css: JSX.CSSProperties = { "border-radius": radius };
		const clip = IMAGE_MASKS[mask];
		if (clip) css["clip-path"] = clip;
		// Dithered or grey pictures are already reduced; a blur or a tint would only muddy them.
		if (env.lowColor()) return css;
		const filters: string[] = [];
		if (props.el.blur > 0) filters.push(`blur(${props.el.blur}px)`);
		if (props.el.darken > 0) filters.push(`brightness(${1 - Math.min(100, props.el.darken) / 100})`);
		if (props.el.greyscale > 0) filters.push(`grayscale(${Math.min(100, props.el.greyscale) / 100})`);
		if (filters.length) css.filter = filters.join(" ");
		// A blur bleeds past rounded corners; clipping (applied after filters) keeps the edge crisp.
		if (props.el.blur > 0 && !clip) css["clip-path"] = `inset(0 round ${radius})`;
		return css;
	});
	return (
		<div
			class="sd-image"
			classList={{ "sd-image-boxed": boxed() }}
			data-caption={props.el.caption ? props.el.captionPosition : undefined}
		>
			<Show when={props.el.src} fallback={<Placeholder text="Choose an image" />}>
				<div class="sd-image-figure" style={{ width: boxed() ? undefined : `${props.el.width}%` }}>
					<Picture
						src={fresh() || address()}
						fit={props.el.fit}
						focus={props.el.fit === "cover" ? { x: props.el.focusX, y: props.el.focusY } : undefined}
						natural={!boxed()}
						style={look()}
					/>
				</div>
			</Show>
			<Show when={props.el.caption}>
				<Markdown text={props.el.caption} class="sd-caption" style={{ "font-size": px(props.el.captionSize) }} />
			</Show>
		</div>
	);
}

type Photo = GalleryData["items"][number];
const KEN_BURNS = ["in", "out", "left", "right"];

export function Gallery(props: RendererProps<El<"gallery">, GalleryData>) {
	const env = useDisplay();
	// The album is refetched every few minutes; an unchanged one must not reshuffle or restart the photo on screen.
	const album = createMemo(() => JSON.stringify(props.data()?.items ?? []));
	const items = createMemo(() => {
		const list = JSON.parse(album()) as Photo[];
		if (props.el.shuffle || props.el.order === "random") {
			// Shuffled once per list, not on every render.
			for (let i = list.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[list[i], list[j]] = [list[j]!, list[i]!];
			}
		}
		return list;
	});

	// Two upright photos share a wide frame; the frame's shape is only known once it is on screen.
	let frame: HTMLDivElement | undefined;
	const [wide, setWide] = createSignal(false);
	const observer = new ResizeObserver(() => frame && setWide(frame.offsetWidth > frame.offsetHeight * 1.15));
	queueMicrotask(() => frame && observer.observe(frame));
	onCleanup(() => observer.disconnect());
	const upright = (photo: Photo | undefined) => Boolean(photo) && photo!.height > photo!.width;
	const pages = createMemo(() => {
		const list = items();
		const pair = props.el.twoUp && wide();
		const out: Photo[][] = [];
		for (let i = 0; i < list.length; i++) {
			if (pair && upright(list[i]) && upright(list[i + 1])) out.push([list[i]!, list[++i]!]);
			else out.push([list[i]!]);
		}
		return out;
	});
	const index = useRotation(
		() => pages().length,
		() => props.el.interval,
	);
	const current = () => pages()[index()];

	const caption = (photo: Photo) => {
		const parts: string[] = [];
		if (props.el.captions) parts.push(photo.name);
		const day = /^(\d{4})-(\d{2})-(\d{2})/.exec(props.el.dates ? (photo.date ?? "") : "");
		if (day) {
			// A calendar day, not an instant: formatted at noon UTC so no time zone can move it.
			const noon = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12);
			parts.push(dateFormatter(env.general().locale, { dateStyle: "long", timeZone: "UTC" }).format(noon));
		}
		return parts.join(" · ");
	};
	const motion = (lucky: string) => {
		if (env.lowColor() || props.el.transition !== "zoom") return undefined;
		return props.el.kenBurns === "random" ? lucky : props.el.kenBurns;
	};
	return (
		<div ref={frame} class="sd-gallery sd-media-frame">
			<Show when={current()} keyed fallback={<Placeholder text="No photos in this album yet" error={props.error()} />}>
				{(page) => (
					<div
						class="sd-gallery-slide"
						data-transition={env.lowColor() ? "none" : props.el.transition}
						// Drawn once per photo, so "random" does not change direction mid-way.
						data-motion={motion(KEN_BURNS[Math.floor(Math.random() * KEN_BURNS.length)]!)}
						style={{ "--sd-interval": `${props.el.interval}s` }}
					>
						<For each={page}>
							{(photo) => (
								<div class="sd-gallery-photo">
									{/* A small copy is plenty for something blurred beyond recognition. */}
									<Show when={props.el.backdrop && props.el.fit === "contain" && !env.lowColor()}>
										<img class="sd-gallery-backdrop" src={mediaUrl(photo.src, 320)} alt="" draggable={false} />
									</Show>
									<Picture src={mediaUrl(photo.src, page.length > 1 ? 1280 : 1920)} fit={props.el.fit} />
									<Show when={caption(photo)}>
										<div class="sd-gallery-caption">{caption(photo)}</div>
									</Show>
								</div>
							)}
						</For>
					</div>
				)}
			</Show>
		</div>
	);
}

export function Slideshow(props: RendererProps<El<"slideshow">>) {
	const env = useDisplay();
	// Slides saved before the per-slide options existed lack those keys: read them all defensively.
	const seconds = (i: number) => Math.max(2, Number(props.el.slides[i]?.seconds) || props.el.interval);
	const index = useRotation(() => props.el.slides.length, seconds);
	const slide = () => props.el.slides[index()];
	return (
		<div class="sd-slideshow">
			<div class="sd-media-frame sd-slideshow-frame">
				<Show when={slide()} keyed fallback={<Placeholder text="Add a slide" />}>
					{(s) => {
						// This slide's own place, which `index` stops being as soon as the next one is due.
						const at = index();
						const link = () => (typeof s.link === "string" ? s.link.trim() : "");
						const code = createMemo(() => {
							try {
								return link() ? qrPath(link()) : null;
							} catch {
								// Too long for a QR code: the slide simply has none.
								return null;
							}
						});
						return (
							<div
								class="sd-slide"
								data-position={s.position || props.el.position}
								data-transition={env.lowColor() ? "none" : props.el.transition}
								style={{ "--sd-interval": `${seconds(at)}s` }}
							>
								<Show when={s.image}>
									<Picture src={mediaUrl(s.image, 1920)} fit="cover" />
									<Show when={!env.lowColor() && props.el.overlay > 0}>
										<div class="sd-slide-shade" style={{ opacity: String(props.el.overlay / 100) }} />
									</Show>
								</Show>
								<div
									class="sd-slide-text"
									classList={{ "sd-slide-text-plain": !s.image }}
									// On ePaper the text sits on a white band, where only black reads.
									style={{ color: s.color && !env.lowColor() ? env.ink(s.color) : undefined }}
								>
									<div class="sd-slide-title" style={{ "font-size": px(props.el.titleSize) }}>
										{s.title}
									</div>
									<Show when={s.subtitle}>
										<div class="sd-slide-subtitle" style={{ "font-size": px(props.el.titleSize * 0.5) }}>
											{s.subtitle}
										</div>
									</Show>
								</div>
								<Show when={code()}>
									{(qr) => (
										<div class="sd-slide-qr">
											<svg
												viewBox={`0 0 ${qr().size} ${qr().size}`}
												shape-rendering="crispEdges"
												role="img"
												aria-label="QR code"
											>
												<path d={qr().path} fill="#000000" />
											</svg>
										</div>
									)}
								</Show>
							</div>
						);
					}}
				</Show>
			</div>
			<Show when={props.el.progress && props.el.slides.length > 1}>
				<div class="sd-dots">
					<For each={props.el.slides}>
						{(_, i) => (
							<div class="sd-dot" data-state={i() < index() ? "done" : i() === index() ? "active" : "todo"}>
								{/* Restarted on every slide change by the keyed <Show>. */}
								<Show when={i() === index() && !env.lowColor()} keyed>
									<div class="sd-dot-fill" style={{ "animation-duration": `${seconds(i())}s` }} />
								</Show>
							</div>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}

/** The id of a YouTube video, from any of its URL shapes. */
function youtubeId(src: string): string | null {
	const match = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(src);
	return match?.[1] ?? null;
}

/** A command for an embedded YouTube player, in the wire format of its IFrame API. */
const youtubeSay = (frame: HTMLIFrameElement | undefined, message: object) =>
	frame?.contentWindow?.postMessage(JSON.stringify(message), "https://www.youtube-nocookie.com");

export function Video(props: RendererProps<El<"video">, VideoData>) {
	const env = useDisplay();
	// In a carousel the video waits for its turn, then plays from the start.
	const slide = useSlide();
	const onScreen = () => slide?.active() ?? true;
	// The video itself, then whatever the playlist adds.
	const entries = createMemo(() => [
		{ src: props.el.src, startAt: props.el.startAt, endAt: props.el.endAt },
		...props.el.playlist.filter((entry) => entry.src),
	]);
	const [index, setIndex] = createSignal(0);
	const entry = () => entries()[Math.min(index(), entries().length - 1)]!;
	const youtube = () => youtubeId(entry().src);
	const [player, setPlayer] = createSignal<HTMLVideoElement>();
	const [frame, setFrame] = createSignal<HTMLIFrameElement>();
	// Bumped to play the same YouTube video again: its frame is made anew.
	const [round, setRound] = createSignal(0);
	// Played to the end and not repeating: nothing more happens until the next turn.
	const [over, setOver] = createSignal(false);
	let failures = 0;
	// A carousel that waits for the video needs it to end.
	const repeats = () => props.el.loop && !slide?.waits();
	// One whole video on repeat is the browser's job: it loops without a gap.
	const seamless = () => repeats() && entries().length === 1 && !entry().startAt && !entry().endAt;
	const rate = () => Math.min(4, Math.max(0.25, props.el.rate || 1));

	/** Plays the current entry from its start offset. */
	const begin = () => {
		setOver(false);
		const video = player();
		// The last file player lingers in the signal while a YouTube entry is on.
		if (!video?.isConnected) return;
		video.playbackRate = rate();
		if (Math.abs(video.currentTime - entry().startAt) > 0.05) video.currentTime = entry().startAt;
		if (onScreen()) video.play().catch(() => {});
	};
	/** Back to the first entry and its start offset. */
	const restart = () => {
		if (index() !== 0) setIndex(0);
		else if (youtube()) setRound((n) => n + 1);
		else begin();
	};
	/** The current entry is over: on to the next, or the whole thing is. */
	const next = () => {
		if (over()) return;
		if (index() < entries().length - 1) setIndex(index() + 1);
		else if (repeats()) restart();
		else {
			setOver(true);
			player()?.pause();
			slide?.ended();
		}
	};
	/** Skips an entry that cannot play; gives up once none of them could. */
	const failed = () => {
		failures++;
		if (failures < entries().length) return next();
		setOver(true);
		slide?.ended();
	};

	createEffect(() => {
		if (index() >= entries().length) setIndex(0);
	});
	createEffect(
		on(onScreen, (visible) => {
			if (!slide) return;
			if (visible) {
				failures = 0;
				restart();
			} else player()?.pause();
		}),
	);
	// A start offset edited while the video plays applies at once.
	createEffect(
		on(
			() => entry().startAt,
			() => {
				if ((player()?.readyState ?? 0) > 0) begin();
			},
			{ defer: true },
		),
	);
	const tune = () => {
		const video = player();
		if (video) {
			video.volume = Math.min(1, Math.max(0, props.el.volume / 100));
			video.playbackRate = rate();
		}
		youtubeSay(frame(), { event: "command", func: "setVolume", args: [props.el.volume] });
		youtubeSay(frame(), { event: "command", func: "setPlaybackRate", args: [rate()] });
	};
	createEffect(tune);

	// An embedded player reports through messages: ready, state changes, errors.
	const onMessage = (event: MessageEvent) => {
		if (!frame() || event.source !== frame()?.contentWindow || typeof event.data !== "string") return;
		try {
			const message = JSON.parse(event.data) as { event?: string; info?: { playerState?: number } | null };
			if (message.event === "onReady") tune();
			else if (message.event === "onError") failed();
			else if (message.event === "infoDelivery" && message.info?.playerState === 0 && !seamless()) next();
			else if (message.info?.playerState === 1) failures = 0;
		} catch {
			// Not one of the player's messages.
		}
	};
	window.addEventListener("message", onMessage);
	onCleanup(() => window.removeEventListener("message", onMessage));

	// Fetched by the server (no CORS needed) and handed to the player as a local file.
	const subtitles = createMemo(() => {
		const text = props.el.subtitles ? props.data()?.subtitles : "";
		if (!text) return "";
		const address = URL.createObjectURL(new Blob([text], { type: "text/vtt" }));
		onCleanup(() => URL.revokeObjectURL(address));
		return address;
	});
	// Chrome only draws the cues of a track switched on while its player is on the page, so switch it again.
	const showCues = () => {
		for (const track of player()?.textTracks ?? []) {
			track.mode = "hidden";
			track.mode = "showing";
		}
	};

	return (
		<div class="sd-video sd-media-frame">
			<Show when={props.el.src} fallback={<Placeholder text="Choose a video" />}>
				<Show
					when={!env.lowColor()}
					// ePaper cannot play video: show the poster instead.
					fallback={
						<Show when={props.el.poster} fallback={<Placeholder text="Video (not shown on ePaper)" />}>
							<Picture src={mediaUrl(props.el.poster, 1920)} fit={props.el.fit} />
						</Show>
					}
				>
					<Show
						when={youtube()}
						fallback={
							// A new player for each playlist entry; a repeat of the same one only seeks.
							<Show when={index() + 1} keyed>
								<video
									ref={setPlayer}
									src={mediaUrl(entry().src)}
									poster={props.el.poster ? mediaUrl(props.el.poster, 1920) : undefined}
									autoplay={!slide}
									playsinline
									muted={props.el.muted}
									loop={seamless()}
									onLoadedMetadata={() => {
										tune();
										begin();
										showCues();
									}}
									onPlaying={() => {
										failures = 0;
									}}
									onTimeUpdate={(event) => {
										const video = event.currentTarget;
										const end = entry().endAt;
										if (end > entry().startAt && !video.seeking && video.currentTime >= end) next();
									}}
									onEnded={next}
									onError={failed}
									style={{ "object-fit": props.el.fit }}
								>
									<Show when={index() === 0 && subtitles()}>
										{(address) => <track kind="subtitles" default src={address()} onLoad={showCues} />}
									</Show>
								</video>
							</Show>
						}
					>
						{(id) => (
							// An embedded player cannot be paused from here: it only exists while on screen.
							<Show when={onScreen() && [id(), index(), round()]} keyed>
								<iframe
									ref={setFrame}
									title="Video"
									allow="autoplay; encrypted-media"
									referrerpolicy="strict-origin-when-cross-origin"
									// Asks the player to report its state, which is how the end of the video is noticed.
									onLoad={(event) => youtubeSay(event.currentTarget, { event: "listening", id: 1, channel: "widget" })}
									src={`https://www.youtube-nocookie.com/embed/${id()}?autoplay=1&controls=0&rel=0&playsinline=1&enablejsapi=1&mute=${props.el.muted ? 1 : 0}${entry().startAt > 0 ? `&start=${Math.floor(entry().startAt)}` : ""}${entry().endAt > entry().startAt ? `&end=${Math.ceil(entry().endAt)}` : ""}${seamless() ? `&loop=1&playlist=${id()}` : ""}`}
								/>
							</Show>
						)}
					</Show>
					<Show when={env.editing && props.error()}>
						<div class="sd-video-note">{props.error()}</div>
					</Show>
				</Show>
			</Show>
		</div>
	);
}

/** The host names Twitch must be told about: this page's and, when it is framed itself (Home Assistant), its ancestors'. */
function twitchParents(): string {
	const hosts = new Set([location.hostname]);
	for (const origin of Array.from(location.ancestorOrigins ?? [])) {
		try {
			hosts.add(new URL(origin).hostname);
		} catch {
			// An opaque origin has no host name to give.
		}
	}
	return [...hosts].map((host) => `parent=${encodeURIComponent(host)}`).join("&");
}

let hlsLibrary: Promise<typeof Hls> | undefined;
/** hls.js is only needed by direct Twitch streams, so like MapLibre it is fetched from `vendor/` when one is shown. */
function loadHls(): Promise<typeof Hls> {
	hlsLibrary ??= (async () => {
		// A computed specifier keeps the bundler from following the import.
		const specifier = url("vendor/hls/hls.light.min.mjs");
		return ((await import(specifier)) as { default: typeof Hls }).default;
	})();
	hlsLibrary.catch(() => {
		hlsLibrary = undefined;
	});
	return hlsLibrary;
}

/**
 * Where the server relays a channel's playlist, worked out from where the
 * element's picture would be: a display addresses it by display and element
 * id, the editor (which has no picture for it) by the channel.
 */
async function twitchPlaylistAddress(env: LayoutEnv, el: El<"twitch">, channel: string): Promise<string> {
	const picture = await env.pictureUrl(el as unknown as AnyEl).catch(() => "");
	const view = /^(.*\/api\/view\/[^/]+)\/picture\/([^/?#]+)/.exec(picture);
	if (view) return `${view[1]}/hls/${view[2]}`;
	return url(`api/preview/hls?channel=${channel}&quality=${encodeURIComponent(el.quality)}`);
}

/** How long after a stream broke off it is opened again. */
const TWITCH_RETRY_MS = 10_000;

/** The stream itself in a plain video player, without Twitch's. */
function TwitchDirect(props: { el: El<"twitch">; channel: string; width: number }) {
	const env = useDisplay();
	let video!: HTMLVideoElement;
	const [attempt, setAttempt] = createSignal(0);
	let retry = () => {};

	createEffect(() => {
		attempt();
		const channel = props.channel;
		// Read here so a change of quality opens the stream anew.
		void props.el.quality;
		let cancelled = false;
		let player: Hls | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		retry = () => {
			if (cancelled) return;
			player?.destroy();
			player = undefined;
			timer ??= setTimeout(() => setAttempt((n) => n + 1), TWITCH_RETRY_MS);
		};
		void (async () => {
			const address = await twitchPlaylistAddress(env, props.el, channel);
			const library = await loadHls().catch(() => undefined);
			if (cancelled) return;
			if (library?.isSupported()) {
				player = new library();
				player.on(library.Events.ERROR, (_, data) => {
					if (data.fatal) retry();
				});
				player.on(library.Events.MANIFEST_PARSED, () => void video.play().catch(() => {}));
				player.loadSource(address);
				player.attachMedia(video);
			}
			// Without Media Source Extensions (an iPhone) the browser plays such streams itself.
			else video.src = address;
		})();
		onCleanup(() => {
			cancelled = true;
			clearTimeout(timer);
			player?.destroy();
			video.removeAttribute("src");
			video.load();
		});
	});

	return (
		<video
			ref={video}
			autoplay
			playsinline
			muted={props.el.muted}
			onError={() => retry()}
			onEnded={() => retry()}
			style={{ width: `${props.width}%`, "object-fit": props.el.fit }}
		/>
	);
}

export function Twitch(props: RendererProps<El<"twitch">, TwitchData>) {
	const env = useDisplay();
	const slide = useSlide();
	const onScreen = () => slide?.active() ?? true;
	const channel = () => twitchChannel(props.el.channel);
	const direct = () => props.el.mode === "direct";
	// Whether Twitch's own pages (its player, its chat) may be framed by this one.
	const framable = twitchAllows(location.protocol, location.hostname);
	const chat = () => (props.el.chat && framable ? Math.min(50, Math.max(15, props.el.chatWidth)) : 0);
	// Only a definite "offline" takes the stream away: when the check fails, it is tried anyway.
	// Twitch's player has an offline page of its own, shown unless there is an image to show instead.
	const offline = () => props.data()?.live === false && (direct() || Boolean(props.el.poster));
	const poster = () => <Picture src={mediaUrl(props.el.poster, 1920)} fit="cover" />;

	return (
		<div class="sd-twitch sd-media-frame">
			<Show when={channel()} fallback={<Placeholder text="Enter a Twitch channel" />}>
				<Show
					when={!env.lowColor()}
					// ePaper cannot play a stream: show the image instead.
					fallback={
						<Show when={props.el.poster} fallback={<Placeholder text="Twitch (not shown on ePaper)" />}>
							{poster()}
						</Show>
					}
				>
					<Show
						when={direct() || framable}
						// Said on the screen too: Twitch's own refusal is an empty frame.
						fallback={
							<Placeholder
								text=""
								error="Twitch's player only works on a page opened over HTTPS with a host name, or on localhost. The element's direct stream plays anywhere."
							/>
						}
					>
						<Show
							when={!offline()}
							fallback={
								<Show when={props.el.poster} fallback={<Placeholder text="The channel is offline" />}>
									{poster()}
								</Show>
							}
						>
							{/* Neither player can be paused from here: they only exist while on screen. */}
							<Show when={onScreen()}>
								<Show
									when={direct()}
									fallback={
										<iframe
											title="Twitch stream"
											allow="autoplay; encrypted-media; fullscreen"
											style={{ width: `${100 - chat()}%` }}
											src={`https://player.twitch.tv/?channel=${channel()}&${twitchParents()}&autoplay=true&muted=${props.el.muted}`}
										/>
									}
								>
									<TwitchDirect el={props.el} channel={channel()} width={100 - chat()} />
								</Show>
								<Show when={chat() > 0}>
									<iframe
										title="Twitch chat"
										style={{ left: `${100 - chat()}%`, width: `${chat()}%` }}
										src={`https://www.twitch.tv/embed/${channel()}/chat?${twitchParents()}&darkpopout`}
									/>
								</Show>
							</Show>
						</Show>
					</Show>
				</Show>
			</Show>
		</div>
	);
}

export function Web(props: RendererProps<El<"web">, WebData>) {
	const env = useDisplay();
	const [stamp, setStamp] = createSignal(0);
	const screenshot = () => props.el.mode === "screenshot";
	createEffect(() => {
		if (props.el.refresh <= 0 || screenshot()) return;
		const timer = setInterval(() => setStamp(Date.now()), Math.max(10, props.el.refresh) * 1000);
		onCleanup(() => clearInterval(timer));
	});
	const valid = () => /^https?:\/\//i.test(props.el.url);
	const zoom = () => props.el.zoom / 100;
	const left = () => Math.max(0, props.el.offsetX);
	const top = () => Math.max(0, props.el.offsetY);

	// Screenshot mode: the server says when a new picture is ready, and this fetches it.
	// The previous one stays until the next has loaded.
	const [picture, setPicture] = createSignal("");
	let stale = "";
	createEffect(on([() => props.el.url, screenshot], () => setPicture(""), { defer: true }));
	createEffect(
		on(
			() => screenshot() && props.data()?.shot,
			(taken) => {
				if (!taken) return;
				env
					.pictureUrl(props.el as unknown as AnyEl)
					.then((next) => {
						if (stale.startsWith("blob:")) URL.revokeObjectURL(stale);
						stale = picture();
						setPicture(next);
					})
					.catch(() => {});
			},
		),
	);

	// A frame cannot scroll the page of another site, so auto-scroll gives the
	// frame the page's whole height and slides it up and down behind the box.
	let box!: HTMLDivElement;
	const [boxHeight, setBoxHeight] = createSignal(0);
	const observer = new ResizeObserver(() => setBoxHeight(box.clientHeight));
	queueMicrotask(() => box && observer.observe(box));
	onCleanup(() => observer.disconnect());
	// How far the frame travels, in stage pixels; nothing moves on ePaper.
	const travel = () =>
		props.el.autoScroll && !env.lowColor() && boxHeight() > 0
			? Math.max(0, (props.el.pageHeight - top()) * zoom() - boxHeight())
			: 0;

	return (
		<div ref={box} class="sd-web sd-media-frame">
			<Show when={valid()} fallback={<Placeholder text="Enter a web address" />}>
				<Show
					when={!screenshot()}
					fallback={
						<Show when={picture()} fallback={<Placeholder text="Taking a screenshot…" error={props.error()} />}>
							<Picture src={picture()} fit="contain" />
						</Show>
					}
				>
					{/* Re-created on each refresh; scaled with a transform so "zoom" works everywhere. */}
					<Show when={[props.el.url, stamp()]} keyed>
						<iframe
							title="Web page"
							src={props.el.url}
							sandbox="allow-scripts allow-same-origin allow-forms"
							referrerpolicy="no-referrer"
							classList={{ "sd-web-scroll": travel() > 0 }}
							// Cropping moves the frame up and left, so it is made larger by as much to still fill the box.
							style={{
								width: `calc(${100 / zoom()}% + ${left()}px)`,
								height: travel() > 0 ? `${props.el.pageHeight}px` : `calc(${100 / zoom()}% + ${top()}px)`,
								transform: `translate(${-left() * zoom()}px, ${-top() * zoom()}px) scale(${zoom()})`,
								"--sd-web-zoom": String(zoom()),
								"--sd-web-x": `${-left() * zoom()}px`,
								"--sd-web-y": `${-top() * zoom()}px`,
								"--sd-web-end": `${-top() * zoom() - travel()}px`,
								"animation-duration": `${Math.max(2, travel() / Math.max(5, props.el.scrollSpeed))}s`,
							}}
						/>
					</Show>
				</Show>
			</Show>
		</div>
	);
}

/** A QR code as one SVG path: crisp at any size, and trivially 1-bit for ePaper. */
export function qrPath(text: string): { path: string; size: number } {
	const { data, size } = encode(text, { ecc: "H", border: 2 });
	let path = "";
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) if (data[y]?.[x]) path += `M${x} ${y}h1v1h-1z`;
	}
	return { path, size };
}

export function Qr(props: RendererProps<El<"qr">>) {
	const env = useDisplay();
	const code = createMemo(() => {
		try {
			return props.el.url ? qrPath(props.el.url) : null;
		} catch {
			return null;
		}
	});
	return (
		<div class="sd-qr" data-caption={props.el.caption ? props.el.captionPosition : undefined}>
			<Show when={code()} fallback={<Placeholder text="Enter a link" />}>
				{(qr) => (
					<div
						class="sd-qr-code"
						style={{ width: `${props.el.codeSize}cqh`, background: env.lowColor() ? "#ffffff" : props.el.light }}
					>
						<svg viewBox={`0 0 ${qr().size} ${qr().size}`} shape-rendering="crispEdges" role="img" aria-label="QR code">
							<path d={qr().path} fill={env.lowColor() ? "#000000" : props.el.dark} />
						</svg>
						<Show when={props.el.logo}>
							<img
								class="sd-qr-logo"
								src={mediaUrl(props.el.logo, 320)}
								alt=""
								style={{ background: props.el.light }}
							/>
						</Show>
					</div>
				)}
			</Show>
			<Show when={props.el.caption}>
				<Markdown text={props.el.caption} class="sd-caption" style={{ "font-size": px(props.el.captionSize) }} />
			</Show>
		</div>
	);
}

/**
 * A strip that scrolls for ever: it is drawn as two identical halves and slid
 * by one of them, which loops seamlessly. Each half repeats the content until
 * it is at least as wide as the frame; otherwise a short list would leave a
 * hole at the end until it came round again. The duration follows the length,
 * so the speed is constant.
 */
export function useMarquee(speed: () => number, content: () => unknown) {
	const [track, setTrack] = createSignal<HTMLElement>();
	const [repeats, setRepeats] = createSignal(1);
	const [duration, setDuration] = createSignal(30);
	const measure = () => {
		const strip = track();
		const frame = strip?.parentElement;
		if (!strip || !frame) return;
		// Layout sizes, in stage pixels: the stage's scaling does not show in them.
		const once = strip.scrollWidth / (2 * repeats());
		if (!once) return;
		const needed = Math.min(50, Math.max(1, Math.ceil(frame.clientWidth / once)));
		setRepeats(needed);
		setDuration(Math.max(4, (once * needed) / Math.max(10, speed())));
	};
	createEffect(on([track, content, speed], () => queueMicrotask(measure)));
	createEffect(() => {
		const frame = track()?.parentElement;
		if (!frame) return;
		const observer = new ResizeObserver(measure);
		observer.observe(frame);
		onCleanup(() => observer.disconnect());
	});
	/** One entry per copy of the content to draw. */
	const copies = () => Array.from({ length: 2 * repeats() }, (_, i) => i);
	return { ref: setTrack, copies, duration };
}

export function Ticker(props: RendererProps<El<"ticker">, TickerData>) {
	const env = useDisplay();
	const messages = createMemo(() => [
		...props.el.text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
		...(props.data()?.headlines ?? []),
	]);
	// Which message is up, in the one-at-a-time mode.
	const [turn, setTurn] = createSignal(0);
	const marquee = useMarquee(
		() => props.el.speed,
		() => [messages(), props.el.size, props.el.separator, props.el.direction],
	);
	const strip = () => (
		<For each={messages()}>
			{(message) => (
				<>
					<span>{message}</span>
					<span class="sd-ticker-separator">{props.el.separator}</span>
				</>
			)}
		</For>
	);
	return (
		<div class="sd-ticker" style={{ "font-size": px(props.el.size) }}>
			<Show when={messages().length} fallback={<Placeholder text="Add a message" />}>
				{/* ePaper cannot scroll: show the messages as a static line instead. */}
				<Show
					when={!env.lowColor()}
					fallback={<div class="sd-ticker-static">{messages().slice(0, 3).join(`  ${props.el.separator}  `)}</div>}
				>
					<Show
						when={props.el.direction !== "up"}
						fallback={
							// One message at a time: each is a new line that rolls in, holds, and rolls out.
							<Show when={turn() + 1} keyed>
								<div
									class="sd-ticker-line"
									classList={{ "sd-ticker-roll": messages().length > 1 }}
									style={{ "--sd-ticker-pause": `${Math.max(1, props.el.pause)}s` }}
									onAnimationEnd={(event) => {
										if (event.animationName === "sd-roll-out") setTurn((n) => (n + 1) % messages().length);
									}}
								>
									{messages()[turn() % messages().length]}
								</div>
							</Show>
						}
					>
						<div
							ref={marquee.ref}
							class="sd-ticker-track"
							style={{
								"animation-duration": `${marquee.duration()}s`,
								"animation-direction": props.el.direction === "right" ? "reverse" : "normal",
							}}
						>
							<For each={marquee.copies()}>{() => strip()}</For>
						</div>
					</Show>
				</Show>
			</Show>
		</div>
	);
}

export function List(props: RendererProps<El<"list">>) {
	return (
		<div class="sd-list" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<div class="sd-list-rows" style={{ "column-count": String(Math.max(1, props.el.columns)) }}>
				<For each={props.el.items} fallback={<Placeholder text="Add a row" />}>
					{(item) => (
						<div class="sd-list-row">
							<div class="sd-list-line">
								<span class="sd-list-label">{item.label}</span>
								<Show when={item.value}>
									<span class="sd-list-leader" classList={{ "sd-list-leader-dots": props.el.dots }} />
									<span class="sd-list-value">{item.value}</span>
								</Show>
							</div>
							<Show when={item.note}>
								<div class="sd-list-note">{item.note}</div>
							</Show>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

export function Sticker(props: RendererProps<El<"sticker">>) {
	const env = useDisplay();
	return (
		<div class="sd-sticker" data-animation={env.lowColor() ? "none" : props.el.animation}>
			<Show when={props.el.image} fallback={<span class="sd-sticker-emoji">{props.el.emoji}</span>}>
				<Picture src={mediaUrl(props.el.image, 640)} fit="contain" />
			</Show>
		</div>
	);
}

export function Rss(props: RendererProps<El<"rss">, FeedData>) {
	const env = useDisplay();
	const items = () => props.data()?.items ?? [];
	const index = useRotation(
		() => (props.el.variant === "rotate" ? items().length : 0),
		() => props.el.interval,
	);
	const shown = () => (props.el.variant === "rotate" ? items().slice(index(), index() + 1) : items());
	const date = (iso: string) =>
		iso
			? new Intl.DateTimeFormat(env.general().locale || undefined, {
					day: "numeric",
					month: "short",
					hour: "2-digit",
					minute: "2-digit",
				}).format(new Date(iso))
			: "";
	// Where the headline comes from, then when: "The Paper · 3 May, 14:10".
	const byline = (item: FeedData["items"][number]) =>
		[item.source, props.el.dates ? date(item.date) : ""].filter(Boolean).join(" · ");
	const code = (link: string) => {
		try {
			return /^https?:\/\//i.test(link) ? qrPath(link) : null;
		} catch {
			return null;
		}
	};
	const waiting = () => {
		if (!props.el.url && !props.el.feeds.some((source) => source.url)) return "Enter a feed address";
		return props.loaded() ? "No headlines to show" : "Loading the feed…";
	};
	return (
		<div class="sd-rss" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<For each={shown()} fallback={<Placeholder text={waiting()} error={props.error()} />}>
				{(item) => (
					<div class="sd-rss-item" data-variant={props.el.variant}>
						<Show when={props.el.thumbnails && item.image}>
							{(image) => (
								<div class="sd-rss-thumb">
									<Picture src={image()} fit="cover" />
								</div>
							)}
						</Show>
						<div class="sd-rss-text">
							<div class="sd-rss-title">{item.title}</div>
							<Show when={props.el.summary && item.summary}>
								<div class="sd-rss-summary">{item.summary}</div>
							</Show>
							<Show when={byline(item)}>
								<div class="sd-rss-date">{byline(item)}</div>
							</Show>
						</div>
						<Show when={props.el.qr && props.el.variant === "rotate" && code(item.link)}>
							{(qr) => (
								<div class="sd-rss-qr">
									<svg
										viewBox={`0 0 ${qr().size} ${qr().size}`}
										shape-rendering="crispEdges"
										role="img"
										aria-label="QR code"
									>
										<path d={qr().path} fill="#000000" />
									</svg>
								</div>
							)}
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}
