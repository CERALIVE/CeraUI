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
 * THE RADIO'S POWER STATE REACHES THE WIRE — FROM BOTH BACKENDS, AS A READING.
 *
 * `"dbus"` is the DEFAULT backend and mmcli is its rollback, so a fact taught to
 * one adapter and not the other ships and reaches no device. Both halves are
 * driven here through the REAL parser / fold and the REAL wire builder against
 * the bench board's own captures — a hand-built literal would sit downstream of
 * the derivation under test.
 *
 * The other half of the contract is a NEGATIVE: the package publishes `power` as
 * a read with no setter beside it, so nothing anywhere may accept a power value.
 * That is asserted structurally rather than promised.
 */

import { describe, expect, test } from "bun:test";

import { modemConfigInputSchema, modemSchema } from "@ceraui/rpc/schemas";

import { foldDbusModemViews } from "../modules/cellular/dbus-view-fold.ts";
import {
	type ModemInfo,
	mmcliParseSep,
	parseModemInfo,
} from "../modules/modems/mmcli.ts";
import { deriveRadioPower } from "../modules/modems/modem-registration.ts";
import { buildModemsWireMessage } from "../modules/modems/modem-status.ts";
import {
	fromDbusView,
	fromMmcliModem,
} from "../modules/modems/modem-wire-adapters.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import { modemObjects } from "./support/mm-tree-fixture.ts";

/** Bench captures that reported a powered radio, verbatim from the board. */
const POWERED = [
	"mmcli-modem-real-quectel-rm530n-gl.txt",
	"mmcli-modem-real-simcom-sim7600g-h.txt",
	"mmcli-modem-real-fibocom-fm350-gl.txt",
] as const;

/**
 * The bench HiMi U01 printed `modem.generic.power-state : --`, which
 * `mmcliParseSep` drops. It is the board's own absence case, not a synthetic one.
 */
const UNREPORTED = "mmcli-modem-real-himi-u01.txt";

const MM_POWER_UNKNOWN = 0;
const MM_POWER_OFF = 1;
const MM_POWER_LOW = 2;
const MM_POWER_ON = 3;

async function loadModemInfo(fixture: string): Promise<ModemInfo> {
	const path = new URL(`./fixtures/network/${fixture}`, import.meta.url);
	const parsed = parseModemInfo(mmcliParseSep(await Bun.file(path).text()));
	if (!parsed.ok) {
		throw new Error(`fixture ${fixture} did not parse: ${parsed.reason}`);
	}
	return parsed.value;
}

function cleanupModems(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
	setModemsState({});
}

function mmcliModem(status: Partial<Modem["status"]> = {}): Modem {
	return {
		ifname: "wwan0",
		name: "Quectel RM530N-GL",
		network_type: { supported: {}, active: null },
		status: {
			connection: "connected",
			network_type: "5G",
			signal: 72,
			roaming: false,
			...status,
		},
	};
}

/** The one wire entry `buildModemsWireMessage` published for `id`. */
function wireEntry(id: number): Record<string, unknown> {
	const entry = buildModemsWireMessage()[String(id)];
	if (entry === undefined) {
		throw new Error(`no wire entry for modem ${id}`);
	}
	return entry as unknown as Record<string, unknown>;
}

