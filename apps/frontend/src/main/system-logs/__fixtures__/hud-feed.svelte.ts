/**
 * A reactive stand-in for `$lib/stores/hud.svelte`: like the real store, each
 * `getHudFeed()` call returns a fresh plain snapshot read from rune state, so a
 * consumer only follows changes if it reads the getter inside a reactive scope.
 */
const feed = $state({ isStreaming: false, isFullyStale: false });

export function getHudFeed(): { isStreaming: boolean; isFullyStale: boolean } {
	return { isStreaming: feed.isStreaming, isFullyStale: feed.isFullyStale };
}

export function setHudFeed(isStreaming: boolean, isFullyStale: boolean): void {
	feed.isStreaming = isStreaming;
	feed.isFullyStale = isFullyStale;
}
