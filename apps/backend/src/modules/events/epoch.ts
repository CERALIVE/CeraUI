import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eventRingEpochSchema } from "@ceraui/rpc/schemas";
import {
	contain,
	EPOCH_FILE,
	type EventStoreDeps,
	resolveEventsDir,
} from "./store.ts";

/**
 * The event ring's identity, kept on disk beside it until a clear removes it.
 * Undefined when it cannot be read or stored: a new one on every read would
 * look like a clear on every read.
 */
export function eventsEpoch(deps: EventStoreDeps = {}): string | undefined {
	return contain(deps, undefined, () => {
		const io = deps.fs ?? fs;
		const base = deps.baseDir ?? resolveEventsDir();
		const file = path.join(base, EPOCH_FILE);
		// A torn or damaged identity names a new ring, which readers treat as a clear.
		if (io.existsSync(file)) {
			const stored = eventRingEpochSchema.safeParse(
				io.readFileSync(file, "utf8"),
			);
			if (stored.success) return stored.data;
		}
		const epoch = randomUUID();
		io.mkdirSync(base, { recursive: true, mode: 0o700 });
		const fd = io.openSync(file, "w", 0o600);
		try {
			io.fchmodSync(fd, 0o600);
			io.appendFileSync(fd, epoch);
			io.fdatasyncSync(fd);
		} finally {
			io.closeSync(fd);
		}
		return epoch;
	});
}
