import { createLinkNameProjection } from "$lib/helpers/link-names";
import { getModems, getWifi } from "$lib/rpc/subscriptions.svelte";

const project = createLinkNameProjection();
const names = $derived(project({ modems: getModems(), wifi: getWifi() }));

/** One translated projection of the same wire inventory for all surfaces. */
export function getLinkNames() {
	return names;
}
