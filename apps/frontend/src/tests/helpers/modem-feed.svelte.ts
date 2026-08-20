/**
 * A REACTIVE `modems` feed double.
 *
 * The production `getModems()` reads a `$state` value, so a component `$effect`
 * that observes the feed re-runs on every broadcast. A plain `vi.fn()` returning
 * a mutable object is NOT reactive, so a test built on one silently proves that
 * the component ignores late snapshots — which is precisely the behaviour the
 * pessimistic-confirmation contract forbids. This keeps the double reactive.
 */
import type { ModemList } from "@ceraui/rpc/schemas";

let feed = $state<ModemList>({});

export function getModemsFeed(): ModemList {
	return feed;
}

export function publishModems(next: ModemList): void {
	feed = next;
}

export function resetModemsFeed(): void {
	feed = {};
}
