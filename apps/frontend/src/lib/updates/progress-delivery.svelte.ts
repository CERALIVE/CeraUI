import { getLinkEpoch } from "$lib/rpc/session-epoch.svelte";

type ProgressField = "updating" | "update_state";

// Which link last delivered each progress field. A frame the device sends
// again on the link that is up now is current, even with an unchanged value
// (the store keeps the same object for it); one from a link that dropped is not.
const delivered = $state<Record<ProgressField, number | undefined>>({
	updating: undefined,
	update_state: undefined,
});

export function noteProgressDelivery(field: string, link: number): void {
	if (field === "updating" || field === "update_state") delivered[field] = link;
}

export function progressDeliveredOnLink(field: ProgressField): boolean {
	return delivered[field] === getLinkEpoch();
}
