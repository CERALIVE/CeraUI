// Import-free on purpose: stream-abort.ts reaches the in-flight APT fetch without loading the transport graph.
let inFlight: AbortController | undefined;

/** Register an abortable pinned APT fetch; the returned release forgets it. */
export function trackAptTransfer(controller: AbortController): () => void {
	inFlight = controller;
	return () => {
		if (inFlight === controller) inFlight = undefined;
	};
}

/** Stream-start abort: kill the abortable pinned fetch; its rule is torn down. */
export function abortAptTransferForStream(): void {
	inFlight?.abort();
}
