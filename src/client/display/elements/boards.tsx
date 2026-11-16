/**
 * The board elements: announcement banner, menu board, PDF page, social wall,
 * decorative shape and Wi-Fi card.
 */
import type * as PdfJs from "pdfjs-dist";
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { inWindow, localStamp, menuPrice, menuSections, wifiPayload } from "../../../shared/boards";
import { contrastOn, dither } from "../../../shared/color";
import type { SocialData } from "../../../shared/data";
import type { El } from "../../../shared/elements";
import { zoned } from "../../../shared/time";
import type { AnyEl } from "../../../shared/types";
import { mediaUrl, url } from "../../lib/api";
import { px, useDisplay, useMinute } from "../context";
import { Placeholder, type RendererProps } from "../ElementBox";
import { Picture } from "../Picture";
import { Markdown, qrPath, useRotation } from "./content";

// ------------------------------------------------------------------- banner

const BANNER_COLORS: Record<string, string> = { info: "#1d4ed8", warning: "#f59e0b", urgent: "#dc2626" };

export function Banner(props: RendererProps<El<"banner">>) {
	const env = useDisplay();
	const minute = useMinute();
	const active = createMemo(() =>
		inWindow(localStamp(zoned(minute(), env.general().timezone)), props.el.from, props.el.until),
	);
	const fill = () => env.ink(props.el.accent || BANNER_COLORS[props.el.style] || BANNER_COLORS.info!);
	const style = (): JSX.CSSProperties => {
		const text = contrastOn(fill());
		return {
			background: fill(),
			color: text,
			"text-align": props.el.align,
			"--sd-banner": fill(),
			// Whatever the layout's colours are, the content must read on the banner's own.
			"--sd-fg": text,
			"--sd-muted": text,
			"--sd-accent": text,
			"--sd-line": text,
		};
	};
	return (
		// Outside its dates a banner is not there at all; the editor keeps it so it can be changed.
		<Show when={active() || env.editing}>
			<Show when={props.el.title || props.el.text} fallback={<Placeholder text="Write an announcement" />}>
				<div
					class="sd-banner"
					classList={{ "sd-banner-inactive": !active() }}
					data-style={props.el.style}
					data-align={props.el.align}
					data-animation={env.lowColor() ? "none" : props.el.animation}
					style={style()}
				>
					<Show when={props.el.emoji}>
						<div class="sd-banner-emoji" style={{ "font-size": px(props.el.titleSize * 1.5) }}>
							{props.el.emoji}
						</div>
					</Show>
					<div class="sd-banner-body">
						<Show when={props.el.title}>
							<div class="sd-banner-title" style={{ "font-size": px(props.el.titleSize) }}>
								{props.el.title}
							</div>
						</Show>
						<Show when={props.el.text}>
							<Markdown text={props.el.text} class="sd-banner-text" style={{ "font-size": px(props.el.size) }} />
						</Show>
					</div>
					<Show when={!active()}>
						<div class="sd-banner-note">Not on screens now: outside its dates</div>
					</Show>
				</div>
			</Show>
		</Show>
	);
}

// --------------------------------------------------------------------- menu

