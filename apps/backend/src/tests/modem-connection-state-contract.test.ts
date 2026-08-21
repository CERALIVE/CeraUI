/**
 * `status.connection` is mmcli's `modem.generic.state` VERBATIM, so the wire
 * schema has to accept ModemManager's whole `MMModemState` space — not the five
 * tokens a CONNECTING modem happens to pass through.
 *
 * Board-confirmed regression (2026-08-16, Rock 5B+): a Quectel RM530N-GL sitting
 * in the ordinary `enabled` state (SIM present, radio on, not yet registered)
 * failed OUTPUT validation. Output validation rejects the WHOLE payload, so both
 * modems disappeared from the operator's Cellular section — which then rendered
 * its "no modems" empty state beside a SIMCom the board had also enumerated.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { modemListSchema } from "@ceraui/rpc/schemas";

import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";

/** Every state ModemManager can report through `modem.generic.state`. */
const MM_STATES = [
	"failed",
	"unknown",
	"initializing",
	"locked",
	"disabled",
	"disabling",
	"enabling",
	"enabled",
	"searching",
	"registered",
	"disconnecting",
	"connecting",
	"connected",
] as const;

function cleanupModems(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
	setModemsState({});
}

function makeModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "RM530N-GL - 16855",
		network_type: {
			supported: { "5g": { allowed: "5g", preferred: "none" } },
			active: "5g",
		},
		status: {
			connection: "connected",
			network_type: "5G",
			signal: 0,
			roaming: false,
		},
		...overrides,
	};
}

describe("modem connection state reaches the wire", () => {
	afterEach(cleanupModems);

	test.each(MM_STATES)(
		"a modem in `%s` survives output validation",
		(state) => {
			setModem(
				0,
				makeModem({ status: { ...makeModem().status, connection: state } }),
			);

			const parsed = modemListSchema.safeParse(buildModemsWireMessage());

			expect(parsed.success).toBe(true);
			expect(parsed.success && parsed.data["0"]?.status?.connection).toBe(
				state,
			);
		},
	);

	test("the board roster that used to blank the whole list now reaches the wire", () => {
		setModem(
			2,
			makeModem({ status: { ...makeModem().status, connection: "enabled" } }),
		);
		setModem(
			4,
			makeModem({
				ifname: "wwan1",
				name: "SIMCOM_SIM7600G-H",
				no_sim: true,
				status: { ...makeModem().status, connection: "failed" },
			}),
		);

		const parsed = modemListSchema.safeParse(buildModemsWireMessage());

		expect(parsed.success).toBe(true);
		expect(parsed.success && Object.keys(parsed.data)).toEqual(["2", "4"]);
		expect(parsed.success && parsed.data["2"]?.status?.connection).toBe(
			"enabled",
		);
		// A SIM-less modem is a ROW on the wire, never an omission.
		expect(parsed.success && parsed.data["4"]?.no_sim).toBe(true);
	});
});
