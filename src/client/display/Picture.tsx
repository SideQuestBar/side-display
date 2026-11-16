/**
 * An image that adapts to the screen's colour mode. On colour screens it is a
 * plain <img>; on black-and-white and 6-colour ePaper it is drawn to a canvas
 * and dithered to the panel's inks, which looks far better than letting the
 * panel threshold the picture itself.
 */
import { createEffect, createSignal, type JSX, on, onCleanup, Show } from "solid-js";
import { dither } from "../../shared/color";
import { useDisplay } from "./context";

interface PictureProps {
	src: string;
	fit?: "cover" | "contain";
	/** Which part stays in view when the picture is cropped, in percent from the top left. Default: the centre. */
	focus?: { x: number; y: number };
	class?: string;
	style?: JSX.CSSProperties;
	/** Size the element from the image's own proportions (width 100 %, auto height). */
	natural?: boolean;
	onLoad?: () => void;
}

export function Picture(props: PictureProps) {
	const env = useDisplay();
	const [fallback, setFallback] = createSignal(false);
	const dithered = () => (env.mode() === "mono" || env.mode() === "color6") && !fallback();
	// A new picture gets a new chance at dithering.
	createEffect(
		on(
			() => props.src,
			() => setFallback(false),
		),
	);

	return (
		<Show
			when={dithered()}
			fallback={
				<img
					src={props.src}
					alt=""
					class={`sd-picture ${props.class ?? ""}`}
					classList={{ "sd-picture-natural": props.natural }}
					style={{
						"object-fit": props.fit ?? "cover",
						"object-position": props.focus ? `${props.focus.x}% ${props.focus.y}%` : undefined,
						...props.style,
					}}
					onLoad={() => props.onLoad?.()}
					draggable={false}
				/>
			}
		>
			<Dithered {...props} onFail={() => setFallback(true)} />
		</Show>
	);
}

function Dithered(props: PictureProps & { onFail: () => void }) {
	const env = useDisplay();
	let canvas!: HTMLCanvasElement;
	let image: HTMLImageElement | undefined;
	const [ratio, setRatio] = createSignal<string>();

	const draw = () => {
		const mode = env.mode();
		if (!image?.naturalWidth || mode === "full") return;
		// The stage is scaled with a CSS transform, so measure real pixels.
		const box = canvas.getBoundingClientRect();
		const density = Math.min(window.devicePixelRatio || 1, 2);
		const cap = 1600 / Math.max(box.width * density, box.height * density, 1600);
		const width = Math.max(1, Math.round(box.width * density * cap));
		const height = Math.max(1, Math.round(box.height * density * cap));
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext("2d", { willReadFrequently: true });
		if (!context) return props.onFail();
		const scale =
			(props.fit ?? "cover") === "cover"
				? Math.max(width / image.naturalWidth, height / image.naturalHeight)
				: Math.min(width / image.naturalWidth, height / image.naturalHeight);
		const w = image.naturalWidth * scale;
		const h = image.naturalHeight * scale;
		context.clearRect(0, 0, width, height);
		// The rule of CSS `object-position`: that percentage of the picture lines up with that of the box.
		const fx = (props.focus?.x ?? 50) / 100;
		const fy = (props.focus?.y ?? 50) / 100;
		context.drawImage(image, (width - w) * fx, (height - h) * fy, w, h);
		try {
			const pixels = context.getImageData(0, 0, width, height);
			dither(pixels.data, width, height, mode);
			context.putImageData(pixels, 0, 0);
		} catch {
			// A picture from another site without CORS headers cannot be read back.
			props.onFail();
		}
	};

	createEffect(
		on(
			() => props.src,
			(src) => {
				const next = new Image();
				next.crossOrigin = "anonymous";
				next.onload = () => {
					image = next;
					setRatio(`${next.naturalWidth} / ${next.naturalHeight}`);
					draw();
					props.onLoad?.();
				};
				next.onerror = () => props.onFail();
				next.src = src;
			},
		),
	);
	createEffect(on([env.mode, () => props.fit, () => props.focus?.x, () => props.focus?.y], draw, { defer: true }));

	let timer: ReturnType<typeof setTimeout> | undefined;
	const observer = new ResizeObserver(() => {
		clearTimeout(timer);
		timer = setTimeout(draw, 150);
	});
	queueMicrotask(() => canvas && observer.observe(canvas));
	onCleanup(() => {
		observer.disconnect();
		clearTimeout(timer);
	});

	return (
		<canvas
			ref={canvas}
			class={`sd-picture ${props.class ?? ""}`}
			classList={{ "sd-picture-natural": props.natural }}
			style={{ "aspect-ratio": props.natural ? ratio() : undefined, ...props.style }}
		/>
	);
}
