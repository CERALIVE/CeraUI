/**
 * What may settle an update action whose reply never arrived (C-M1). Pure.
 *
 * The browser stops waiting for a reply after the RPC timeout, but the device
 * does not stop working: `installUpdatesNow` answers only once the OS stage has
 * finished, minutes later. A lost reply is therefore an UNKNOWN outcome, never a
 * refusal, and only the device's own later reports may settle it: a phase it
 * pushed after the request was sent, or a details read STARTED after it. A read
 * that was already in flight describes the device before the request, so it
 * proves nothing either way.
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";

export type UpdateActionKind = "check" | "install" | "cellular";

type CheckClocks = UpdateDetails["checks"];

/** Everything known about one action from the moment it was sent. */
export interface ActionWatch {
	readonly action: UpdateActionKind;
	/** The latest details read started before the request; only later reads count. */
	readonly afterRead: number;
	/** The check clocks when the request was sent, if the dialog had read them. */
	readonly clocks: CheckClocks | undefined;
	/** Every phase the device pushed after the request was sent. */
	readonly phasesSeen: readonly UpdateOrchestratorPhase[];
}

/** What the dialog currently holds from the device. */
export interface ActionEvidence {
	readonly details: UpdateDetails | undefined;
	/** The read sequence number `details` came from. */
	readonly detailsRead: number;
}

const INSTALL_STARTED: readonly UpdateOrchestratorPhase[] = [
	"awaiting-idle",
	"downloading",
	"committing",
	"restarting-services",
	"settled",
	"os-staging",
	"os-staged",
	"os-activation-armed",
	"os-verifying",
];

const STARTED_BY: Readonly<
	Record<UpdateActionKind, readonly UpdateOrchestratorPhase[]>
> = {
	check: ["checking"],
	install: INSTALL_STARTED,
	cellular: INSTALL_STARTED,
};

/** A failed or set-aside update is an outcome the dialog already states. */
const OUTCOME_PHASES: readonly UpdateOrchestratorPhase[] = [
	"failed",
	"quarantined",
];

export function watchAction(
	action: UpdateActionKind,
	afterRead: number,
	details: UpdateDetails | undefined,
): ActionWatch {
	return { action, afterRead, clocks: details?.checks, phasesSeen: [] };
}

export function withPhase(
	watch: ActionWatch,
	phase: UpdateOrchestratorPhase,
): ActionWatch {
	if (watch.phasesSeen.includes(phase)) return watch;
	return { ...watch, phasesSeen: [...watch.phasesSeen, phase] };
}

function checkClocksMoved(before: CheckClocks, after: CheckClocks): boolean {
	return (
		before.os.lastAttemptAt !== after.os.lastAttemptAt ||
		before.packages.lastAttemptAt !== after.packages.lastAttemptAt
	);
}

/** `true` once the device itself has shown what became of the action. */
export function actionSettled(
	watch: ActionWatch,
	evidence: ActionEvidence,
): boolean {
	const started = STARTED_BY[watch.action];
	if (
		watch.phasesSeen.some(
			(phase) => started.includes(phase) || OUTCOME_PHASES.includes(phase),
		)
	)
		return true;
	const { details } = evidence;
	if (details === undefined || evidence.detailsRead <= watch.afterRead)
		return false;
	switch (watch.action) {
		case "check":
			return (
				watch.clocks !== undefined &&
				checkClocksMoved(watch.clocks, details.checks)
			);
		case "install":
		case "cellular":
			return details.os.staged !== null;
		default: {
			const unreachable: never = watch.action;
			return unreachable;
		}
	}
}
