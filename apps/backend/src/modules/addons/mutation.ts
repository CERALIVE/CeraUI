import { AsyncLocalStorage } from "node:async_hooks";
import type { AddonState } from "@ceraui/rpc/schemas";

const owners = new AsyncLocalStorage<ReadonlyMap<string, symbol>>();
const activeOwners = new Map<string, symbol>();
const tails = new Map<string, Promise<void>>();
const revisions = new Map<string, number>();
const refusalBaselines = new AsyncLocalStorage<{
	readonly id: string;
	readonly state: AddonState | undefined;
	readonly userConfig?: Record<string, unknown>;
}>();
const activeBaselines = new Set<object>();

export function addonRefusalBaseline(id: string):
	| {
			readonly state: AddonState | undefined;
			readonly userConfig?: Record<string, unknown>;
	  }
	| undefined {
	const baseline = refusalBaselines.getStore();
	return baseline?.id === id && activeBaselines.has(baseline)
		? baseline
		: undefined;
}

export async function withAddonRefusalBaseline<T>(
	baseline: {
		readonly id: string;
		readonly state: AddonState | undefined;
		readonly userConfig?: Record<string, unknown>;
	},
	mutation: () => Promise<T>,
): Promise<T> {
	activeBaselines.add(baseline);
	try {
		return await refusalBaselines.run(baseline, mutation);
	} finally {
		activeBaselines.delete(baseline);
	}
}

export function hasAddonMutation(id: string): boolean {
	return activeOwners.has(id);
}

export function outsideAddonMutation<T>(callback: () => T): T {
	return owners.exit(() => refusalBaselines.exit(callback));
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
	const inheritedOwner = inherited?.get(id);
	if (inheritedOwner !== undefined && activeOwners.get(id) === inheritedOwner)
		return mutation();
	const previous = tails.get(id);
	const released = Promise.withResolvers<void>();
	tails.set(id, released.promise);
	await previous;
	const owner = Symbol(id);
	activeOwners.set(id, owner);
	try {
		return await owners.run(
			new Map([...(inherited ?? []), [id, owner]]),
			mutation,
		);
	} finally {
		activeOwners.delete(id);
		released.resolve();
		if (tails.get(id) === released.promise) tails.delete(id);
	}
}
