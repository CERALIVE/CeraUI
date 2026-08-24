/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * `no_sim` REPORTS A SLOT, NOT A NETWORKMANAGER PROFILE.
 *
 * Every fixture below is a VERBATIM `mmcli -K -m <id>` capture from the bench
 * board, driven through the REAL parser, the REAL refresh merge and the REAL
 * wire builders — a hand-built `Modem` literal would sit downstream of the
 * derivation this pins and could not catch it.
 *
 * The defect: a Quectel RM530N-GL holding a working SIM (`modem.generic.sim`
 * naming a real MM object, an occupied slot, `lock: sim-pin2`, `state:
 * searching` under a `gprs-and-non-gprs-not-allowed` network rejection) was
 * reported `no_sim: true` because it had no NM GSM profile yet — while the same
 * payload's SIM lock and SMS inbox were correctly reported as available. Three
 * operator-visible surfaces, one of them contradicting the other two.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { isSimlessForBond } from "@ceraui/rpc";

import {
	type ModemInfo,
	mmcliParseSep,
	parseModemInfo,
} from "../modules/modems/mmcli.ts";
import { readSmsInbox } from "../modules/modems/mmcli-sms.ts";
import { mergeRefreshedModem } from "../modules/modems/modem-registration.ts";
import {
	buildModemsMessage,
	buildModemsWireMessage,
} from "../modules/modems/modem-status.ts";
import { fromMmcliModem } from "../modules/modems/modem-wire-adapters.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { deriveSimPresence } from "../modules/modems/sim-presence.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";

const QUECTEL = "mmcli-modem-real-quectel-rm530n-gl.txt";

/** Every SIM-LESS device the bench board enumerated, by its own report. */
const SIM_LESS = [
	"mmcli-modem-real-simcom-sim7600g-h.txt",
	"mmcli-modem-real-himi-u01.txt",
	"mmcli-modem-real-fibocom-fm350-gl.txt",
] as const;

const QUECTEL_MODEM_PATH = "3";

async function loadModemInfo(fixture: string): Promise<ModemInfo> {
	const path = new URL(`./fixtures/network/${fixture}`, import.meta.url);
	const parsed = parseModemInfo(mmcliParseSep(await Bun.file(path).text()));
	if (!parsed.ok) {
		throw new Error(`fixture ${fixture} did not parse: ${parsed.reason}`);
	}
	return parsed.value;
}

/** A modem as it exists BEFORE a refresh: registered, never given a profile. */
function unconfiguredModem(ifname: string): Modem {
	return {
		ifname,
		name: "fixture",
		sim_network: "<NO SIM>",
		network_type: { supported: {}, active: null },
	};
}

async function refreshedFrom(fixture: string, ifname = "wwan3") {
	return mergeRefreshedModem(
		unconfiguredModem(ifname),
		await loadModemInfo(fixture),
	);
}

function cleanupModems(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
	setModemsState({});
}

