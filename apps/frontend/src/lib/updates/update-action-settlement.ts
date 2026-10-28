/**
 * Which device evidence settles an update action whose outcome nobody has
 * confirmed yet. Pure. A phase CHANGE pushed after the request settles it when
 * it is the action's start phase or an outcome the dialog already states; a
 * details read that STARTED after the request settles it when the action's own
 * facts changed from what the dialog showed when the request left: a check's
 * clocks moved, or a different image is staged. The legacy Packages control
 * (`packages`, `system.startUpdate`) is settled by a CHANGE of the legacy
 * `update_state` kind instead: the install running, or its outcome.
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateState,
} from "@ceraui/rpc/schemas";
import { KERNEL_UPDATE_PHASES, kernelUpdatePhase } from "./kernel-update-view";

export type UpdateActionKind =
	| "check"
	| "install"
	| "kernel"
	| "cellular"
	| "packages";
export type LegacyKind = UpdateState["kind"];

type CheckClocks = UpdateDetails["checks"];
type StagedImage = UpdateDetails["os"]["staged"];

/** The device as this dialog last read it when the request left. */
export interface DispatchContext {
	/** The newest details read started before the request; only later reads count. */
	readonly afterRead: number;
	/** `undefined`: the dialog had no details, so no change can be measured. */
	readonly clocks: CheckClocks | undefined;
	readonly staged: StagedImage | undefined;
	readonly kernel?: UpdateDetails["kernel"];
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
	kernel: KERNEL_UPDATE_PHASES,
	cellular: INSTALL_STARTED,
	packages: [],
};

const LEGACY_SETTLES: readonly LegacyKind[] = [
	"downloading",
	"installing",
	"update_preflight_failed",
	"failed",
	"success",
];

/** A legacy `update_state` kind CHANGE pushed after the request. */
export function legacySettles(
	action: UpdateActionKind,
	kind: LegacyKind,
): boolean {
	return action === "packages" && LEGACY_SETTLES.includes(kind);
}

/** A failed or set-aside update is an outcome the dialog already states. */
const OUTCOME_PHASES: readonly UpdateOrchestratorPhase[] = [
	"failed",
	"quarantined",
];

export function phaseSettles(
	action: UpdateActionKind,
	phase: UpdateOrchestratorPhase,
): boolean {
	if (action === "packages") return false;
	if (action === "kernel") return KERNEL_UPDATE_PHASES.includes(phase);
	return STARTED_BY[action].includes(phase) || OUTCOME_PHASES.includes(phase);
}

function clocksMoved(before: CheckClocks, after: CheckClocks): boolean {
	return (
		before.os.lastAttemptAt !== after.os.lastAttemptAt ||
		before.packages.lastAttemptAt !== after.packages.lastAttemptAt
	);
}

function stagedChanged(before: StagedImage, after: StagedImage): boolean {
	if (after === null) return false;
	return (
		before === null ||
		before.version !== after.version ||
		before.stagedAt !== after.stagedAt
	);
}

export function readSettles(
	action: UpdateActionKind,
	watch: DispatchContext,
	details: UpdateDetails,
): boolean {
	switch (action) {
		case "kernel": {
			const next = details.kernel;
			const phase = kernelUpdatePhase(undefined, next);
			return (
				watch.kernel !== undefined &&
				next !== undefined &&
				phase !== undefined &&
				KERNEL_UPDATE_PHASES.includes(phase) &&
				(watch.kernel.state !== next.state ||
					watch.kernel.version !== next.version)
			);
		}
		case "check":
			return (
				watch.clocks !== undefined && clocksMoved(watch.clocks, details.checks)
			);
		case "install":
		case "cellular":
			return (
				watch.staged !== undefined &&
				stagedChanged(watch.staged, details.os.staged)
			);
		case "packages":
			return false;
		default: {
			const unreachable: never = action;
			return unreachable;
		}
	}
}
