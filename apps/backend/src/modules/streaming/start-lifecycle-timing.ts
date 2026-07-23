import type { StartFailurePhase } from "@ceraui/rpc/schemas";

export type StartDeadlinePhase = Exclude<
	StartFailurePhase,
	"params" | "spawn-sender"
>;

export const START_PHASE_DEADLINES_MS: Readonly<
	Record<StartDeadlinePhase, number>
> = {
	connect: 10_000,
	hello: 10_000,
	subscribe: 10_000,
	"start-rpc": 10_000,
	"playing-wait": 5_000,
};

export const STOP_DEADLINE_MS = 12_000;
