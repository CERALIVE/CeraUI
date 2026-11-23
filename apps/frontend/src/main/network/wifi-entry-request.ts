import { tick } from "svelte";
import { waitForWifiStatus } from "$lib/rpc/wifi-status-receipt";
import type { WifiRadioBinding } from "./wifi-radio-binding";

/** A transient missing observation gets one retry on the approved radio. */
export async function withWifiEntryRetry<
	T extends { readonly error?: string; readonly reason?: string },
>(
	binding: WifiRadioBinding,
	invoke: (incarnation: string, unobserved?: () => void) => Promise<T>,
	owner: {
		readonly signal: AbortSignal;
		readonly current: () => boolean;
		readonly currentToken: () => string | undefined;
		readonly canRetry: () => boolean;
		readonly onReplacement: () => void;
	},
): Promise<T | undefined> {
	const { incarnation } = binding;
	if (!incarnation) return;
	let observation: ReturnType<typeof waitForWifiStatus> | undefined;
	const result = await invoke(incarnation, () => {
		observation ??= waitForWifiStatus(binding.device, owner.signal);
	});
	if (
		result.error !== "radio-changed" ||
		result.reason !== "current-unobserved"
	)
		return result;
	const hasReplacement = () => {
		const token = owner.currentToken();
		return token !== undefined && token !== incarnation;
	};
	if (owner.signal.aborted || !owner.current()) return;
	if (hasReplacement()) {
		owner.onReplacement();
		return result;
	}
	const row = await (observation ??
		waitForWifiStatus(binding.device, owner.signal));
	await tick();
	if (owner.signal.aborted || !owner.current()) return;
	if (
		hasReplacement() ||
		(row?.incarnation && row.incarnation !== incarnation)
	) {
		owner.onReplacement();
		return result;
	}
	if (!row?.incarnation) return;
	if (!owner.canRetry()) return result;
	return invoke(incarnation);
}
