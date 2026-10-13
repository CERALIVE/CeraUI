import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { writeFileAtomicSync } from "../../helpers/config-loader.ts";
import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "./update-orchestrator/stored-state-file.ts";

const idleStateSchema = z
	.object({ lastStreamEndedAt: z.number().int().nonnegative().nullable() })
	.strict();
export const IDLE_STATE_FILE = "/data/ceralive/update-state/idle.json";

export class IdleStateReadError extends Error {
	override readonly name = "IdleStateReadError";
	readonly reason = "activity-unknown";
	constructor(cause: unknown) {
		super("idle_state_unreadable", { cause });
	}
}

const bootAt = Date.now();
let filePath: string | null =
	process.env.NODE_ENV === "production" ? IDLE_STATE_FILE : null;
let loaded = false;
let lastStreamEndedAt: number | null = null;
let lastPreviewEndedAt: number | null = null;
let lastStartLeaseEndedAt: number | null = null;
let lastUiHeartbeatAt: number | null = null;

export function setIdleStateFilePathForTest(path: string | null): void {
	filePath = path;
	loaded = false;
	lastStreamEndedAt = null;
	lastPreviewEndedAt = null;
	lastStartLeaseEndedAt = null;
	lastUiHeartbeatAt = null;
}

export async function loadIdleState(): Promise<number | null> {
	if (filePath === null) return lastStreamEndedAt;
	if (!loaded) {
		let endedAt: number | null;
		try {
			const value = await readStoredStateJson(
				filePath,
				STORED_STATE_LIMITS.settings,
			);
			endedAt =
				value === undefined
					? null
					: idleStateSchema.parse(value).lastStreamEndedAt;
		} catch (cause) {
			throw new IdleStateReadError(cause);
		}
		if (!loaded) {
			lastStreamEndedAt = endedAt;
			// A future end time cannot grant idle and may be a clock or file fault:
			// it is not cached, so a repaired file or corrected clock is read again.
			loaded = endedAt === null || endedAt <= Date.now();
		}
	}
	return lastStreamEndedAt;
}

export function noteStreamEnded(now = Date.now()): void {
	lastStreamEndedAt = now;
	loaded = true;
	if (filePath === null) return;
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	writeFileAtomicSync(filePath, JSON.stringify({ lastStreamEndedAt: now }));
}

export function notePreviewEnded(now = Date.now()): void {
	lastPreviewEndedAt = now;
}
export function noteStartLeaseEnded(now = Date.now()): void {
	lastStartLeaseEndedAt = now;
}
export function noteUiHeartbeat(now = Date.now()): void {
	lastUiHeartbeatAt = now;
}
export function getIdleMemory(): Readonly<{
	bootAt: number;
	preview: number | null;
	startLease: number | null;
	ui: number | null;
}> {
	return {
		bootAt,
		preview: lastPreviewEndedAt,
		startLease: lastStartLeaseEndedAt,
		ui: lastUiHeartbeatAt,
	};
}
