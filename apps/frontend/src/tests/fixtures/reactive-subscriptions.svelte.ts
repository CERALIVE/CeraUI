/**
 * Reactive test seam for dialogs whose behaviour keys on a config/relays change
 * WHILE the dialog is open (C7 coherence-contract pass).
 *
 * Both EncoderDialog (`config.source` change → draft re-seed + note) and
 * ServerDialog (relays-catalog drift → review note) read their subscription
 * getters inside a `$derived`/`$effect`, so a transition test needs those reads
 * to be genuinely reactive — a plain hoisted object never re-runs the derived.
 * Module-level `$state` in this `.svelte.ts` gives the test settable, reactive
 * holders the subscriptions mock reads through, so a `flag.value = …; flushSync()`
 * from the test drives the component's real reactivity.
 */
import type {
	ConfigMessage,
	RelayMessage,
	SourcesMessage,
} from "@ceraui/rpc/schemas";

let config = $state<ConfigMessage | undefined>(undefined);
let relays = $state<RelayMessage | undefined>(undefined);
let sources = $state<SourcesMessage | undefined>(undefined);

export const reactiveConfig = {
	get value(): ConfigMessage | undefined {
		return config;
	},
	set value(next: ConfigMessage | undefined) {
		config = next;
	},
	reset(): void {
		config = undefined;
	},
};

export const reactiveRelays = {
	get value(): RelayMessage | undefined {
		return relays;
	},
	set value(next: RelayMessage | undefined) {
		relays = next;
	},
	reset(): void {
		relays = undefined;
	},
};

export const reactiveSources = {
	get value(): SourcesMessage | undefined {
		return sources;
	},
	set value(next: SourcesMessage | undefined) {
		sources = next;
	},
	reset(): void {
		sources = undefined;
	},
};
