import { afterEach, expect, jest, test } from "bun:test";
import { getConfig } from "../modules/config.ts";
import { wifiHotspotStart } from "../modules/wifi/wifi-hotspot-activation.ts";
import { wifiHotspotStop } from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { MAC, PROFILE } from "./helpers/wifi-autoconnect-fixture.ts";
import { stopActivityFixture } from "./helpers/wifi-stop-activity-fixture.ts";

const setup = stopActivityFixture();
afterEach(() => jest.useRealTimers());
async function flush(): Promise<void> {
	for (let turn = 0; turn < 256; turn++) await Promise.resolve();
}

test.each(["hotspot", "hybrid"] as const)(
	"r10 %s confirmation expiry during disarm cannot skip down",
	async (mode) => {
		const s = await setup(mode);
		jest.useFakeTimers();
		let polls = 0;
		s.start.pollHotspotActive = async () => {
			polls++;
			return false;
		};
		expect(await wifiHotspotStart({ device: 0 }, s.start)).toEqual({
			success: true,
		});
		const gate = s.holdDisarm();
		const stopping = wifiHotspotStop({ device: 0 }, s.stop);
		try {
			await gate.entered;
			for (let tick = 0; tick < 16; tick++) {
				jest.advanceTimersByTime(1000);
				await flush();
			}
			expect(polls).toBe(8);
			expect(s.row.hotspot.transition).toBeUndefined();
		} finally {
			gate.release();
		}
		const result = await stopping;
		await s.lateConnected();
		expect({
			result,
			downs: s.downs,
			state: s.model.phase,
			intent: getConfig().wifi_modes?.[MAC],
		}).toEqual({
			result: { success: true },
			downs: [PROFILE],
			state: "inactive",
			intent: "station",
		});
	},
);

test.each([
	["hotspot", "refuse"],
	["hybrid", "refuse"],
	["hotspot", "lost"],
	["hybrid", "lost"],
] as const)(
	"r10 %s retry after a %s down reply requires fresh NM proof",
	async (mode, reply) => {
		const s = await setup(mode);
		expect(await wifiHotspotStart({ device: 0 }, s.start)).toEqual({
			success: true,
		});
		s.model.reply = reply;
		expect(await wifiHotspotStop({ device: 0 }, s.stop)).toEqual({
			success: false,
			error: "deactivation-failed",
		});
		expect(getConfig().wifi_modes?.[MAC]).toBe(mode);
		expect(s.row.hotspot.transition).toBeUndefined();
		s.model.reply = "ok";
		const result = await wifiHotspotStop({ device: 0 }, s.stop);
		await s.lateConnected();
		expect({
			result,
			downs: s.downs,
			proof: s.queries,
			state: s.model.phase,
			intent: getConfig().wifi_modes?.[MAC],
		}).toEqual({
			result: { success: true },
			downs: reply === "lost" ? [PROFILE] : [PROFILE, PROFILE],
			proof: ["uuid,active"],
			state: "inactive",
			intent: "station",
		});
	},
);

test.each(["hotspot", "hybrid"] as const)(
	"r10 %s Stop retains its selected target across disarm",
	async (mode) => {
		const s = await setup(mode);
		await wifiHotspotStart({ device: 0 }, s.start);
		const gate = s.holdDisarm();
		const stopping = wifiHotspotStop({ device: 0 }, s.stop);
		await gate.entered;
		s.row.hotspot.conn = "replacement-hint";
		settlePending("wlan0", false);
		gate.release();
		const result = await stopping;
		expect({ result, downs: s.downs, state: s.model.phase }).toEqual({
			result: { success: true },
			downs: [PROFILE],
			state: "inactive",
		});
	},
);

test.each(["unreadable", "malformed"] as const)(
	"r10 %s inventory cannot authorize inactive success",
	async (query) => {
		const s = await setup("hotspot");
		await wifiHotspotStart({ device: 0 }, s.start);
		settlePending("wlan0", false);
		s.model.query = query;
		s.model.reply = "refuse";
		expect(await wifiHotspotStop({ device: 0 }, s.stop)).toEqual({
			success: false,
			error: "deactivation-failed",
		});
		expect(s.downs).toEqual([PROFILE]);
		expect(getConfig().wifi_modes?.[MAC]).toBe("hotspot");
	},
);
