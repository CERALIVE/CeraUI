import { afterAll, beforeAll } from "bun:test";
import { initialOtaStreamLiveness } from "../../modules/streaming/ota-streaming-marker.ts";
import { bindStreamLiveness } from "../../modules/streaming/stream-liveness.ts";

// Production main.ts loads the session owner, which binds the liveness leaf.
// Suites modelling an initialised backend without loading that owner bind the
// production boot classifier: idle only while the sentinel is physically absent.
export function bindSessionOwnerForTest(): () => void {
	bindStreamLiveness(() => initialOtaStreamLiveness());
	return () => bindStreamLiveness(() => "unknown");
}

/** Binds for the whole file and restores the unbound default afterwards. */
export function useSessionOwnerForFile(): void {
	let restore: (() => void) | undefined;
	beforeAll(() => {
		restore = bindSessionOwnerForTest();
	});
	afterAll(() => restore?.());
}
