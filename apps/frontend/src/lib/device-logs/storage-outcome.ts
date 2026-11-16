/**
 * How a System Logs storage action ends. A refusal, an error reply or a
 * rejected call is a value the Storage region renders, never a throw.
 */
import {
	type LogDeleteOlderFilesOutput,
	type LogErrorCode,
	type LogStorage,
	type LogStorageOutput,
	logDeleteOlderFilesOutputSchema,
	logStorageOutputSchema,
	successResponseSchema,
} from "@ceraui/rpc/schemas";

import { parseReply } from "./storage-readout";

type ErrorReply = { readonly ok: false; readonly error: LogErrorCode };
export type ActionReply = { readonly ok: true } | ErrorReply;
export type OkReply<R extends ActionReply> = Extract<R, { readonly ok: true }>;
export type ActionFailure = "refused" | "failed";
export type SaveNote = "saved" | "targetNotMet" | "maintenanceFailed";

/**
 * Settles one storage action. `read` holds the reply to the action's contract,
 * so a success that leaves out or garbles anything it promises is a failure the
 * region can retry, never a half result.
 */
export async function settleAction<R extends ActionReply>(
	call: () => Promise<unknown>,
	read: (reply: unknown) => R,
): Promise<OkReply<R> | ActionFailure> {
	try {
		const reply: ActionReply = read(await call());
		if (reply.ok) return reply as OkReply<R>;
		return reply.error === "UPDATE_IN_PROGRESS" ? "refused" : "failed";
	} catch (error) {
		console.error("System Logs storage action failed:", error);
		return "failed";
	}
}

/** Save limits, delete leftover debug files and clear all answer with the full storage reading. */
export function storageReply(reply: unknown): LogStorageOutput {
	return parseReply(logStorageOutputSchema, reply);
}

/** Delete older log files also answers with the boot counts before and after. */
export function deleteOlderReply(reply: unknown): LogDeleteOlderFilesOutput {
	return parseReply(logDeleteOlderFilesOutputSchema, reply);
}

/** Clear event history answers { success }: read like the others, then mapped onto an action reply. */
export function fromSuccess(response: unknown): ActionReply {
	return parseReply(successResponseSchema, response).success
		? { ok: true }
		: { ok: false, error: "READ_FAILED" };
}

/** Only a maintenance record newer than the one before Save belongs to this save. */
export function saveNote(
	before: LogStorage["lastMaintenance"],
	after: LogStorage["lastMaintenance"],
): SaveNote {
	if (after === null || after.at === before?.at) return "saved";
	if (!after.ok) return "maintenanceFailed";
	return after.targetMet ? "saved" : "targetNotMet";
}
