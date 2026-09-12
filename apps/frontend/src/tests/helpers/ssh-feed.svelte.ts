/**
 * A REACTIVE `ssh` status-feed double.
 *
 * The production `getSsh()` reads a `$state` value, so a component `$derived`
 * that observes it re-runs on every broadcast. A plain `vi.fn()` returning a
 * mutable object is NOT reactive, so a test built on one would silently prove
 * that the dialog IGNORES late snapshots — which is exactly the behaviour the
 * pessimistic-confirmation contract forbids, and the property the persistence
 * toggle's tests are asserting. Mirrors `modem-feed.svelte.ts`.
 */
import type { SshStatus } from "@ceraui/rpc/schemas";

let feed = $state<SshStatus | undefined>(undefined);

export function getSshFeed(): SshStatus | undefined {
	return feed;
}

export function publishSsh(next: SshStatus | undefined): void {
	feed = next;
}

export function resetSshFeed(): void {
	feed = undefined;
}
