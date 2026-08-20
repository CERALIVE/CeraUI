/**
 * A modem-config save reconnects the bearer only when it must.
 *
 * Operator report: toggling the roaming permission or the automatic-APN switch
 * pushed the modem through a fresh search/reconnect cycle. Root cause, read off
 * a live Rock 5B+ (2026-08-17): `applyModemConfig` ran `nmcli conn down`
 * UNCONDITIONALLY at the end of every save. The board's own journal recorded it
 * firing against a modem that held no bearer at all —
 * `nmDisconnect err: … '091ca73b-…' is not an active connection` — so the tear-down
 * ran whether or not anything had changed and whether or not there was anything
 * to tear down.
 *
 * NetworkManager 1.42.4 on that board cannot absorb a gsm change into a live
 * bearer (`nmcli device reapply` refuses every property outside its allowlist,
 * and the modem device answers `Device is not activated`), so the reconnect
 * genuinely IS the only way to apply a real edit to a connected modem — which is
 * exactly why it must be spent on real edits and nothing else.
 *
 * The decision table itself lives in `@ceraui/rpc`
 * (`modem-apply-scope.test.ts`), shared with the dialog so the warning the
 * operator reads and the action the device takes cannot disagree. What is pinned
 * HERE is the wiring: that `applyModemConfig` asks the question at all, and that
 * its answer decides whether `nmcli conn down` is spawned.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { ModemConnectionHold } from "@ceraui/rpc/schemas";

import {
	applyModemConfig,
	type ModemApplyDeps,
} from "../modules/modems/modems.ts";
import {
	getModems,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";

const SAVED_CONFIG = {
	conn: "11ab26e2",
	autoconfig: false,
	apn: "internet",
	username: "",
	password: "",
	roaming: true,
	network: "",
};

const SAVED_MSG = {
	device: 2,
	network_type: "4g3g",
	roaming: true,
	network: "",
	autoconfig: false,
	apn: "internet",
	username: "",
	password: "",
};

function seedModem(): void {
	for (const id of Object.keys(getModems())) removeModem(Number(id));
	setModem(2, {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		sim_network: "Movistar",
		network_type: {
			supported: { "4g3g": { allowed: "3g|4g", preferred: "4g" } },
			active: "4g3g",
		},
		config: { ...SAVED_CONFIG },
	});
}

type Spy = {
	readonly deps: ModemApplyDeps;
	readonly disconnected: string[];
	readonly written: string[];
	readonly modes: string[];
};

function spyDeps(
	hold: ModemConnectionHold,
	overrides: Partial<ModemApplyDeps> = {},
): Spy {
	const disconnected: string[] = [];
	const written: string[] = [];
	const modes: string[] = [];
	return {
		disconnected,
		written,
		modes,
		deps: {
			writeConnection: async (uuid) => {
				written.push(uuid);
				return true;
			},
			readConnectionHold: async () => hold,
			enforceAcrossProfiles: async () => 0,
			disconnect: async (uuid) => {
				disconnected.push(uuid);
				return true;
			},
			setNetworkTypes: async (id, allowed, preferred) => {
				modes.push(`${id}:${allowed}:${preferred}`);
				return true;
			},
			autoconfigSupported: () => true,
			...overrides,
		},
	};
}

describe("the save spends a reconnect only on a real change", () => {
	beforeEach(seedModem);

	test("re-saving an untouched dialog never touches the bearer", async () => {
		const spy = spyDeps("held");

		expect(await applyModemConfig(SAVED_MSG, spy.deps)).toEqual({
			ok: true,
			reconnected: false,
		});
		expect(spy.disconnected).toEqual([]);
		// The profile write still happens: todo 50's ranking can re-point the save
		// at a different duplicate, so skipping it would leave the operator's
		// values on a profile NetworkManager is not using.
		expect(spy.written).toEqual(["11ab26e2"]);
	});

	test("roaming toggled off and back on is an untouched save", async () => {
		const spy = spyDeps("held");

		await applyModemConfig(
			{ ...SAVED_MSG, roaming: false },
			spyDeps("idle").deps,
		);
		seedModem();
		expect(
			await applyModemConfig({ ...SAVED_MSG, roaming: true }, spy.deps),
		).toEqual({ ok: true, reconnected: false });
		expect(spy.disconnected).toEqual([]);
	});

	test("toggling roaming on a CONNECTED modem does reconnect, and says so", async () => {
		const spy = spyDeps("held");

		expect(
			await applyModemConfig({ ...SAVED_MSG, roaming: false }, spy.deps),
		).toEqual({ ok: true, reconnected: true });
		expect(spy.disconnected).toEqual(["11ab26e2"]);
	});

	test("toggling automatic APN on an IDLE profile reconnects nothing", async () => {
		// The board's live state: the Quectel sits in `searching`, its profile
		// unattached, so the old unconditional `conn down` could only ever error.
		const spy = spyDeps("idle");

		expect(
			await applyModemConfig(
				{ ...SAVED_MSG, autoconfig: true, apn: "" },
				spy.deps,
			),
		).toEqual({ ok: true, reconnected: false });
		expect(spy.disconnected).toEqual([]);
	});

	test("an unreadable hold still reconnects, so the setting cannot be silently dropped", async () => {
		const spy = spyDeps("unknown");

		expect(
			await applyModemConfig({ ...SAVED_MSG, apn: "other.apn" }, spy.deps),
		).toEqual({ ok: true, reconnected: true });
		expect(spy.disconnected).toEqual(["11ab26e2"]);
	});

	test("a write that failed reconnects nothing and is still reported as failed", async () => {
		const spy = spyDeps("held", { writeConnection: async () => false });

		expect(
			await applyModemConfig({ ...SAVED_MSG, roaming: false }, spy.deps),
		).toEqual({ ok: false, reason: "write_failed" });
		expect(spy.disconnected).toEqual([]);
	});

	test("the hold is not even read when nothing changed", async () => {
		let asked = 0;
		const spy = spyDeps("held", {
			readConnectionHold: async () => {
				asked += 1;
				return "held";
			},
		});

		await applyModemConfig(SAVED_MSG, spy.deps);
		expect(asked).toBe(0);
	});
});

describe("the network-type half is unchanged by the reconnect gate", () => {
	beforeEach(seedModem);

	test("an unchanged network type is never re-applied", async () => {
		const spy = spyDeps("held");

		await applyModemConfig(SAVED_MSG, spy.deps);
		expect(spy.modes).toEqual([]);
	});

	test("a changed network type still applies, with no bearer teardown of its own", async () => {
		// `--set-allowed-modes` is mmcli's own path and has always been guarded
		// separately; it must not start depending on the connect-time diff.
		const spy = spyDeps("idle");
		const modem = getModems()[2];
		if (modem) modem.network_type.active = "3g";

		expect(await applyModemConfig(SAVED_MSG, spy.deps)).toEqual({
			ok: true,
			reconnected: false,
		});
		expect(spy.modes).toEqual(["2:3g|4g:4g"]);
		expect(spy.disconnected).toEqual([]);
		expect(getModems()[2]?.network_type.active).toBe("4g3g");
	});
});