describe("SIM presence is read from ModemManager", () => {
	afterEach(cleanupModems);

	test("the bench Quectel — SIM present, no NM profile — is NOT no_sim", async () => {
		const modemInfo = await loadModemInfo(QUECTEL);

		expect(modemInfo["modem.generic.sim"]).toBe(
			"/org/freedesktop/ModemManager1/SIM/0",
		);
		expect(modemInfo["modem.generic.state"]).toBe("searching");
		expect(deriveSimPresence(modemInfo)).toBe("present");

		const modem = await refreshedFrom(QUECTEL);
		expect(modem.config).toBeUndefined();
		expect(modem.sim_presence).toBe("present");

		setModem(3, modem);

		// Both builders: the legacy oracle and the projection that reaches the wire.
		expect(buildModemsMessage()["3"]).not.toHaveProperty("no_sim");
		expect(buildModemsWireMessage()["3"]).not.toHaveProperty("no_sim");
	});

	test.each(SIM_LESS)(
		"%s reports no_sim, as it always did",
		async (fixture) => {
			const modemInfo = await loadModemInfo(fixture);

			expect(modemInfo["modem.generic.state-failed-reason"]).toBe(
				"sim-missing",
			);
			expect(deriveSimPresence(modemInfo)).toBe("absent");

			const modem = await refreshedFrom(fixture, "wwan0");
			expect(modem.sim_presence).toBe("absent");

			setModem(4, modem);

			expect(buildModemsMessage()["4"]).toHaveProperty("no_sim", true);
			expect(buildModemsWireMessage()["4"]).toHaveProperty("no_sim", true);
		},
	);

	test("an occupied SLOT counts, even with no primary SIM path", () => {
		expect(
			deriveSimPresence({
				"modem.generic.sim": "",
				"modem.generic.sim-slots": [
					"/",
					"/org/freedesktop/ModemManager1/SIM/1",
				],
				"modem.generic.state": "searching",
			} as ModemInfo),
		).toBe("present");
	});

	test("the SIMCom's EMPTY `/` slots are not mistaken for a card", async () => {
		const modemInfo = await loadModemInfo(SIM_LESS[0]);

		expect(modemInfo["modem.generic.sim-slots"]).toEqual(["/", "/"]);
		expect(deriveSimPresence(modemInfo)).toBe("absent");
	});

	test("a payload that answers NEITHER withholds a verdict", async () => {
		const modemInfo = {
			"modem.generic.sim": "",
			"modem.generic.state": "enabled",
		} as ModemInfo;

		expect(deriveSimPresence(modemInfo)).toBe("unknown");

		// Withheld ⇒ the pre-existing profile-absence behaviour is unchanged, so
		// no modem class silently stops reporting a genuinely missing SIM.
		const modem = mergeRefreshedModem(unconfiguredModem("wwan0"), modemInfo);
		expect(modem.sim_presence).toBeUndefined();

		setModem(5, modem);
		expect(buildModemsWireMessage()["5"]).toHaveProperty("no_sim", true);
	});

	test("an unreadable poll never demotes a SIM that was already seen", async () => {
		const present = await refreshedFrom(QUECTEL);

		const afterBlindPoll = mergeRefreshedModem(present, {
			"modem.generic.sim": "",
			"modem.generic.state": "enabled",
		} as ModemInfo);

		expect(afterBlindPoll.sim_presence).toBe("present");
	});

	test("a fresh `unlock-required: none` clears the previous SIM lock", () => {
		const previouslyLocked: Modem = {
			...unconfiguredModem("wwan0"),
			sim_lock: { required: "sim-pin", remainingAttempts: 2 },
		};

		const unlocked = mergeRefreshedModem(previouslyLocked, {
			"modem.generic.state": "registered",
			"modem.generic.unlock-required": "none",
		} as unknown as ModemInfo);

		expect(unlocked.sim_lock).toBeUndefined();
		expect(unlocked).not.toHaveProperty("sim_lock");
	});

	test("an unreadable SIM-lock poll retains the previous lock", () => {
		const previouslyLocked: Modem = {
			...unconfiguredModem("wwan0"),
			sim_lock: { required: "sim-pin", remainingAttempts: 2 },
		};

		const afterBlindPoll = mergeRefreshedModem(previouslyLocked, {
			"modem.generic.state": "registered",
		} as unknown as ModemInfo);

		expect(afterBlindPoll.sim_lock).toEqual(previouslyLocked.sim_lock);
	});

	test("the projection agrees with the legacy builder about the Quectel", async () => {
		const modem = await refreshedFrom(QUECTEL);
		const { message } = projectModemWire([fromMmcliModem(3, modem)], {
			hasGsmAutoconfig: false,
		});

		expect(message["3"]).not.toHaveProperty("no_sim");
		expect(message["3"]).not.toHaveProperty("config");
	});
});

/**
 * The fold above is what BONDING needs, and it is lossy on purpose: `claimsNoSim`
 * answers `presence !== "present"`, so `absent` and `unknown` leave the device as
 * one `no_sim: true`. That is right for a pool a link either joins or does not,
 * and wrong for reporting — "we know the slot is empty" and "the read could not
 * answer" send an operator to two different places.
 *
 * So the reading the fold consumes now rides the wire BESIDE it. These tests pin
 * both halves at once: the new field carries the distinction, and every existing
 * bond answer for the SAME fixture is byte-identical.
 */
