import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCellularEvents } from "../modules/events/cellular-events.ts";
import { resetEventEmitterForTest } from "../modules/events/emit.ts";
import { appendEvent, readEvents } from "../modules/events/store.ts";
import * as identity from "../modules/modems/modem-wire-producer.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import {
	KEY_A,
	observation,
	radioStatus,
} from "./helpers/cellular-observation-fixtures.ts";

test("real storage records only witnessed transitions across first readings, gaps and re-addition", () => {
	const baseDir = mkdtempSync(join(tmpdir(), "cellular-known-store-"));
	const ids = spyOn(identity, "getModemIdPath").mockReturnValue(`${KEY_A}:1.4`);
	const warnings: unknown[][] = [];
	let now = 0;
	setModemsState({});
	resetEventEmitterForTest({
		now: () => now,
		bootId: () => "66d8d1808694489b8c3a3fb4795cab24",
		tailSeq: () => 0,
		appendEvent: (event, options) =>
			appendEvent(event, { ...options, baseDir }),
		log: () => {},
		warn: (...args) => warnings.push(args),
	});
	const stop = initCellularEvents();
	const privateFields = {
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
	const unknown = observation({ ...privateFields, sim_presence: "unknown" });
	const connected = observation({
		...privateFields,
		status: radioStatus("connected", "denied"),
		sim_presence: "present",
	});
	const down = { ...connected, status: radioStatus("registered", "denied") };
	const emptySlot = { ...down, sim_presence: "absent" as const };
	const publish = (row: typeof unknown | undefined) => {
		now += 31_000;
		setModemsState(row === undefined ? {} : { 0: row });
	};
	try {
		publish(unknown);
		publish(connected);
		expect(readEvents({ baseDir }).map((event) => event.code)).toEqual([
			"modem_added",
		]);
		publish(unknown);
		publish(connected);
		publish(down);
		publish(unknown);
		publish(down);
		publish({ ...down, status: radioStatus() });
		publish(unknown);
		publish(down);
		publish({
			...down,
			status: { ...radioStatus("registered", "denied"), signal: 51 },
		});
		publish(emptySlot);
		publish(unknown);
		publish(emptySlot);
		publish({ ...emptySlot, status: radioStatus("connected", "denied") });
		publish(connected);
		publish(undefined);
		publish(connected);
		const records = readEvents({ baseDir });
		expect(records.map(({ code, params }) => ({ code, params }))).toEqual([
			{ code: "modem_added", params: { modemKey: KEY_A, name: "Radio A" } },
			{ code: "modem_disconnected", params: { modemKey: KEY_A } },
			{
				code: "modem_registration_rejected",
				params: { modemKey: KEY_A, rejection: "denied" },
			},
			{ code: "sim_removed", params: { modemKey: KEY_A } },
			{
				code: "modem_connected",
				params: { modemKey: KEY_A, networkType: "LTE", roaming: false },
			},
			{ code: "sim_inserted", params: { modemKey: KEY_A } },
			{ code: "modem_removed", params: { modemKey: KEY_A, name: "Radio A" } },
			{ code: "modem_added", params: { modemKey: KEY_A, name: "Radio A" } },
		]);
		expect(records.map((event) => event.family)).toEqual(
			Array(8).fill("cellular"),
		);
		expect(JSON.stringify(records)).not.toContain("-secret");
		expect(warnings).toEqual([]);
	} finally {
		stop();
		resetEventEmitterForTest();
		ids.mockRestore();
		setModemsState({});
		rmSync(baseDir, { recursive: true, force: true });
	}
});
