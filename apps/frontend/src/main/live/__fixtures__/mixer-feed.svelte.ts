/**
 * Test-only reactive stand-in for `$lib/rpc/subscriptions.svelte` as AudioMixer
 * reads it. Module-level `$state.raw` (compiled by the svelte vitest plugin
 * because the file ends in `.svelte.ts`), replaced whole the way the real
 * broadcast handlers replace each message, so a test that changes the device
 * roster mid-session re-runs the mixer exactly as a status broadcast does.
 */
type Message = Record<string, unknown> | undefined;

let status = $state.raw<Message>(undefined);
let level = $state.raw<Message>(undefined);
let sources = $state.raw<Message>(undefined);
let connected = $state(true);

export const feed = {
	get status(): Message {
		return status;
	},
	set status(next: Message) {
		status = next;
	},
	get level(): Message {
		return level;
	},
	set level(next: Message) {
		level = next;
	},
	get sources(): Message {
		return sources;
	},
	set sources(next: Message) {
		sources = next;
	},
	get connected(): boolean {
		return connected;
	},
	set connected(next: boolean) {
		connected = next;
	},
};

export const getStatus = (): Message => feed.status;
export const getAudioLevel = (): Message => feed.level;
export const getSources = (): Message => feed.sources;
export const getConfig = (): undefined => undefined;
export const getIsConnected = (): boolean => feed.connected;
