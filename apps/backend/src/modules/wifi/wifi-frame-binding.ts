import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	getWifiFrameIncarnation,
	type WifiFrameIncarnation,
} from "./wifi-frame-incarnation.ts";
import { getMacAddressForWifiInterface } from "./wifi-interfaces.ts";
import { wifiRadioIdentity } from "./wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "./wifi-radio-publication.ts";

/** An empty captured binding must never acquire a later row's token. */
export function captureWifiFrameIncarnation(
	device: number | string,
	kind: "config" | "mode",
): WifiFrameIncarnation {
	const captured = getWifiFrameIncarnation();
	if (captured !== undefined) return captured;

	const interfaces = getWifiInterfacesByMacAddress();
	// Preserve each operation's existing resolver; the id map and registry can differ.
	const mac =
		kind === "config"
			? getMacAddressForWifiInterface(Number(device))
			: Object.keys(interfaces).find(
					(key) => interfaces[key]?.id === Number.parseInt(String(device), 10),
				);
	const row = mac === undefined ? undefined : interfaces[mac];
	const incarnation =
		row === undefined
			? undefined
			: projectWifiRadioIncarnation(
					row,
					wifiRadioIdentity.state.rows.get(row.ifname),
				);
	return incarnation === undefined ? {} : { incarnation };
}
