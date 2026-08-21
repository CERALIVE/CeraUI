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
 * A 3GPP scan must not report success for a scan that did not happen.
 *
 * Board-measured on `ceralive2` (2026-08-18): the scan RAN and was killed by its
 * OWN caller at 30 s while it had been given `--timeout=240`, and the operator
 * was answered `{"success":true}` with an unchanged (empty) network list. Two
 * independent defects on one path — a contradictory timeout pair where the
 * shorter number silently wins, and an outcome nothing carried.
 */

import { describe, expect, test } from "bun:test";

import { modemScanOutputSchema } from "@ceraui/rpc/schemas";

import { DEFAULT_TIMEOUT_MS } from "../helpers/run.ts";
import { fromDbusView } from "../modules/modems/modem-wire-adapters.ts";

const SCAN_SOURCE = new TextDecoder().decode(
	await Bun.file(
		new URL("../modules/modems/mmcli.ts", import.meta.url),
	).arrayBuffer(),
);

const PRODUCER_SOURCE = new TextDecoder().decode(
	await Bun.file(
		new URL("../modules/modems/modem-wire-producer.ts", import.meta.url),
	).arrayBuffer(),
);

describe("the scan's outer budget outlives the one it hands mmcli", () => {
	test("Given the declared mmcli deadline, When the scan spawns, Then run() is given a LONGER budget than its 30 s default", () => {
		// The defect was structural: `run()` was called with NO timeout option, so
		// its 30 s default preempted the 240 s the command itself declared.
		expect(SCAN_SOURCE).toContain("SCAN_TIMEOUT_GRACE_S");
		expect(SCAN_SOURCE).toContain(
			"{ timeout: (timeout + SCAN_TIMEOUT_GRACE_S) * 1000 }",
		);
	});

	test("Given mmcli's own 240 s deadline, When compared to run()'s default, Then the default is provably the shorter of the two", () => {
		const MMCLI_SCAN_DEADLINE_MS = 240 * 1000;

		expect(DEFAULT_TIMEOUT_MS).toBeLessThan(MMCLI_SCAN_DEADLINE_MS);
	});
});

describe("a scan outcome is typed, and an empty result is not a failure", () => {
	test("Given the wire schema, When a killed scan is reported, Then it carries a machine-stable reason rather than a bare false", () => {
		const parsed = modemScanOutputSchema.parse({
			success: false,
			scanFailure: "timed_out",
		});

		expect(parsed.scanFailure).toBe("timed_out");
	});

	test.each(["timed_out", "already_scanning", "failed"] as const)(
		"Given the failure reason %s, When put on the wire, Then the schema accepts it",
		(reason) => {
			expect(
				modemScanOutputSchema.parse({ success: false, scanFailure: reason })
					.scanFailure,
			).toBe(reason);
		},
	);

	test("Given a made-up reason, When put on the wire, Then the schema REFUSES it", () => {
		expect(() =>
			modemScanOutputSchema.parse({ success: false, scanFailure: "oops" }),
		).toThrow();
	});

	test("Given a scan that completed and found nothing, When reported, Then it is a SUCCESS with an empty list — not an error", () => {
		const parsed = modemScanOutputSchema.parse({
			success: true,
			networks: {},
		});

		expect(parsed.success).toBe(true);
		expect(parsed.scanFailure).toBeUndefined();
	});
});

describe("scan results reach the wire under the DEFAULT (dbus) backend", () => {
	const view = {
		runtimeId: 41,
		ifname: "wwan2",
		mmState: "searching",
		registration: { status: "searching", activeRats: new Set<string>() },
		signal: 89,
		supportedNetworkTypes: ["4g"],
		activeNetworkType: "4g",
	} as const;

	test("Given a D-Bus row carrying scan results, When projected, Then the networks reach the row", () => {
		const source = fromDbusView({
			...view,
			availableNetworks: {
				"732101": { name: "Claro", availability: "available" },
				"732103": { name: "TIGO", availability: "available" },
			},
		});

		expect(Object.keys(source.availableNetworks ?? {})).toEqual([
			"732101",
			"732103",
		]);
	});

	test("Given a modem that was never scanned, When projected, Then NO network list is claimed", () => {
		const source = fromDbusView(view);

		expect(source.availableNetworks).toBeUndefined();
	});

	test("Given the composition root, When it maps D-Bus views, Then it joins the mmcli-side scan state — the adapter cannot reach it alone", () => {
		// A static wiring lock (the `check-exec-guard`/`udev-rules` precedent):
		// the join lives in a private function, and the defect it fixes is that
		// nothing called it at all, so the call site is what must be pinned.
		const producer = PRODUCER_SOURCE;

		// The scan join is now COMPOSED with the NM-profile one and the SIM-identity
		// one, so the pin is on the composition rather than an exact call string —
		// all THREE must wrap the view before `fromDbusView` sees it, and none may
		// be dropped. Each exists because the D-Bus fold structurally cannot reach
		// that fact; see each helper's own docstring.
		expect(producer).toMatch(
			/fromDbusView\(\s*withSimIdentity\(withConnectionConfig\(withScanResults\(view\)\)\)/,
		);
		expect(producer).toContain("getModem(view.runtimeId)?.available_networks");
		expect(producer).toContain("getModem(view.runtimeId)?.iccid");
	});
});
