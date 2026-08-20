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
 * Two things the D-Bus row said wrongly, on the DEFAULT backend.
 *
 * Both defects share one shape: a fact the mmcli path already reported honestly
 * was re-derived independently on the D-Bus path and lost on the way. Since
 * `"dbus"` is what an unmodified production config selects, neither the
 * garbage-identity fallback nor the whole registration-rejection surface reached
 * a single shipped device.
 *
 * Every fixture value is verbatim from `ceralive2` (2026-08-18).
 */

import { describe, expect, test } from "bun:test";

import { foldDbusModemViews } from "../modules/cellular/dbus-view-fold.ts";
import { modemHardwareName } from "../modules/modems/modem-identity.ts";
import { fromDbusView } from "../modules/modems/modem-wire-adapters.ts";

import {
	MM_ACCESS_TECH_LTE,
	MM_STATE_SEARCHING,
	managedObjectsTree,
} from "./support/mm-tree-fixture.ts";

/** MMModem3gppRegistrationState: SEARCHING. */
const MM_REG_SEARCHING = 2;
/** MMModem3gppPacketServiceState: DETACHED / ATTACHED. */
const MM_PACKET_DETACHED = 1;
const MM_PACKET_ATTACHED = 2;
/** MMNetworkError values measured on the bench board. */
const MM_NETERR_IMSI_UNKNOWN_IN_HLR = 2;
const MM_NETERR_GPRS_AND_NON_GPRS_NOT_ALLOWED = 8;
const MM_NETERR_LOCATION_AREA_NOT_ALLOWED = 12;

/**
 * The Qualcomm reference-design stick whose firmware answers ModemManager's
 * identity query with a bare numeral. mmcli reports it verbatim as
 * `manufacturer: 1` / `model: 0` / IMEI `868837088254863`.
 */
const GARBAGE_IDENTITY_MODEM = {
	path: "/org/freedesktop/ModemManager1/Modem/0",
	ifname: "wwan1",
	model: "0",
	manufacturer: "1",
	equipmentId: "868837088254863",
	revision: "HIMI_U01_MODEM_V1.0  1  [Sep 09 2015 10:00:00]",
	physdev:
		"/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.4/1-1.4.3",
} as const;

/** The bench Quectel, rejected by its OWN home network (Claro, 732101). */
const REJECTED_QUECTEL = {
	path: "/org/freedesktop/ModemManager1/Modem/41",
	ifname: "wwan2",
	model: "RM530N-GL",
	manufacturer: "Quectel",
	equipmentId: "867978050016855",
	revision: "RM530NGLAAR05A01M4G",
	physdev:
		"/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4",
	state: MM_STATE_SEARCHING,
	registrationState: MM_REG_SEARCHING,
	packetServiceState: MM_PACKET_DETACHED,
	networkRejection: {
		error: MM_NETERR_IMSI_UNKNOWN_IN_HLR,
		operatorId: "732101",
		accessTechnology: MM_ACCESS_TECH_LTE,
	},
} as const;

function rowFor(fixture: Parameters<typeof managedObjectsTree>[0][number]) {
	const views = foldDbusModemViews(managedObjectsTree([fixture]));
	expect(views).toHaveLength(1);
	const view = views[0];
	if (view === undefined) throw new Error("fold produced no view");
	return { view, source: fromDbusView(view) };
}

describe("a D-Bus row is titled by the SAME rule as an mmcli row", () => {
	test("Given firmware answering `model: 0`, When the row is titled, Then it falls back to the firmware string instead of rendering '0 - 54863'", () => {
		const { source } = rowFor(GARBAGE_IDENTITY_MODEM);

		expect(source.name).toBe("HIMI_U01_MODEM_V1.0 - 54863");
		expect(source.name).not.toBe("0 - 54863");
	});

	test("Given the same identity fields, When titled by either backend, Then the two names match byte for byte", () => {
		const { source } = rowFor(GARBAGE_IDENTITY_MODEM);

		expect(source.name).toBe(
			modemHardwareName({
				model: GARBAGE_IDENTITY_MODEM.model,
				manufacturer: GARBAGE_IDENTITY_MODEM.manufacturer,
				firmwareRevision: GARBAGE_IDENTITY_MODEM.revision,
				equipmentId: GARBAGE_IDENTITY_MODEM.equipmentId,
			}),
		);
	});

	test("Given a modem whose model DOES name a product, When titled, Then the title is unchanged", () => {
		const { source } = rowFor(REJECTED_QUECTEL);

		expect(source.name).toBe("RM530N-GL - 16855");
	});

	test("Given a modem reporting no IMEI, When titled, Then no bare ' - ' suffix is appended", () => {
		const { source } = rowFor({
			...GARBAGE_IDENTITY_MODEM,
			equipmentId: undefined,
		});

		expect(source.name).toBe("HIMI_U01_MODEM_V1.0");
	});
});

describe("a D-Bus row carries the network's OWN refusal reason", () => {
	test("Given a home network answering imsi-unknown-in-hlr, When folded, Then the row names that cause and its operator", () => {
		const { view, source } = rowFor(REJECTED_QUECTEL);

		expect(view.registrationRejection).toEqual({
			error: "imsi-unknown-in-hlr",
			operator_id: "732101",
			access_technology: "lte",
		});
		expect(source.additive?.registration_rejection?.error).toBe(
			"imsi-unknown-in-hlr",
		);
	});

	test("Given a detached packet service, When folded, Then the row says so rather than staying silent", () => {
		const { source } = rowFor(REJECTED_QUECTEL);

		expect(source.additive?.packet_service_state).toBe("detached");
	});

	test.each([
		[MM_NETERR_GPRS_AND_NON_GPRS_NOT_ALLOWED, "gprs-and-non-gprs-not-allowed"],
		[MM_NETERR_LOCATION_AREA_NOT_ALLOWED, "location-area-not-allowed"],
		[MM_NETERR_IMSI_UNKNOWN_IN_HLR, "imsi-unknown-in-hlr"],
	])(
		"Given MMNetworkError %i, When folded, Then it decodes to the token the operator-copy table keys on",
		(code, token) => {
			const { view } = rowFor({
				...REJECTED_QUECTEL,
				networkRejection: { error: code },
			});

			expect(view.registrationRejection?.error).toBe(token);
		},
	);

	test("Given a modem reporting NO rejection, When folded, Then the row claims none — absence is not a fault", () => {
		const { view, source } = rowFor({
			...REJECTED_QUECTEL,
			networkRejection: undefined,
			packetServiceState: MM_PACKET_ATTACHED,
		});

		expect(view.registrationRejection).toBeUndefined();
		expect(source.additive?.registration_rejection).toBeUndefined();
		expect(source.additive?.packet_service_state).toBe("attached");
	});

	test("Given a rejection whose cause this build cannot name, When folded, Then NOTHING is published rather than a made-up token", () => {
		const { view } = rowFor({
			...REJECTED_QUECTEL,
			networkRejection: { error: 9999, operatorId: "732101" },
		});

		expect(view.registrationRejection).toBeUndefined();
	});

	test("Given an unobserved packet service, When folded, Then it is omitted rather than reported detached", () => {
		const { view } = rowFor({
			...REJECTED_QUECTEL,
			packetServiceState: 0,
		});

		expect(view.packetServiceState).toBeUndefined();
	});
});
