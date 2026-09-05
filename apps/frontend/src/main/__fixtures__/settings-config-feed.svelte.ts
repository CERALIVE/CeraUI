/**
 * A REACTIVE `config` feed double for `SettingsView.svelte`.
 *
 * `SettingsView`'s autostart switch follows the authoritative config broadcast,
 * so a non-reactive `vi.fn()` double would prove only that the switch reads the
 * value ONCE at mount — the opposite of the contract. Same reasoning as
 * `tests/helpers/modem-feed.svelte.ts`.
 */
import type { ConfigMessage } from "@ceraui/rpc/schemas";

let feed = $state<ConfigMessage | undefined>(undefined);

export function getConfigFeed(): ConfigMessage | undefined {
	return feed;
}

export function publishConfig(next: ConfigMessage | undefined): void {
	feed = next;
}

export function resetConfigFeed(): void {
	feed = undefined;
}
