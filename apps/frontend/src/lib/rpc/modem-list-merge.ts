import type { Modem, ModemList } from "@ceraui/rpc/schemas";

import { preserveWireIdentity } from "$lib/rpc/value-identity";

/**
 * Merge one authoritative modem roster without latching retracted fields.
 *
 * Every frame carries the complete key set, but each value has one of two
 * shapes. A full descriptor carries the required `ifname`, `name`, and
 * `network_type` fields; its field set is authoritative, so an omitted optional
 * field such as `sim_lock` is a retraction. A status-only entry carries none of
 * those descriptor fields and merges onto the previous value instead.
 */
export function mergeModemList(
	prev: ModemList | undefined,
	incoming: ModemList,
): ModemList {
	const next: ModemList = {};
	let changed = false;
	for (const [id, modem] of Object.entries(incoming)) {
		if (!modem) continue;
		const previous = prev?.[id];
		const isFullDescriptor =
			Object.hasOwn(modem, "ifname") &&
			Object.hasOwn(modem, "name") &&
			Object.hasOwn(modem, "network_type");
		let candidate: Modem = isFullDescriptor ? modem : { ...previous, ...modem };

		if (
			previous?.network_scan !== undefined &&
			modem.network_scan !== undefined &&
			modem.network_scan.generation < previous.network_scan.generation
		) {
			candidate = {
				...candidate,
				network_scan: previous.network_scan,
			};
			if (previous.available_networks === undefined) {
				delete candidate.available_networks;
			} else {
				candidate.available_networks = previous.available_networks;
			}
		}

		const kept = preserveWireIdentity(previous, candidate);
		if (kept !== previous) changed = true;
		next[id] = kept;
	}

	if (
		!changed &&
		prev !== undefined &&
		Object.keys(next).length === Object.keys(prev).length
	) {
		return prev;
	}
	return next;
}
