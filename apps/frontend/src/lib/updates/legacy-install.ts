/**
 * The ONE reading of the legacy `status.updating` push (early oracle F1/F3).
 * Pure.
 *
 * The device publishes a progress object while it installs, then the same
 * object with `result` (`0`, or the failure text), then clears its own latch
 * and publishes only `update_state`. The store keeps an omitted field on
 * purpose, so the terminal object is the last thing the page hears about
 * `updating`: it must read as FINISHED everywhere, or the takeover, the banner
 * and the power gate it feeds outlive the install they describe.
 */
import type { StatusMessage } from "@ceraui/rpc/schemas";

export type UpdatingProgress = Exclude<
	StatusMessage["updating"],
	boolean | null
>;

export type LegacyInstall =
	| { readonly kind: "none" }
	| { readonly kind: "running"; readonly details: UpdatingProgress | undefined }
	| { readonly kind: "succeeded"; readonly details: UpdatingProgress }
	| {
			readonly kind: "failed";
			readonly details: UpdatingProgress;
			readonly reason: string;
	  };

export function legacyInstall(
	updating: StatusMessage["updating"] | undefined,
): LegacyInstall {
	if (updating === true) return { kind: "running", details: undefined };
	if (updating === false || updating === null || updating === undefined)
		return { kind: "none" };
	const { result } = updating;
	if (result === undefined) return { kind: "running", details: updating };
	if (result === 0) return { kind: "succeeded", details: updating };
	// Any other result is terminal and not a success; only a string carries
	// the device's own words.
	return {
		kind: "failed",
		details: updating,
		reason: typeof result === "string" ? result : "",
	};
}

/** True only while the device reports an install it has not finished. */
export function legacyInstallRunning(
	updating: StatusMessage["updating"] | undefined,
): boolean {
	return legacyInstall(updating).kind === "running";
}
