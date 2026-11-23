import { expect, test } from "bun:test";
import {
	bindingForRow,
	ownsWifiOperation,
} from "../modules/wifi/wifi-operation-binding.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "../modules/wifi/wifi-radio-publication.ts";
import { wifiFrameFixture } from "./helpers/wifi-frame-fixture.ts";

/*
  A device refresh captures a new radio observation and queues a physical
  sample (ifname only) under that sequence. When a second refresh captures a
  newer observation before the first sample publishes, the sample still
  publishes for its own sequence. The radio did not change: an operation bound
  to it must still own it, and its published incarnation must not vanish.
*/
test("a superseded physical sample does not orphan a bound operation's radio", async () => {
	const f = await wifiFrameFixture();
	try {
		const key = "dc:a6:32:aa:bb:c0";
		const binding = bindingForRow(key, f.row);
		if (!binding) throw new Error("expected a bound radio");
		expect(ownsWifiOperation(binding)).toBe(true);
		const token = projectWifiRadioIncarnation(
			f.row,
			wifiRadioIdentity.state.rows.get(f.row.ifname),
		);
		expect(token).toBe(f.before);

		const older = wifiRadioIdentity.captureObservation();
		wifiRadioIdentity.captureObservation();
		await wifiRadioIdentity.discover([{ ifname: f.row.ifname }], older);

		expect(ownsWifiOperation(binding)).toBe(true);
		expect(
			projectWifiRadioIncarnation(
				f.row,
				wifiRadioIdentity.state.rows.get(f.row.ifname),
			),
		).toBe(token);
	} finally {
		await f.restore();
	}
});
