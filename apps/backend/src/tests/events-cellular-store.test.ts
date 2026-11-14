import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCellularEvents } from "../modules/events/cellular-events.ts";
import { resetEventEmitterForTest } from "../modules/events/emit.ts";
import { appendEvent, readEvents } from "../modules/events/store.ts";
import * as identity from "../modules/modems/modem-wire-producer.ts";
import type { Modem } from "../modules/modems/modems-state.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";

test("real emitter and store keep allowlisted cellular params without SIM or credentials", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "cellular-events-"));
	const modemKey = "platform-xhci-hcd.0.auto-usb-0:1.4";
	const idPath = spyOn(identity, "getModemIdPath").mockReturnValue(
		`${modemKey}:1.4`,
	);
	let now = 0;
	setModemsState({});
	resetEventEmitterForTest({
		now: () => now,
		bootId: () => "66d8d1808694489b8c3a3fb4795cab24",
		tailSeq: () => 0,
		appendEvent: (event, options) =>
			appendEvent(event, { ...options, baseDir }),
		log: () => {},
	});
	const stop = initCellularEvents();
	try {
		const modem: Modem = {
			ifname: "wwan0",
			name: "Test modem",
			sim_network: "Test network",
			network_type: { supported: {}, active: null },
			sim_presence: "present",
			iccid: "iccid-secret",
			own_numbers: ["phone-secret"],
			config: {
				autoconfig: false,
				apn: "apn-secret",
				username: "username-secret",
				password: "password-secret",
				roaming: false,
				network: "",
			},
		};
		for (const connection of ["registered", "connected", "registered"]) {
			now += 31_000;
			setModemsState({
				7: {
					...modem,
					status: {
						connection,
						signal: 50,
						network_type: "4G",
						roaming: false,
					},
				},
			});
		}
		now += 31_000;
		setModemsState({});
		const records = readEvents({ baseDir });
		expect(records.map(({ code, params }) => ({ code, params }))).toEqual([
			{ code: "modem_added", params: { modemKey, name: "Test modem" } },
			{
				code: "modem_connected",
				params: { modemKey, networkType: "4G", roaming: false },
			},
			{ code: "modem_disconnected", params: { modemKey } },
			{ code: "modem_removed", params: { modemKey, name: "Test modem" } },
		]);
		for (const event of records) {
			for (const key of ["iccid", "imei", "imsi", "number"]) {
				expect(event.params).not.toHaveProperty(key);
			}
		}
		expect(JSON.stringify(records)).not.toContain("-secret");
	} finally {
		stop();
		resetEventEmitterForTest();
		setModemsState({});
		idPath.mockRestore();
		rmSync(baseDir, { recursive: true, force: true });
	}
});
