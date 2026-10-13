import { AsyncLocalStorage } from "node:async_hooks";
import type { AddonState } from "@ceraui/rpc/schemas";

const owners = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const refusalBaselines = new AsyncLocalStorage<{
	readonly id: string;
	readonly state: AddonState | undefined;
}>();

export function addonRefusalBaseline(
	id: string,
): { readonly state: AddonState | undefined } | undefined {
	const baseline = refusalBaselines.getStore();
	return baseline?.id === id ? baseline : undefined;
}

export function withAddonRefusalBaseline<T>(
	baseline: { readonly id: string; readonly state: AddonState | undefined },
	mutation: () => Promise<T>,
): Promise<T> {
	return refusalBaselines.run(baseline, mutation);
}

export function addonIntentRevision(id: string): number {
	return revisions.get(id) ?? 0;
}

export function invalidateAddonIntent(id: string): void {
	revisions.set(id, addonIntentRevision(id) + 1);
}

export async function withAddonMutation<T>(
	id: string,
	mutation: () => Promise<T>,
): Promise<T> {
	const inherited = owners.getStore();
	if (inherited?.has(id)) return mutation();
	const previous = tails.get(id);
	const released = Promise.withResolvers<void>();
	tails.set(id, released.promise);
	await previous;
	try {
		return await owners.run(new Set([...(inherited ?? []), id]), mutation);
	} finally {
		released.resolve();
		if (tails.get(id) === released.promise) tails.delete(id);
	}
}
