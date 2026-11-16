import { expect, test } from "bun:test";
import { reconcileHybridStationChannel } from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { hybridFixture, MAC } from "./helpers/wifi-hybrid-start.ts";

for (const followsStation of [true, false]) {
	test(`legal station roam ${followsStation ? "keeps an AP that follows it" : "stops only the mismatched AP UUID"}`, async () => {
		const f = await hybridFixture();
		try {
			expect(await f.start()).toEqual({ success: true });
			settlePending("wlan0", true);
			f.effects.length = 0;
			f.target.frequency(2437, "", 6);
			if (!followsStation)
				f.target.reportTarget({ frequency: 2412, channel: 1 });
			await f.observeRoam(() => reconcileHybridStationChannel(MAC, f.row));
			expect(f.effects.filter((effect) => effect.startsWith("down:"))).toEqual(
				followsStation ? [] : ["down:test-ap"],
			);
			expect(f.row.conn).toBe("station-uuid");
			expect(f.saved().channel).toBe("ch_11");
			expect([...f.target.objects.keys()]).toEqual([
				"wlan0",
				"clap-wlan0",
				"clap-sentinel",
			]);
			expect(f.row.concurrentHotspot?.activeConn).toBe(
				followsStation ? "test-ap" : undefined,
			);
		} finally {
			await f.restore();
		}
	});
}

test("a station gap stops only the observed AP with the channel reason", async () => {
	const f = await hybridFixture();
	try {
		expect(await f.start()).toEqual({ success: true });
		settlePending("wlan0", true);
		f.effects.length = 0;
		f.target.station("--");
		await f.observeRoam(() => reconcileHybridStationChannel(MAC, f.row));
		expect(f.effects.filter((effect) => effect.startsWith("down:"))).toEqual([
			"down:test-ap",
		]);
		expect(
			f.frames.some((frame) =>
				frame.includes('"reason":"hybrid-channel-not-permitted"'),
			),
		).toBe(true);
		expect([...f.target.objects.keys()]).toEqual([
			"wlan0",
			"clap-wlan0",
			"clap-sentinel",
		]);
		expect(f.saved().channel).toBe("ch_11");
	} finally {
		await f.restore();
	}
});
