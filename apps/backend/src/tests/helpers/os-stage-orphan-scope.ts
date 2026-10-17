import { afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import type { OsOrphanLock } from "../../modules/system/update-orchestrator/os-stage-orphan-lock.ts";

type OrphanScope = {
	readonly cancel: AbortController;
	readonly roots: string[];
	readonly joins: Promise<unknown>[];
	readonly leases: OsOrphanLock[];
	body: Promise<void>;
};
const scopes = new Set<OrphanScope>();
let active: OrphanScope | undefined;

export function orphanBody<T extends unknown[]>(
	body: (...args: T) => Promise<void>,
): (...args: T) => Promise<void> {
	return (...args) => {
		const scope: OrphanScope = {
			cancel: new AbortController(),
			roots: [],
			joins: [],
			leases: [],
			body: Promise.resolve(),
		};
		scopes.add(scope);
		active = scope;
		scope.body = body(...args).catch((error: unknown) => {
			if (scope.cancel.signal.aborted && error === scope.cancel.signal.reason)
				return;
			throw error;
		});
		return scope.body;
	};
}

export function orphanScope(): OrphanScope {
	if (!active) throw new Error("orphan fixture requires a scoped test body");
	return active;
}

export function scopedOrphanLock(
	scope: OrphanScope,
	acquire: () => Promise<OsOrphanLock>,
): Promise<OsOrphanLock> {
	scope.cancel.signal.throwIfAborted();
	const acquisition = acquire().then(async (lease) => {
		let disposal: Promise<void> | undefined;
		const tracked: OsOrphanLock = {
			...(lease.pid ? { pid: lease.pid } : {}),
			held: lease.held,
			[Symbol.asyncDispose]: () => (disposal ??= lease[Symbol.asyncDispose]()),
		};
		scope.leases.push(tracked);
		if (scope.cancel.signal.aborted) {
			await tracked[Symbol.asyncDispose]();
			scope.cancel.signal.throwIfAborted();
		}
		return tracked;
	});
	scope.joins.push(acquisition);
	return acquisition;
}

export async function finishOrphanScopes(): Promise<void> {
	for (const scope of scopes) {
		scope.cancel.abort();
		const disposals = await Promise.allSettled(
			scope.leases.map((lease) => lease[Symbol.asyncDispose]()),
		);
		await Promise.allSettled([...scope.joins, scope.body]);
		for (const root of scope.roots)
			await rm(root, { recursive: true, force: true });
		for (const result of disposals) {
			if (
				result.status === "rejected" &&
				result.reason !== scope.cancel.signal.reason
			)
				throw result.reason;
		}
	}
	scopes.clear();
	active = undefined;
}
afterEach(finishOrphanScopes);
