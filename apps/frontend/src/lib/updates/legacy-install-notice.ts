/**
 * The ONE owner of the legacy install's terminal announcement (early oracle
 * F1/F3).
 *
 * Layout calls it with every `status.updating` value it receives; the overlay
 * calls it too when it is rendered on its own. Each terminal object is
 * announced once: the store keeps an unchanged frame's identity
 * (`preserveWireIdentity`), so a repeated frame, a re-mounted Layout or a
 * second caller sees the same object and stays quiet, while a new run's result
 * is a new object and is announced.
 */
import { m } from "@ceraui/i18n/svelte";
import type { StatusMessage } from "@ceraui/rpc/schemas";
import { toast } from "svelte-sonner";

import { legacyInstall } from "./legacy-install";

const announced = new WeakSet<object>();

/** The device's failure text, or one honest sentence when it sent none. */
export function legacyFailureDescription(reason: string): string {
	return reason.trim() === ""
		? m["settings.updates.failedReasonGeneric"]()
		: reason;
}

export function announceLegacyInstallOutcome(
	updating: StatusMessage["updating"] | undefined,
): void {
	const install = legacyInstall(updating);
	if (install.kind !== "succeeded" && install.kind !== "failed") return;
	if (announced.has(install.details)) return;
	announced.add(install.details);
	if (install.kind === "failed") {
		toast.error(m["updatingOverlay.failedMessage"](), {
			description: legacyFailureDescription(install.reason),
		});
		return;
	}
	toast.success(m["updatingOverlay.successMessage"](), {
		description: m["updatingOverlay.installedDescription"](),
	});
}
