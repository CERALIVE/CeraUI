import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
	loadJsonConfig,
	writeFileAtomicSync,
} from "../../helpers/config-loader.ts";

const idleStateSchema = z
	.object({ lastStreamEndedAt: z.number().int().nonnegative().nullable() })
	.strict();
const DEFAULT_STATE = { lastStreamEndedAt: null };
export const IDLE_STATE_FILE = "/data/ceralive/update-state/idle.json";

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
		const result = await loadJsonConfig(
			filePath,
			idleStateSchema,
			DEFAULT_STATE,
		);
		if (!loaded) {
			lastStreamEndedAt = result.data.lastStreamEndedAt;
			loaded = true;
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
