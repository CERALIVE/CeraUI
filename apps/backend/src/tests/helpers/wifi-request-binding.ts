import {
	type BaseWifiInterface,
	getWifiIdToMacAddress,
} from "../../modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../modules/wifi/wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "../../modules/wifi/wifi-radio-publication.ts";
import { fakeShadowSysfs } from "./wifi-radio-equivalence-shadow.ts";

export async function wifiRequestBinding(mac: string, row: BaseWifiInterface) {
	const ids = getWifiIdToMacAddress();
	const previousIds = { ...ids };
	ids[row.id] = mac;
	const restoreShadow = await fakeShadowSysfs(() => [
		{
			ifname: row.ifname,
			operational: mac,
			permanent: mac,
			ifindex: 10,
			phy: 1,
			state: row.conn ? "connected" : "disconnected",
		},
	]);
	await wifiRadioIdentity.discover([{ ifname: row.ifname, row }]);
	const incarnation = projectWifiRadioIncarnation(
		row,
		wifiRadioIdentity.state.rows.get(row.ifname),
	);
	if (incarnation === undefined)
		throw new Error("missing request fixture binding");
	return {
		incarnation,
		restore: async () => {
			await restoreShadow();
			for (const key of Object.keys(ids)) delete ids[Number(key)];
			Object.assign(ids, previousIds);
		},
	};
}
