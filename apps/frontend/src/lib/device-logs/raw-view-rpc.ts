import type { LogFollowMessage, LogQueryInput } from "@ceraui/rpc/schemas";
import type { TypedRPC } from "$lib/rpc/client";

import type { ExportSpan } from "./sharing";

export interface RawViewDeps {
	readonly logs: Pick<TypedRPC["logs"], "query" | "followStart" | "followStop">;
	/** Publishes the fixed query before a read, including reads that fail. */
	onQuery?(query: LogQueryInput, span?: ExportSpan): void;
	setFollowListener(
		listener: ((message: LogFollowMessage) => void) | undefined,
	): void;
	now(): number;
}

export const READ_FAILED = { ok: false, error: "READ_FAILED" } as const;

/** Normalize rejected transport calls to the same result shape as a device refusal. */
export async function settleRawRpc<T>(
	call: () => Promise<T>,
	fallback: T,
	label: string,
): Promise<T> {
	try {
		return await call();
	} catch (error) {
		console.error(label, error);
		return fallback;
	}
}