describe("the mmcli backend publishes the reading", () => {
	test.each(POWERED)("%s reports its radio powered on", async (fixture) => {
		const modemInfo = await loadModemInfo(fixture);

		expect(modemInfo["modem.generic.power-state"]).toBe("on");
		expect(deriveRadioPower(modemInfo)).toBe("on");
	});

	test("the board's `--` capture leaves the key absent, never defaulted", async () => {
		const modemInfo = await loadModemInfo(UNREPORTED);

		expect(Object.hasOwn(modemInfo, "modem.generic.power-state")).toBe(false);
		expect(deriveRadioPower(modemInfo)).toBeUndefined();
	});

	test("a token this build cannot place is OMITTED, not folded onto `unknown`", () => {
		const parsed = parseModemInfo(
			mmcliParseSep(
				[
					"modem.generic.model : RM530N-GL",
					"modem.generic.power-state : hibernating",
				].join("\n"),
			),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		// The parser keeps the raw token; the STATUS derivation is what refuses it,
		// so the refusal is proven where it lives rather than at the parse.
		expect(parsed.value["modem.generic.power-state"]).toBe("hibernating");
		expect(deriveRadioPower(parsed.value)).toBeUndefined();
	});

	test.each(["on", "off", "low", "unknown"] as const)(
		"`%s` reaches the wire through the real projection",
		(token) => {
			cleanupModems();
			setModem(0, mmcliModem({ radio_power: token }));

			expect(wireEntry(0).radio_power).toBe(token);
			cleanupModems();
		},
	);

	test("a modem that reported no power state publishes NO key at all", () => {
		cleanupModems();
		setModem(0, mmcliModem());

		const entry = wireEntry(0);
		expect(Object.hasOwn(entry, "radio_power")).toBe(false);
		cleanupModems();
	});

	test("the adapter carries it as an ADDITIVE field, never inside `status`", () => {
		const source = fromMmcliModem(0, mmcliModem({ radio_power: "low" }));

		expect(source.additive?.radio_power).toBe("low");
		expect(Object.hasOwn(source.status ?? {}, "radio_power")).toBe(false);
	});
});

describe("the D-Bus backend publishes the SAME reading", () => {
	test.each([
		[MM_POWER_UNKNOWN, "unknown"],
		[MM_POWER_OFF, "off"],
		[MM_POWER_LOW, "low"],
		[MM_POWER_ON, "on"],
	] as const)("MMModemPowerState %i folds to `%s`", (value, expected) => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/0",
				ifname: "wwan0",
				powerState: value,
			}),
		);

		expect(view?.radioPower).toBe(expected);
	});

	test("an out-of-range value is an unreadable property, so nothing is claimed", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/0",
				ifname: "wwan0",
				powerState: 99,
			}),
		);

		expect(view?.radioPower).toBeUndefined();
	});

	test("a tree with no `PowerState` property publishes no reading", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/0",
				ifname: "wwan0",
			}),
		);

		expect(view).toBeDefined();
		expect(view?.radioPower).toBeUndefined();
	});

	test("the folded view reaches the wire through the D-Bus adapter", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/0",
				ifname: "wwan0",
				powerState: MM_POWER_LOW,
			}),
		);
		if (view === undefined) throw new Error("fold produced no view");

		const projected = projectModemWire([fromDbusView(view)], {
			hasGsmAutoconfig: false,
		});

		expect(projected.message["0"]?.radio_power).toBe("low");
	});

	test("BOTH adapters answer the same vocabulary for the same radio", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/0",
				ifname: "wwan0",
				powerState: MM_POWER_ON,
			}),
		);
		if (view === undefined) throw new Error("fold produced no view");

		const dbus = fromDbusView(view).additive?.radio_power;
		const mmcli = fromMmcliModem(0, mmcliModem({ radio_power: "on" })).additive
			?.radio_power;

		expect(dbus).toBe("on");
		expect(mmcli).toBe(dbus);
	});
});

describe("the reading has no write behind it, and cannot grow one by accident", () => {
	test("`radio_power` is on the OUTPUT shape and on no modem INPUT shape", () => {
		expect(Object.hasOwn(modemSchema.shape, "radio_power")).toBe(true);
		expect(Object.hasOwn(modemConfigInputSchema.shape, "radio_power")).toBe(
			false,
		);
	});

	test("a request that carries a power value is STRIPPED, never applied", () => {
		const parsed = modemConfigInputSchema.parse({
			device: "0",
			network_type: "5g4g",
			roaming: false,
			network: "",
			autoconfig: true,
			apn: "",
			username: "",
			password: "",
			radio_power: "off",
		});

		expect(Object.hasOwn(parsed, "radio_power")).toBe(false);
	});
});
