/** What the Twitch element's server and renderer both need to know about Twitch. */

/** The channel behind a name or a channel address (`twitch.tv/name`), in lower case; empty when it is neither. */
export function twitchChannel(input: string): string {
	const match = /^(?:(?:https?:\/\/)?(?:www\.|m\.)?twitch\.tv\/)?@?([a-z0-9_]{1,25})\/?(?:[?#].*)?$/i.exec(
		input.trim(),
	);
	return match ? match[1]!.toLowerCase() : "";
}

/**
 * Whether Twitch lets a page at this address embed its player. Every embed
 * names its parent page, and Twitch refuses one that is not served over HTTPS
 * under a host name; `localhost` is the one exception.
 */
export function twitchAllows(protocol: string, hostname: string): boolean {
	if (hostname === "localhost") return true;
	const address = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
	return protocol === "https:" && !address;
}
