/**
 * A REACTIVE `wifi` feed double.
 *
 * The production `getWifi()` reads a `$state` value, so a component `$effect`
 * that observes the feed re-runs on every broadcast. A plain `vi.fn()` returning
 * a mutable object is NOT reactive, so a test built on one silently proves that
 * the component ignores late snapshots — which is exactly the behaviour a
 * generation-advance confirmation depends on.
 */
import type { WifiStatus } from "@ceraui/rpc/schemas";

let feed = $state<WifiStatus>({});

export function getWifiFeed(): WifiStatus {
	return feed;
}

export function publishWifi(next: WifiStatus): void {
	feed = next;
}

export function resetWifiFeed(): void {
	feed = {};
}