describe("the pre-collapse reading rides the wire beside the fold", () => {
	afterEach(cleanupModems);

	const UNREADABLE_SLOT = {
		"modem.generic.sim": "",
		"modem.generic.state": "enabled",
	} as ModemInfo;

	test("an unreadable slot publishes `unknown` while still claiming no_sim", async () => {
		expect(deriveSimPresence(UNREADABLE_SLOT)).toBe("unknown");

		const modem = mergeRefreshedModem(
			unconfiguredModem("wwan0"),
			UNREADABLE_SLOT,
		);
		setModem(5, modem);

		for (const row of [
			buildModemsMessage()["5"],
			buildModemsWireMessage()["5"],
		]) {
			expect(row).toHaveProperty("sim_presence", "unknown");
			expect(row).toHaveProperty("no_sim", true);
		}
	});

	test("BOND MEMBERSHIP for that exact fixture is unchanged", async () => {
		const modem = mergeRefreshedModem(
			unconfiguredModem("wwan0"),
			UNREADABLE_SLOT,
		);
		setModem(5, modem);

		const row = buildModemsWireMessage()["5"];

		// The gate reads the binary claim and nothing else, so a device that now
		// reports `unknown` is still refused exactly as it was before the field
		// existed. Asserting the PREDICATE rather than the field is what makes
		// this fail if a later change routes the gate through `sim_presence`.
		expect(isSimlessForBond({ noSim: row?.no_sim })).toBe(true);
		expect(isSimlessForBond({ noSim: row?.no_sim, routerSim: undefined })).toBe(
			true,
		);
	});

	test("a positively-stated slot is `absent`, and a populated one `present`", async () => {
		setModem(3, await refreshedFrom(QUECTEL));
		setModem(4, await refreshedFrom(SIM_LESS[0], "wwan0"));

		const rows = buildModemsWireMessage();

		expect(rows["3"]).toHaveProperty("sim_presence", "present");
		expect(rows["3"]).not.toHaveProperty("no_sim");

		expect(rows["4"]).toHaveProperty("sim_presence", "absent");
		expect(rows["4"]).toHaveProperty("no_sim", true);
	});

	test("a device whose slot this host cannot see emits NEITHER key", () => {
		const { message } = projectModemWire(
			[
				{
					kind: "router-ethernet",
					runtimeId: null,
					allocationKey: "opaque-fixture",
					ifname: "enx0c5b8f279a64",
					name: "fixture dongle",
					networkType: { supported: [], active: null },
					simVisibility: "opaque",
				},
			],
			{ hasGsmAutoconfig: false },
		);

		const row = Object.values(message)[0];
		expect(row).not.toHaveProperty("sim_presence");
		expect(row).not.toHaveProperty("no_sim");
	});
});

describe("the SIM signals a Quectel row carries all agree", () => {
	afterEach(cleanupModems);

	test("no_sim absent, PIN2 lock reported, SMS inbox readable", async () => {
		const modem = await refreshedFrom(QUECTEL);
		setModem(3, modem);

		const row = buildModemsWireMessage()[QUECTEL_MODEM_PATH];

		// (1) The device is not claimed to be SIM-less.
		expect(row).not.toHaveProperty("no_sim");

		// (2) The card's own non-blocking lock is reported — a lock is a property
		//     of a card, so it can never coexist with a no_sim claim.
		expect(row?.sim_lock?.required).toBe("sim-pin2");

		// (3) The card's inbox is reachable.
		const inbox = await readSmsInbox(QUECTEL_MODEM_PATH, async (args) =>
			args.includes("--messaging-list-sms")
				? "modem.messaging.sms.length : 1\nmodem.messaging.sms.value[1] : /org/freedesktop/ModemManager1/SMS/0\n"
				: [
						"sms.dbus-path : /org/freedesktop/ModemManager1/SMS/0",
						"sms.content.number : +573115422359",
						"sms.content.text : hola",
						"sms.properties.state : received",
						"sms.properties.pdu-type : deliver",
						"sms.properties.timestamp : 2025-08-21T17:20:16-05",
					].join("\n"),
		);

		expect(inbox.ok).toBe(true);
	});

	test("no wire row ever claims no_sim while reporting an ACTIVE lock", async () => {
		for (const [index, fixture] of [QUECTEL, ...SIM_LESS].entries()) {
			setModem(index, await refreshedFrom(fixture));
		}

		// A PIN/PUK lock is a property of a CARD, so it cannot coexist with a claim
		// that no card is present. `unknown` is excluded: it is what a SIM-less
		// modem's absent `unlock-required` resolves to, and asserts nothing.
		const CARD_LOCKS = ["sim-pin", "sim-pin2", "sim-puk", "sim-puk2"];

		for (const row of Object.values(buildModemsWireMessage())) {
			if (row.no_sim === true) {
				expect(CARD_LOCKS).not.toContain(row.sim_lock?.required);
			}
		}
	});
});
