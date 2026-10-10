/**
 * Two small derivations the Updates dialog's sections read (Todo 41) that
 * `update-view.ts` does not already answer. Pure and rune-free.
 */
import type {
	UpdateOrchestratorPhase,
	UpdateOrchestratorWireState,
	UpdatePackage,
} from "@ceraui/rpc/schemas";

import { isUpdateBusy } from "./update-view";

/** The orchestrator phases that describe the system image rather than packages. */
export const SYSTEM_IMAGE_PHASES: readonly UpdateOrchestratorPhase[] = [
	"os-available",
	"os-staging",
	"os-staged",
	"os-activation-armed",
	"os-verifying",
];

/**
 * The System section's activation status: the live phase while it is about
 * the system image, and nothing otherwise — a package download is not a
 * statement about the image the device will boot next.
 */
export function systemImagePhase(
	wire: UpdateOrchestratorWireState | undefined | null,
): UpdateOrchestratorPhase | undefined {
	if (wire === undefined || wire === null) return undefined;
	return SYSTEM_IMAGE_PHASES.includes(wire.phase) ? wire.phase : undefined;
}

const WAITING_PHASES: readonly UpdateOrchestratorPhase[] = [
	"awaiting-idle",
	"os-activation-armed",
];

/**
 * A busy phase that is WAITING (for the device to go idle, for the next
 * restart) rather than working. A spinner beside it would claim activity the
 * device is not performing.
 */
export function isUpdateWaiting(
	phase: UpdateOrchestratorPhase | undefined,
): boolean {
	return phase !== undefined && WAITING_PHASES.includes(phase);
}

const ACTIVITY_OUTCOME_PHASES: readonly UpdateOrchestratorPhase[] = [
	"failed",
	"quarantined",
];

/**
 * The phase the dialog's "Current activity" line states, or `undefined` for
 * none. Work in progress (`isUpdateBusy`) and a failed or set-aside update are
 * worth a line; a resting phase is already told by the section it belongs to.
 * When the System section is on screen it owns the system-image phases, so they
 * are not stated twice.
 */
export function dialogActivityPhase(
	wire: UpdateOrchestratorWireState | undefined | null,
	systemSectionShown: boolean,
): UpdateOrchestratorPhase | undefined {
	if (wire === undefined || wire === null) return undefined;
	if (systemSectionShown && SYSTEM_IMAGE_PHASES.includes(wire.phase))
		return undefined;
	if (isUpdateBusy(wire) || ACTIVITY_OUTCOME_PHASES.includes(wire.phase))
		return wire.phase;
	return undefined;
}

/**
 * Where the INSTALLABLE packages come from, de-duplicated in first-seen order.
 * Only an image that vets origins reports one, so a legacy discovery answers
 * `[]` and the dialog says nothing rather than guessing a repository.
 */
export function actionablePackageOrigins(
	packages: readonly UpdatePackage[],
): string[] {
	const origins: string[] = [];
	for (const pkg of packages) {
		if (
			pkg.actionable === false ||
			pkg.layer === "platform" ||
			pkg.kept_back === true
		)
			continue;
		const origin = pkg.origin?.trim();
		if (origin && !origins.includes(origin)) origins.push(origin);
	}
	return origins;
}
