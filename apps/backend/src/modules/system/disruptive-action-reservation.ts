import { SpawnTimeoutError } from "../../helpers/bounded-spawn.ts";
import type {
	DisruptiveActionDecision,
	UpdateBusyReason,
} from "./disruptive-action-gate.ts";

export type DisruptiveRefusalReason = Extract<
	DisruptiveActionDecision,
	{ allowed: false }
>["reason"];

export class DisruptiveActionRefusal extends Error {
	override readonly name = "DisruptiveActionRefusal";
	constructor(readonly reason: DisruptiveRefusalReason) {
		super(reason);
	}
}

export class PowerSubmissionError extends Error {
	override readonly name = "PowerSubmissionError";
	constructor(
		readonly command: string,
		readonly exitCode: number | null,
	) {
		super(`${command} exited with status ${String(exitCode)}`);
	}
}

export type DisruptiveReservation = {
	readonly releaseAfterFailure: () => void;
	readonly releaseAfterCompletion: () => void;
};
export type DisruptiveReservationOutcome =
	| { readonly allowed: true; readonly reservation: DisruptiveReservation }
	| Extract<DisruptiveActionDecision, { allowed: false }>;

let pending: symbol | undefined;
let readUpdateBusy: () => readonly UpdateBusyReason[] = () => [
	"update-recovery",
];

export function setDisruptiveUpdateBusySource(
	read: () => readonly UpdateBusyReason[],
): void {
	readUpdateBusy = read;
}
export function readDisruptiveUpdateBusy(): readonly UpdateBusyReason[] {
	return readUpdateBusy();
}

export function isDisruptiveActionPending(): boolean {
	return pending !== undefined;
}

export function assertDisruptiveActionFree(): void {
	if (isDisruptiveActionPending())
		throw new DisruptiveActionRefusal("update_in_progress");
}

export function isPositiveDisruptiveFailure(error: unknown): boolean {
	if (error instanceof SpawnTimeoutError) return false;
	if (error instanceof PowerSubmissionError) return error.exitCode !== null;
	if (!(error instanceof Error)) return false;
	const code: unknown = Reflect.get(error, "code");
	return (
		(typeof code === "number" && code > 0) ||
		(typeof code === "string" &&
			["ENOENT", "EACCES", "ENOEXEC", "E2BIG"].includes(code))
	);
}

export function reserveDisruptiveAction(
	decision: DisruptiveActionDecision,
	lifetime: "shutdown" | "service" = "shutdown",
): DisruptiveReservationOutcome {
	if (!decision.allowed) return decision;
	if (pending !== undefined)
		return { allowed: false, reason: "update_in_progress" };
	const identity = Symbol("disruptive-action");
	pending = identity;
	const release = () => {
		if (pending === identity) pending = undefined;
	};
	return {
		allowed: true,
		reservation: {
			releaseAfterFailure: release,
			releaseAfterCompletion: () => {
				if (lifetime === "service") release();
			},
		},
	};
}

export function resetDisruptiveActionReservationForTest(): void {
	pending = undefined;
}
