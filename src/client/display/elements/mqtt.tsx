import { createMemo, Show } from "solid-js";
import type { EntitiesData, EntityData } from "../../../shared/data";
import type { El } from "../../../shared/elements";
import type { HaEntityState } from "../../../shared/types";
import { Placeholder, type RendererProps } from "../ElementBox";
import { EntityRows, EntityValue } from "./ha";

// The server hands MQTT messages over in the shape of entity states, so these
// two only differ from their Home Assistant counterparts in what they say
// while there is nothing to show, and in the formula applied to raw payloads.

/**
 * `value × scale + offset` for numeric payloads (a raw reading in mV, a
 * temperature in tenths of a degree); text and the neutral formula pass through.
 */
export function applyFormula(state: HaEntityState, scale: unknown, offset: unknown): HaEntityState {
	// Rows saved before the formula existed have neither property.
	const factor = typeof scale === "number" && Number.isFinite(scale) ? scale : 1;
	const shift = typeof offset === "number" && Number.isFinite(offset) ? offset : 0;
	if (factor === 1 && shift === 0) return state;
	const value = state.state.trim() === "" ? Number.NaN : Number(state.state);
	if (!Number.isFinite(value)) return state;
	// Rounded far beyond any sensor's precision, only to hide binary noise such as 0.30000000000000004.
	return { ...state, state: String(Number((value * factor + shift).toPrecision(12))) };
}

export function MqttValue(props: RendererProps<El<"mqtt">, EntityData>) {
	return (
		<Show
			when={props.data()?.state}
			fallback={
				<Placeholder
					text={props.el.topic.trim() ? `Waiting for a message on ${props.el.topic.trim()}…` : "Enter a topic"}
					error={props.error()}
				/>
			}
		>
			{(state) => <EntityValue state={applyFormula(state(), props.el.scale, props.el.offset)} el={props.el} />}
		</Show>
	);
}

export function MqttList(props: RendererProps<El<"mqtt-list">, EntitiesData>) {
	const rows = createMemo(() =>
		props.el.topics.flatMap((row, i) => {
			const state = props.data()?.states[i];
			return state ? [{ label: row.label || state.name, state: applyFormula(state, row.scale, row.offset) }] : [];
		}),
	);
	return (
		<EntityRows
			el={props.el}
			rows={rows()}
			empty={props.el.topics.length ? "Waiting for messages…" : "Add a topic"}
			error={props.error()}
		/>
	);
}
