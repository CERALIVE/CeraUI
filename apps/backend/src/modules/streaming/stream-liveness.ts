import type { SessionLiveness } from "./stream-session-ownership.ts";

// The composition root installs its reader; early/cyclic consumers stay unknown.
let readLiveness: () => SessionLiveness = () => "unknown";

export function bindStreamLiveness(reader: () => SessionLiveness): void {
	readLiveness = reader;
}

export function streamLiveness(): SessionLiveness {
	return readLiveness();
}
