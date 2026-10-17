import { z } from "zod";
import {
	readStoredStateJson,
	STORED_STATE_LIMITS,
} from "../../system/update-orchestrator/stored-state-file.ts";
import type { RootQdisc } from "./applier.ts";

const rootSchema = z.record(
	z.string().min(1),
	z.object({ kind: z.string(), handle: z.string() }),
);

export async function readShaperOwnership(
	path: string,
): Promise<Record<string, RootQdisc>> {
	const value = await readStoredStateJson(path, STORED_STATE_LIMITS.intent);
	return value === undefined ? {} : rootSchema.parse(value);
}