export function Menu(props: RendererProps<El<"menu">>) {
	const sections = createMemo(() => menuSections(props.el.items, props.el.soldOut === "hidden"));
	const tags = (allergens: string) =>
		allergens
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
	return (
		<div class="sd-menu" style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<div class="sd-menu-sections" style={{ "column-count": String(Math.max(1, Math.round(props.el.columnCount))) }}>
				<For each={sections()} fallback={<Placeholder text="Add a dish" />}>
					{(section) => (
						<div class="sd-menu-section">
							<Show when={section.name}>
								<div class="sd-menu-heading" style={{ "font-size": px(props.el.headingSize) }}>
									{section.name}
								</div>
							</Show>
							<For each={section.items}>
								{(item) => (
									<div class="sd-menu-item" data-sold={item.soldOut ? props.el.soldOut : undefined}>
										<div class="sd-menu-line">
											<span class="sd-menu-name">{item.name}</span>
											<Show when={item.soldOut && props.el.soldOut === "badge"}>
												<span class="sd-menu-badge">{props.el.soldOutLabel}</span>
											</Show>
											<Show when={item.price.trim()}>
												<span class="sd-menu-leader" classList={{ "sd-menu-leader-dots": props.el.dots }} />
												<span class="sd-menu-price">
													{menuPrice(item.price, props.el.currencyBefore, props.el.currencyAfter)}
												</span>
											</Show>
										</div>
										<Show when={item.description}>
											<div class="sd-menu-description">{item.description}</div>
										</Show>
										<Show when={props.el.allergens && tags(item.allergens).length}>
											<div class="sd-menu-allergens">
												<For each={tags(item.allergens)}>{(tag) => <span class="sd-menu-allergen">{tag}</span>}</For>
											</div>
										</Show>
									</div>
								)}
							</For>
						</div>
					)}
				</For>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------- PDF

type PdfModule = typeof PdfJs;
let pdfLibrary: Promise<PdfModule> | undefined;
/**
 * pdf.js is big and rarely needed, so like MapLibre it is not part of the
 * bundle: the build copies it to `vendor/pdfjs/` and it is fetched the first
 * time a PDF is shown.
 */
function loadPdfJs(): Promise<PdfModule> {
	pdfLibrary ??= (async () => {
		// A computed specifier keeps the bundler from following the import.
		const specifier = url("vendor/pdfjs/pdf.min.mjs");
		const library = (await import(specifier)) as PdfModule;
		library.GlobalWorkerOptions.workerSrc = url("vendor/pdfjs/pdf.worker.min.mjs");
		return library;
	})();
	pdfLibrary.catch(() => {
		pdfLibrary = undefined;
	});
	return pdfLibrary;
}

export function Pdf(props: RendererProps<El<"pdf">>) {
	const env = useDisplay();
	let frame!: HTMLDivElement;
	let canvas!: HTMLCanvasElement;
	const [doc, setDoc] = createSignal<PdfJs.PDFDocumentProxy>();
	const [failure, setFailure] = createSignal<string>();
	const [drawn, setDrawn] = createSignal(false);
	const [stamp, setStamp] = createSignal(0);
	const source = () => props.el.src.trim();
	let task: PdfJs.PDFDocumentLoadingTask | undefined;

	// A document on another site may change under its address (today's menu): look again now and then.
	createEffect(() => {
		if (source().startsWith("media/") || props.el.refresh <= 0) return;
		const timer = setInterval(() => setStamp(Date.now()), Math.max(5, props.el.refresh) * 60_000);
		onCleanup(() => clearInterval(timer));
	});

	createEffect(
		on([source, stamp, env.refreshKey], ([src], previous) => {
			const again = previous?.[0] === src;
			if (!again) {
				setDoc(undefined);
				setDrawn(false);
				setFailure(undefined);
			}
			if (!src) return;
			let cancelled = false;
			onCleanup(() => {
				cancelled = true;
			});
			void (async () => {
				let next: PdfJs.PDFDocumentLoadingTask | undefined;
				try {
					const library = await loadPdfJs();
					// Library files are served as they are; anything else comes through the server,
					// since a browser may not read a file from another site.
					const address = src.startsWith("media/") ? mediaUrl(src) : await env.pictureUrl(props.el as unknown as AnyEl);
					const response = await fetch(address, { credentials: "same-origin" });
					if (address.startsWith("blob:")) URL.revokeObjectURL(address);
					if (!response.ok) throw new Error("no document");
					const data = new Uint8Array(await response.arrayBuffer());
					if (cancelled) return;
					next = library.getDocument({
						data,
						cMapUrl: url("vendor/pdfjs/cmaps/"),
						standardFontDataUrl: url("vendor/pdfjs/standard_fonts/"),
						wasmUrl: url("vendor/pdfjs/wasm/"),
						iccUrl: url("vendor/pdfjs/iccs/"),
					});
					const loaded = await next.promise;
					if (cancelled) return void next.destroy();
					const old = task;
					task = next;
					setFailure(undefined);
					setDoc(loaded);
					void old?.destroy();
				} catch {
					void next?.destroy();
					// A failed refresh keeps the pages already on screen.
					if (!cancelled && !doc()) setFailure("This PDF could not be opened");
				}
			})();
		}),
	);
	onCleanup(() => void task?.destroy());

	const pages = () => doc()?.numPages ?? 0;
	const turn = useRotation(
		() => (props.el.cycle ? pages() : 0),
		() => props.el.interval,
	);
	const pageNumber = () =>
		props.el.cycle ? (turn() % Math.max(1, pages())) + 1 : Math.min(Math.max(1, Math.round(props.el.page)), pages());

	let run = 0;
	let rendering: PdfJs.RenderTask | undefined;
	const draw = async () => {
		const current = doc();
		const mode = env.mode();
		const fit = props.el.fit;
		const number = pageNumber();
		if (!current || !frame) return;
		const mine = ++run;
		try {
			const page = await current.getPage(number);
			// The stage is scaled with a CSS transform, so measure real pixels.
			const box = frame.getBoundingClientRect();
			if (mine !== run || !box.width || !box.height) return;
			const natural = page.getViewport({ scale: 1 });
			const ratios = [box.width / natural.width, box.height / natural.height];
			const density = Math.min(window.devicePixelRatio || 1, 2);
			let scale = (fit === "cover" ? Math.max(...ratios) : Math.min(...ratios)) * density;
			scale *= 2600 / Math.max(natural.width * scale, natural.height * scale, 2600);
			const viewport = page.getViewport({ scale });
			// Drawn off screen first, so the page being replaced stays up until the new one is ready.
			const buffer = document.createElement("canvas");
			buffer.width = Math.max(1, Math.round(viewport.width));
			buffer.height = Math.max(1, Math.round(viewport.height));
			rendering?.cancel();
			rendering = page.render({ canvas: buffer, viewport });
			await rendering.promise;
			if (mine !== run) return;
			canvas.width = buffer.width;
			canvas.height = buffer.height;
			const context = canvas.getContext("2d", { willReadFrequently: true });
			if (!context) return;
			context.drawImage(buffer, 0, 0);
			if (mode === "mono" || mode === "color6") {
				// The same treatment pictures get: dithered to the panel's inks.
				const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
				dither(pixels.data, canvas.width, canvas.height, mode);
				context.putImageData(pixels, 0, 0);
			}
			setDrawn(true);
		} catch {
			// A cancelled render (a newer one took over) or a broken page: keep what is shown.
		}
	};
	createEffect(on([doc, pageNumber, env.mode, () => props.el.fit], () => void draw()));

	let timer: ReturnType<typeof setTimeout> | undefined;
	const observer = new ResizeObserver(() => {
		clearTimeout(timer);
		timer = setTimeout(draw, 200);
	});
	onMount(() => observer.observe(frame));
	onCleanup(() => {
		observer.disconnect();
		clearTimeout(timer);
		rendering?.cancel();
	});

	return (
		<div
			ref={frame}
			class="sd-pdf sd-media-frame"
			style={{ background: drawn() && props.el.background ? env.ink(props.el.background) : undefined }}
		>
			<canvas
				ref={canvas}
				class="sd-picture sd-pdf-page"
				style={{ "object-fit": props.el.fit, visibility: drawn() ? "visible" : "hidden" }}
			/>
			<Show when={!drawn()}>
				<Placeholder text={source() ? "Opening the PDF…" : "Choose a PDF"} error={failure()} />
			</Show>
		</div>
	);
}

// ------------------------------------------------------------------- social

export function Social(props: RendererProps<El<"social">, SocialData>) {
	const env = useDisplay();
	const minute = useMinute();
	const posts = () => props.data()?.posts ?? [];
	const index = useRotation(
		() => (props.el.variant === "rotate" ? posts().length : 0),
		() => props.el.interval,
	);
	const shown = () => (props.el.variant === "rotate" ? posts().slice(index(), index() + 1) : posts());
	/** "3 h ago", in the instance's language. */
	const ago = (iso: string) => {
		const seconds = (Date.parse(iso) - minute()) / 1000;
		if (!Number.isFinite(seconds)) return "";
		const steps: [Intl.RelativeTimeFormatUnit, number][] = [
			["day", 86_400],
			["hour", 3600],
			["minute", 60],
		];
		const [unit, size] = steps.find(([, s]) => Math.abs(seconds) >= s) ?? steps[2]!;
		let format: Intl.RelativeTimeFormat;
		try {
			format = new Intl.RelativeTimeFormat(env.general().locale || undefined, { numeric: "auto", style: "short" });
		} catch {
			format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
		}
		return format.format(Math.min(0, Math.round(seconds / size)), unit);
	};
	return (
		<div class="sd-social" data-variant={props.el.variant} style={{ "font-size": px(props.el.size) }}>
			<Show when={props.el.title}>
				<div class="sd-title">{props.el.title}</div>
			</Show>
			<For
				each={shown()}
				fallback={
					<Placeholder
						text={
							!props.el.account.trim()
								? "Enter an account or a hashtag"
								: props.loaded()
									? "No public posts to show"
									: "Loading posts…"
						}
						error={props.error()}
					/>
				}
			>
				{(post) => (
					<div class="sd-social-post">
						<Show when={props.el.avatars && post.avatar}>
							<div class="sd-social-avatar">
								<Picture src={post.avatar} fit="cover" />
							</div>
						</Show>
						<div class="sd-social-body">
							<Show when={post.boostedBy}>
								<div class="sd-social-boost">↻ {post.boostedBy}</div>
							</Show>
							<div class="sd-social-head">
								<span class="sd-social-author">{post.author}</span>
								<span class="sd-social-handle">{post.handle}</span>
								<Show when={props.el.dates && post.date}>
									<span class="sd-social-date">{ago(post.date)}</span>
								</Show>
							</div>
							<div class="sd-social-text">{post.text}</div>
						</div>
						<Show when={props.el.images && post.image}>
							<div class="sd-social-image">
								<Picture src={post.image} fit="cover" />
							</div>
						</Show>
					</div>
				)}
			</For>
		</div>
	);
}

// -------------------------------------------------------------------- shape

export function Shape(props: RendererProps<El<"shape">>) {
	const env = useDisplay();
	const style = createMemo((): JSX.CSSProperties => {
		const e = props.el;
		const low = env.lowColor();
		const fill = env.ink(e.fill);
		if (e.shape === "line") {
			return { height: `${Math.max(1, e.thickness)}px`, background: fill, "border-radius": `${e.thickness / 2}px` };
		}
		const stroke = e.strokeColor ? env.ink(e.strokeColor) : "var(--sd-fg)";
		const css: JSX.CSSProperties = {
			"border-radius": e.shape === "ellipse" ? "50%" : e.shape === "rounded" ? `${e.corner}px` : "0",
		};
		if (low && e.layer < 0) {
			// On ePaper a filled backdrop would swallow the text in front of it: keep its outline.
			css.border = `${Math.max(3, e.strokeWidth)}px solid ${stroke}`;
			return css;
		}
		css.background = !low && e.fillTo ? `linear-gradient(${e.angle}deg, ${e.fill}, ${e.fillTo})` : fill;
		if (e.strokeWidth > 0) css.border = `${e.strokeWidth}px solid ${stroke}`;
		if (!low && e.blur > 0) css.filter = `blur(${e.blur}px)`;
		if (!low && e.dropShadow) css["box-shadow"] = "0 18px 50px rgba(0, 0, 0, 0.35)";
		return css;
	});
	return (
		<div class="sd-shape" data-shape={props.el.shape}>
			<div class="sd-shape-fill" style={style()} />
		</div>
	);
}

// --------------------------------------------------------------------- wifi

export function Wifi(props: RendererProps<El<"wifi">>) {
	const secured = () => props.el.security !== "nopass" && Boolean(props.el.password);
	const code = createMemo(() => {
		if (!props.el.ssid) return null;
		try {
			return qrPath(wifiPayload(props.el.ssid, props.el.password, props.el.security, props.el.hidden));
		} catch {
			// Too long for a QR code.
			return null;
		}
	});
	return (
		<Show when={props.el.ssid} fallback={<Placeholder text="Enter the network name" />}>
			<div class="sd-wifi" data-layout={props.el.layout}>
				<Show when={code()}>
					{(qr) => (
						// Always black on white, whatever the layout's colours: that is what cameras read best.
						<div class="sd-wifi-code" style={{ width: `${props.el.codeSize}cqh` }}>
							<svg
								viewBox={`0 0 ${qr().size} ${qr().size}`}
								shape-rendering="crispEdges"
								role="img"
								aria-label="QR code to join the Wi-Fi network"
							>
								<path d={qr().path} fill="#000000" />
							</svg>
						</div>
					)}
				</Show>
				<div class="sd-wifi-text" style={{ "font-size": px(props.el.size) }}>
					<Show when={props.el.title}>
						<div class="sd-wifi-title">{props.el.title}</div>
					</Show>
					<div class="sd-wifi-row">
						<Show when={props.el.networkLabel}>
							<div class="sd-wifi-label">{props.el.networkLabel}</div>
						</Show>
						<div class="sd-wifi-value">{props.el.ssid}</div>
					</div>
					<Show when={props.el.showPassword && secured()}>
						<div class="sd-wifi-row">
							<Show when={props.el.passwordLabel}>
								<div class="sd-wifi-label">{props.el.passwordLabel}</div>
							</Show>
							<div class="sd-wifi-value sd-wifi-password">{props.el.password}</div>
						</div>
					</Show>
				</div>
			</div>
		</Show>
	);
}
