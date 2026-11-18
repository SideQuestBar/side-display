/**
 * Data shared across admin pages, loaded once and refreshed on demand.
 */
import { createResource, createRoot, createSignal } from "solid-js";
import type {
	Display,
	GeneralSettings,
	HaAccess,
	HaStatus,
	Layout,
	MediaItem,
	MqttStatus,
	Playlist,
	PlaylistEntry,
} from "../../shared/types";
import { api } from "../lib/api";

export interface SettingsPayload {
	general: GeneralSettings;
	access: HaAccess;
	ha: { url: string; hasToken: boolean; status: HaStatus };
	mqtt: { url: string; username: string; hasPassword: boolean; status: MqttStatus };
}
export interface EntityOption {
	entity_id: string;
	name: string;
	state: string;
	unit: string;
}

export const {
	layouts,
	refetchLayouts,
	folderNames,
	refetchFolders,
	playlists,
	refetchPlaylists,
	displays,
	refetchDisplays,
	media,
	refetchMedia,
	settings,
	refetchSettings,
	entities,
	refetchEntities,
} = createRoot(() => {
	const [layouts, { refetch: refetchLayouts }] = createResource(() => api<Layout[]>("api/layouts"));
	const [folderNames, { refetch: refetchFolders }] = createResource(() => api<string[]>("api/folders"));
	const [playlists, { refetch: refetchPlaylists }] = createResource(() => api<Playlist[]>("api/playlists"));
	const [displays, { refetch: refetchDisplays }] = createResource(() => api<Display[]>("api/displays"));
	const [media, { refetch: refetchMedia }] = createResource(() => api<MediaItem[]>("api/media"));
	const [settings, { refetch: refetchSettings }] = createResource(() => api<SettingsPayload>("api/settings"));
	const [entities, { refetch: refetchEntities }] = createResource(() =>
		api<{ configured: boolean; entities: EntityOption[] }>("api/ha/entities"),
	);
	return {
		layouts,
		refetchLayouts,
		folderNames,
		refetchFolders,
		playlists,
		refetchPlaylists,
		displays,
		refetchDisplays,
		media,
		refetchMedia,
		settings,
		refetchSettings,
		entities,
		refetchEntities,
	};
});

/** The layout folders, sorted; empty ones included. */
export const folders = () => folderNames() ?? [];

/** The playlist a display follows, if it follows one. */
export const playlistOf = (display: Display) =>
	display.playlistId ? (playlists() ?? []).find((p) => p.id === display.playlistId) : undefined;

/** What a display shows: the layouts of its playlist when it follows one, its own otherwise. */
export const shownEntries = (display: Display): PlaylistEntry[] => playlistOf(display)?.entries ?? display.playlist;

/** The displays a layout is on, directly or through a playlist. */
export const displaysShowing = (layoutId: string) =>
	(displays() ?? []).filter((d) => shownEntries(d).some((e) => e.layoutId === layoutId));

/** Album names in use, sorted. */
export const albums = () =>
	[...new Set((media() ?? []).map((m) => m.album).filter(Boolean))].sort((a, b) => a.localeCompare(b));

// ------------------------------------------------------------------- routing
// Hash routes keep the whole admin on one document, which is what makes it
// work unchanged behind Home Assistant ingress or any path prefix.
const parse = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
const [route, setRoute] = createSignal(parse());
window.addEventListener("hashchange", () => setRoute(parse()));

export { route };
export const navigate = (path: string) => {
	location.hash = `#/${path.replace(/^\//, "")}`;
};
