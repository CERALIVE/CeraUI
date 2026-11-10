import { spyOn } from "bun:test";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../../modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../../modules/wifi/wifi-radio-observation.ts";
import type { RadioFixture } from "./wifi-radio-equivalence.ts";

export async function fakeShadowSysfs(radios: () => readonly RadioFixture[]) {
	const text = spyOn(radioIdentityReaders, "readText").mockImplementation(
		async (path) => {
			const radio = radios().find(
				(r) =>
					path.includes(`/net/${r.ifname}/`) ||
					path.startsWith(`/sys/devices/equivalence/phy${r.phy}/`),
			);
			if (path.endsWith("/ifindex")) return radio?.ifindex.toString();
			if (path.endsWith("/index")) return radio?.phy.toString();
			if (path.endsWith("/macaddress")) return radio?.permanent;
			return undefined;
		},
	);
	const realpath = spyOn(radioIdentityReaders, "realpath").mockImplementation(
		async (path) => {
			const radio = radios().find(
				(r) => path === `/sys/class/net/${r.ifname}/phy80211`,
			);
			return radio ? `/sys/devices/equivalence/phy${radio.phy}` : undefined;
		},
	);
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	await wifiRadioIdentity.discover([]);
	return async () => {
		wifiRadioObservation.stop();
		await wifiRadioObservation.settled;
		await wifiRadioIdentity.discover([]);
		realpath.mockRestore();
		text.mockRestore();
	};
}
