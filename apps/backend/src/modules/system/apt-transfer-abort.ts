// Import-free on purpose: stream-abort.ts reaches the in-flight APT fetch without loading the transport graph.
let inFlight: AbortController | undefined;
let admissionEpoch = 0;
export type AptTransferAdmission = { readonly cancelled: () => boolean };

export function captureAptTransferAdmission(): AptTransferAdmission {
	const epoch = admissionEpoch;
	return { cancelled: () => admissionEpoch !== epoch };
}

/** Register an abortable pinned APT fetch; the returned release forgets it. */
export function trackAptTransfer(
	controller: AbortController,
	admission?: AptTransferAdmission,
): () => void {
	inFlight = controller;
	if (admission?.cancelled()) controller.abort();
	return () => {
		if (inFlight === controller) inFlight = undefined;
	};
}

/** Stream-start abort: kill the abortable pinned fetch; its rule is torn down. */
export function abortAptTransferForStream(): void {
	admissionEpoch++;
	inFlight?.abort();
}
