import { logger } from "../../helpers/logger.ts";
import { handleIngestSlots } from "./ingest-slots.ts";
import {
	type Command,
	PROTOCOL_VERSION,
	type Result,
	type ResultPayload,
} from "./protocol.ts";
import { handleSetProfile } from "./set-profile.ts";

export interface InternalCommandDeps {
	readonly sendResult: (frame: Result) => boolean;
}

function resultFrame(frame: Command, payload: ResultPayload): Result {
	return {
		v: PROTOCOL_VERSION,
		kind: "result",
		type: frame.type,
		cid: frame.cid,
		...(frame.role !== undefined ? { role: frame.role } : {}),
		payload,
	};
}

function emit(
	deps: InternalCommandDeps,
	frame: Command,
	payload: ResultPayload,
): void {
	deps.sendResult(resultFrame(frame, payload));
}

async function routeSetProfile(
	frame: Command,
	deps: InternalCommandDeps,
): Promise<void> {
	try {
		const ack = await handleSetProfile(frame.payload);
		if (ack === null) {
			emit(deps, frame, {
				ok: false,
				applied: null,
				error: "invalid_set_profile",
			});
			return;
		}
		emit(deps, frame, {
			ok: ack.status === "applied",
			applied: ack,
			...(ack.status === "rejected" && ack.reason !== undefined
				? { error: ack.reason }
				: {}),
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.warn(`control-command: ${frame.type} failed: ${message}`);
		emit(deps, frame, {
			ok: false,
			applied: null,
			error: message,
		});
	}
}

export async function routeInternalCommand(
	frame: Command,
	deps: InternalCommandDeps,
): Promise<void> {
	switch (frame.type) {
		case "ingest.slots": {
			const accounts = handleIngestSlots(frame.payload);
			emit(
				deps,
				frame,
				accounts === null
					? { ok: false, applied: null, error: "invalid_ingest_slots" }
					: { ok: true, applied: accounts },
			);
			return;
		}
		case "device.setProfile":
			await routeSetProfile(frame, deps);
			return;
		default:
			emit(deps, frame, { ok: false, applied: null, error: "unknown_command" });
	}
}
