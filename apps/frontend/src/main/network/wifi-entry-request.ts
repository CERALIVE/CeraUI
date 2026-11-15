import { tick } from "svelte";
import { waitForWifiStatus } from "$lib/rpc/wifi-status-receipt";
import type { WifiRadioBinding } from "./wifi-radio-binding";

/** A transient missing observation gets one retry from a future status frame. */
export async function withWifiEntryRetry<
	T extends { readonly error?: string; readonly reason?: string },
>(
	binding: WifiRadioBinding,
	invoke: (incarnation: string, unobserved?: () => void) => Promise<T>,
	owner: {
		readonly signal: AbortSignal;
		readonly current: () => boolean;
		/** False when the new token's operation is already pending elsewhere. */
		readonly rebind: (incarnation: string) => boolean;
	},
): Promise<T | undefined> {
	if (!binding.incarnation) return;
	let observation: ReturnType<typeof waitForWifiStatus> | undefined;
	const result = await invoke(binding.incarnation, () => {
		observation ??= waitForWifiStatus(binding.device, owner.signal);
	});
	if (
		result.error !== "radio-changed" ||
		result.reason !== "current-unobserved"
	)
		return result;
	const row = await (observation ??
		waitForWifiStatus(binding.device, owner.signal));
	await tick();
	if (owner.signal.aborted || !owner.current() || !row?.incarnation) return;
	// The first refusal stands, so the caller's changed-radio handling applies.
	if (!owner.rebind(row.incarnation)) return result;
	return invoke(row.incarnation);
}
