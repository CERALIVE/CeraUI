import type { DisruptiveActionDecision } from "./disruptive-action-gate.ts";

type RefusalReason = Extract<
	DisruptiveActionDecision,
	{ allowed: false }
>["reason"];

export function isDisruptiveActionRefusalReason(
	reason: string,
): reason is RefusalReason {
	return (
		reason === "streaming" ||
		reason === "stream_liveness_unknown" ||
		reason === "update_in_progress"
	);
}

export class DisruptiveActionRefusedError extends Error {
	override readonly name = "DisruptiveActionRefusedError";
	constructor(readonly reason: RefusalReason) {
		super(reason);
	}
}
