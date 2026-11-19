import type { SessionLiveness } from "./stream-session-ownership.ts";

// The composition root installs its reader; early/cyclic consumers stay unknown.
let owner = { read: (): SessionLiveness => "unknown" };

/** Bind a reader and return the cleanup for a scoped binding. */
export function bindStreamLiveness(reader: () => SessionLiveness): () => void {
	const previous = owner;
	const binding = { read: reader };
	owner = binding;
	return () => {
		if (owner === binding) owner = previous;
	};
}

export function streamLiveness(): SessionLiveness {
	return owner.read();
}
