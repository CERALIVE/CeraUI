/**
 * Reactive test seam for LiveView's streaming-gate transition test.
 *
 * LiveView reads `getIsStreaming()` inside a `$derived`, so a transition test
 * needs that read to be genuinely reactive — a plain hoisted flag never re-runs
 * the derived. Module-level `$state` in this `.svelte.ts` gives the test a
 * settable, reactive `isStreaming` the subscriptions mock reads through, so a
 * `flag.value = …; flushSync()` from the test drives LiveView's real reactivity
 * (the post-stream summary-window `$effect` + `showLiveCockpit`/`summaryMode`).
 */
let streaming = $state(false);

export const streamingFlag = {
	get value(): boolean {
		return streaming;
	},
	set value(next: boolean) {
		streaming = next;
	},
	reset(): void {
		streaming = false;
	},
};
