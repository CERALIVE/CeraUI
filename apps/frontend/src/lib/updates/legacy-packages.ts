/**
 * The legacy Packages section's reading of the ONE update state (Todo 24 /
 * Todo 14). Pure.
 */
import type { UpdatePackage, UpdateState } from "@ceraui/rpc/schemas";

type Available = Extract<UpdateState, { kind: "available" }>;

/**
 * A package the device positively will NOT install: it said so outright, it
 * named the layer that ships with the next OS image, or apt held it back. An
 * entry carrying none of them was never classified, and banding it would be a
 * claim nothing measured.
 */
export function isWithheld(pkg: UpdatePackage): boolean {
	return (
		pkg.actionable === false ||
		pkg.layer === "platform" ||
		pkg.kept_back === true
	);
}

export function availableOf(
	state: UpdateState | undefined,
): Available | undefined {
	return state?.kind === "available" ? state : undefined;
}

/**
 * The ONLY gate on Install: the device's own `actionable_count`. Its ABSENCE
 * means "not classified", never "zero installable", so a backend predating
 * the classification keeps the button it has always had.
 */
export function actionableCountOf(available: Available | undefined): number {
	if (available === undefined) return 0;
	if (available.actionable_count !== undefined)
		return available.actionable_count;
	const classified = available.packages ?? [];
	return classified.length > 0
		? classified.filter((pkg) => !isWithheld(pkg)).length
		: available.package_count;
}

/** The stamped completion of the device's last package discovery, if any. */
export function checkedAtOf(
	state: UpdateState | undefined,
): number | undefined {
	return state !== undefined && "checked_at" in state
		? state.checked_at
		: undefined;
}
