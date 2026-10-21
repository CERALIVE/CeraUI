import { createHash, randomUUID } from "node:crypto";
import type { UpdateState } from "@ceraui/rpc/schemas";
import type { DownloadInterruption } from "./download-paused-ledger.ts";

export function holdCandidateKey(identity: string): string {
	return createHash("sha256").update(identity).digest("hex");
}

export function packageDownloadAttempt(
	wire: UpdateState,
): DownloadInterruption {
	const identity = "identity" in wire ? wire.identity : undefined;
	return {
		id: `packages:${randomUUID()}`,
		candidate: holdCandidateKey(JSON.stringify(identity ?? null)),
	};
}
