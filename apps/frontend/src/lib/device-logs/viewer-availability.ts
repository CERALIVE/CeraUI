/**
 * Whether this device can show the System Logs tabs: the view's own copy must
 * load and the backend must answer the logs procedures. An older backend is a
 * calm "not available" state; any other failure is recoverable with a retry.
 */
import { RpcError } from "$lib/rpc/rpc-error";

export type LogViewerAvailability = "ready" | "unavailable" | "failed";

// The backend adapter's reply for a path its router lacks (apps/backend/src/rpc/adapter.ts).
const UNKNOWN_PROCEDURE = "Unknown procedure path: ";

/** The backend predates the logs procedures, or this client has none (`rpc.logs` undefined). */
export function isMissingProcedure(error: unknown): boolean {
	return (
		error instanceof TypeError ||
		(error instanceof RpcError && error.message.startsWith(UNKNOWN_PROCEDURE))
	);
}

export async function checkLogViewer(
	loadCopy: () => Promise<void>,
	probe: () => Promise<unknown>,
): Promise<LogViewerAvailability> {
	const [copy, answer] = await Promise.allSettled([
		loadCopy(),
		Promise.resolve().then(probe),
	]);
	if (copy.status === "rejected") return failed(copy.reason);
	if (answer.status === "fulfilled") return "ready";
	if (isMissingProcedure(answer.reason)) return "unavailable";
	return failed(answer.reason);
}

function failed(reason: unknown): "failed" {
	console.error("System Logs availability check failed:", reason);
	return "failed";
}
