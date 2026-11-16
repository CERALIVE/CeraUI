import { expect, test } from "bun:test";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
import { transitionVirtualBinding } from "../modules/wifi/wifi-virtual-binding.ts";
import { profileRefreshFixture } from "./helpers/wifi-profile-refresh-fixture.ts";

for (const ifname of ["clap-wlan0", "clap-a1b2c3d4"]) {
	test(`stopped owned hybrid ${ifname} refresh preserves the saved channel`, async () => {
		const f = await profileRefreshFixture();
		f.row.hotspot.conn = f.uuid;
		f.row.hotspot.channel = "ch_11";
		f.row.concurrentHotspot = { ifname, activeConn: f.uuid };
		f.fields["connection.interface-name"] = ifname;
		f.fields["802-11-wireless.mac-address"] = f.mac;
		f.fields["802-11-wireless.band"] = "bg";
		f.fields["802-11-wireless.channel"] = "1";
		rememberHotspotCredentials(f.mac, {
			ssid: "Original AP",
			password: "original-password",
			conn: f.uuid,
			channel: "ch_11",
		});
		transitionVirtualBinding(f.row, { kind: "retire" });
		try {
			await wifiUpdateSavedConns();
			expect(f.row.concurrentHotspot).toBeUndefined();
			expect(f.row.hotspot.channel).toBe("ch_11");
			expect(getHotspotCredentials(f.mac)?.channel).toBe("ch_11");
			expect(f.fields["802-11-wireless.channel"]).toBe("1");
		} finally {
			await f.restore();
		}
	});
}
