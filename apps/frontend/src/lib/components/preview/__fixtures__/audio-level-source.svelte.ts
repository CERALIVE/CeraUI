/**
 * Test-only reactive stand-in for `$lib/rpc/subscriptions.svelte`'s
 * `getAudioLevel()` getter.
 *
 * Mirrors `lib/components/custom/__fixtures__/connection-state.svelte.ts`: a
 * module-level Svelte `$state` (compiled by the svelte vitest plugin because the
 * file ends in `.svelte.ts`) that a test drives via {@link setAudioLevel}.
 *
 * This is load-bearing for the frozen-meter regression, not convenience. That
 * bug is about frames that KEEP ARRIVING with unchanging content, so the test
 * has to actually re-deliver them: a plain `let` behind the getter is invisible
 * to `$derived`, so the component would simply never see a second frame and
 * would go stale for the "the feed stopped" reason instead — passing the
 * assertion while proving nothing. Reading through this `$state` tracks the
 * signal, so each write genuinely re-runs the component's liveness effect,
 * exactly as the real `subscriptions.svelte` broadcast handler does.
 */
import type { AudioLevelMessage, ConfigMessage } from "@ceraui/rpc/schemas";

let level = $state<AudioLevelMessage | undefined>(undefined);
let asrc = $state<string | undefined>(undefined);

/** Mirrors the real `subscriptions.svelte` getter consumed by LiveAudioMeter. */
export function getAudioLevel(): AudioLevelMessage | undefined {
	return level;
}

/**
 * The meter reads only `config.asrc` (its selection gate), so the fixture serves
 * that one field rather than a whole synthetic config.
 */
export function getConfig(): ConfigMessage | undefined {
	return asrc === undefined
		? undefined
		: ({ asrc } as unknown as ConfigMessage);
}

/** Deliver one `audio-level` frame (or clear the feed) from a test. */
export function setAudioLevel(next: AudioLevelMessage | undefined): void {
	level = next;
}

/** Change the operator's audio-source pick from a test. */
export function setAudioSelection(next: string | undefined): void {
	asrc = next;
}
