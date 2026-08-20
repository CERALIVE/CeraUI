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
 * THE SIM'S ICCID REACHES THE WIRE, ON BOTH BACKENDS.
 *
 * The value was ALREADY parsed on the mmcli path (`sim.properties.iccid`) and
 * already used internally to resolve a modem's NM profile — it simply never
 * reached the wire object, so nothing could render it. These tests pin the
 * projection on both adapters, because `dbus` is the DEFAULT backend and an
 * mmcli-only fix ships to no device.
 *
 * THE D-BUS FOLD ALONE IS NOT ENOUGH ON REAL HARDWARE, and that is measured
 * rather than assumed. ModemManager's ObjectManager exports only `Modem`
 * objects, so the SIM object carrying `SimIdentifier` is absent from the
 * `GetManagedObjects` tree the fold is handed — board-measured on `ceralive2`:
 * object-dict length 4, `…ModemManager1.Sim` interface 0 occurrences,
 * `SimIdentifier` 0 occurrences, while `busctl` reads `/SIM/2` perfectly. So the
 * fold's `readIccid` is pinned here for the tree that DOES carry a SIM object
 * (an MM that exports one, and the mock roster), and the real board is served by
 * the composition root's `withSimIdentity` join — the third sibling of the scan
 * and NM-profile joins, whose call site is pinned in `modem-scan-honesty.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import { foldDbusModemViews } from "../modules/cellular/dbus-view-fold.ts";
import {
	buildModemsMessage,
	buildModemsWireMessage,
} from "../modules/modems/modem-status.ts";
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

/**
 * The bench Quectel RM530N-GL's REAL ICCID, read live off `ceralive2` on
 * 2026-08-18 by BOTH clients at the same instant:
 *
 *   mmcli -i /org/freedesktop/ModemManager1/SIM/2  ->  iccid: 8957123102400060892
 *   busctl … /SIM/2 org.freedesktop.ModemManager1.Sim SimIdentifier
 *                                                  ->  s "8957123102400060892"
 *
 * Unlike the SIM's own number it is NOT redacted anywhere, so the real value is
 * the right fixture: it is printed on the card and read aloud to carrier support.
 */
const BOARD_ICCID = "8957123102400060892";

function baseModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan3",
		name: "Quectel RM530N-GL",
		sim_network: "Movistar",
		network_type: { supported: {}, active: null },
		status: {
			connection: "connected",
			network: "Movistar",
			network_type: "5G",
			signal: 81,
			roaming: false,
		},
		...overrides,
	};
}

function cleanupModems(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
	setModemsState({});
}

function projectOne(modem: Modem) {
	return projectModemWire([fromMmcliModem(3, modem)], {
		hasGsmAutoconfig: false,
	}).message["3"];
}

describe("the mmcli backend projects the ICCID", () => {
	test("the board's own ICCID reaches the wire entry", () => {
		expect(projectOne(baseModem({ iccid: BOARD_ICCID }))?.iccid).toBe(
			BOARD_ICCID,
		);
	});

	test("a modem that reported none omits the key — never an empty string", () => {
		const entry = projectOne(baseModem());

		expect(entry?.iccid).toBeUndefined();
		expect(Object.hasOwn(entry ?? {}, "iccid")).toBe(false);
	});

	test("a locked SIM's withheld ICCID is absence, not a blank value", () => {
		// mmcli prints `--` for a SIM that has not been read; the parser already
		// reduces that to an empty string, which must not reach the wire.
		expect(projectOne(baseModem({ iccid: "" }))?.iccid).toBeUndefined();
	});

	test("it reaches the SHIPPED wire builder, not only the projector", () => {
		cleanupModems();
		try {
			setModem(3, baseModem({ iccid: BOARD_ICCID }));

			expect(buildModemsWireMessage()["3"]?.iccid).toBe(BOARD_ICCID);
		} finally {
			cleanupModems();
		}
	});
});

describe("the D-Bus backend projects the SAME ICCID", () => {
	test("`Sim.SimIdentifier` is folded onto the view and reaches the wire", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/3",
				ifname: "wwan3",
				simPath: "/org/freedesktop/ModemManager1/SIM/2",
				iccid: BOARD_ICCID,
			}),
		);
		if (view === undefined) throw new Error("fold produced no view");

		expect(view.iccid).toBe(BOARD_ICCID);
		expect(
			projectModemWire([fromDbusView(view)], { hasGsmAutoconfig: false })
				.message["3"]?.iccid,
		).toBe(BOARD_ICCID);
	});

	test("a tree with no SIM object folds no ICCID — the REAL board's shape", () => {
		// This is not a degenerate case: it is what every real ModemManager hands
		// the fold, because its ObjectManager exports only `Modem` objects. The
		// fold must answer absence rather than invent a value; the composition
		// root's mmcli join is what actually fills the field on hardware.
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/3",
				ifname: "wwan3",
			}),
		);

		expect(view?.iccid).toBeUndefined();
	});

	test("a card that withheld its identifier answers absence, not an empty string", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/3",
				ifname: "wwan3",
				simPath: "/org/freedesktop/ModemManager1/SIM/2",
				iccid: "",
			}),
		);

		expect(view?.iccid).toBeUndefined();
	});

	test("both backends agree, so one operator sees one value either way", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/3",
				ifname: "wwan3",
				simPath: "/org/freedesktop/ModemManager1/SIM/2",
				iccid: BOARD_ICCID,
			}),
		);
		if (view === undefined) throw new Error("fold produced no view");

		const viaDbus = projectModemWire([fromDbusView(view)], {
			hasGsmAutoconfig: false,
		}).message["3"]?.iccid;

		expect(viaDbus).toBe(projectOne(baseModem({ iccid: BOARD_ICCID }))?.iccid);
	});
});

describe("the addition is purely additive", () => {
	test("the legacy oracle deliberately does NOT carry it", () => {
		cleanupModems();
		try {
			setModem(3, baseModem({ iccid: BOARD_ICCID }));

			expect(buildModemsWireMessage()["3"]?.iccid).toBe(BOARD_ICCID);
			expect(Object.hasOwn(buildModemsMessage()["3"] ?? {}, "iccid")).toBe(
				false,
			);
		} finally {
			cleanupModems();
		}
	});

	test("the ICCID is the ONLY key an otherwise-identical modem gains", () => {
		const withIccid = projectOne(baseModem({ iccid: BOARD_ICCID })) ?? {};
		const without = projectOne(baseModem()) ?? {};

		expect(
			Object.keys(withIccid).filter((k) => !Object.hasOwn(without, k)),
		).toEqual(["iccid"]);
	});
});
