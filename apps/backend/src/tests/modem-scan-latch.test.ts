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
 * `is_scanning` must not outlive the scan that set it.
 *
 * The two halves of this defect are individually correct and wrong together: a
 * status refresh REPLACES the `Modem` object (`mergeRefreshedModem`, immutable
 * so the T11 diff can see a change by value) and carries `is_scanning` forward
 * — which is right, the replacement must know a scan is running — while the
 * scan's own cleanup deleted the flag from the reference it had captured, which
 * by then is an object nothing reads.
 *
 * Board-measured on `ceralive2` (2026-08-18): one scan latched the flag for the
 * process lifetime. Every later scan was refused `already_scanning`, and because
 * `buildModemStatus` derives the connection label from the same flag the row
 * reported `connection: "scanning"` indefinitely.
 */

import { describe, expect, test } from "bun:test";

import { mergeRefreshedModem } from "../modules/modems/modem-registration.ts";
import {
	getModem,
	type Modem,
	setModem,
} from "../modules/modems/modems-state.ts";

const MODEM_ID = 4141;

const SCAN_SOURCE = new TextDecoder().decode(
	await Bun.file(
		new URL("../modules/modems/modem-network-scan.ts", import.meta.url),
	).arrayBuffer(),
);

function seedScanningModem(): Modem {
	const modem: Modem = {
		ifname: "wwan2",
		name: "RM530N-GL - 16855",
		sim_network: "Claro",
		network_type: { supported: { "4g": "4g" }, active: "4g" },
		config: {
			conn: "091ca73b-9f75-42bd-a737-2c447ca44533",
			apn: "",
			username: "",
			password: "",
			roaming: false,
			network: "",
			autoconfig: true,
		},
		status: {
			connection: "searching",
			network_type: "",
			signal: 81,
			roaming: false,
		},
	};
	setModem(MODEM_ID, modem);
	return modem;
}

/** The verbatim `-K` shape a status poll feeds `mergeRefreshedModem`. */
const REFRESH_PAYLOAD = {
	"modem.generic.state": "searching",
	"modem.generic.signal-quality.value": "81",
	"modem.3gpp.registration-state": "searching",
	"modem.generic.access-technologies": ["lte"],
	"modem.generic.ports": ["wwan2 (net)"],
} as unknown as Parameters<typeof mergeRefreshedModem>[1];

describe("the in-flight scan marker survives exactly as long as the scan", () => {
	test("Given a scan in flight, When a status poll replaces the modem object, Then the replacement still knows a scan is running", () => {
		const captured = seedScanningModem();
		captured.is_scanning = true;

		const refreshed = mergeRefreshedModem(captured, REFRESH_PAYLOAD);
		setModem(MODEM_ID, refreshed);

		expect(refreshed).not.toBe(captured);
		expect(getModem(MODEM_ID)?.is_scanning).toBe(true);
	});

	test("Given the object was replaced mid-scan, When the scan clears the marker via the CAPTURED reference, Then the latch survives — the defect, reproduced", () => {
		const captured = seedScanningModem();
		captured.is_scanning = true;
		setModem(MODEM_ID, mergeRefreshedModem(captured, REFRESH_PAYLOAD));

		delete captured.is_scanning;

		expect(getModem(MODEM_ID)?.is_scanning).toBe(true);
	});

	test("Given the object was replaced mid-scan, When the marker is cleared through the STATE MAP, Then the next scan is admitted", () => {
		const captured = seedScanningModem();
		captured.is_scanning = true;
		setModem(MODEM_ID, mergeRefreshedModem(captured, REFRESH_PAYLOAD));

		const live = getModem(MODEM_ID);
		if (live !== undefined) delete live.is_scanning;

		expect(getModem(MODEM_ID)?.is_scanning).toBeUndefined();
	});

	test("Given no status poll intervened, When the marker is cleared through the state map, Then it still clears", () => {
		const modem = seedScanningModem();
		modem.is_scanning = true;

		const live = getModem(MODEM_ID);
		if (live !== undefined) delete live.is_scanning;

		expect(getModem(MODEM_ID)?.is_scanning).toBeUndefined();
	});

	test("Given the shipped cleanup, When it runs, Then it re-reads the state map rather than mutating a captured reference", () => {
		// A static wiring lock: `delete modem.is_scanning` on a captured reference
		// is indistinguishable from the correct code at the call site, so only the
		// helper's own map lookup proves the fix is in place.
		expect(SCAN_SOURCE).toContain("function clearScanningMarker(id: number)");
		expect(SCAN_SOURCE).toContain("const live = getModem(id);");
		expect(SCAN_SOURCE).toContain("clearScanningMarker(id);");
		expect(SCAN_SOURCE).not.toContain("delete modem.is_scanning");
	});
});
