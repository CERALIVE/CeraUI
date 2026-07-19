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
 * Phase B, T5.4 — additive-optional schema contract.
 *
 * The ten Phase-B modem detail fields (`device_class`, `availability_reason`,
 * `slot_label`, `recovery_state`, `usb_mode`, `recommended_usb_mode`,
 * `data_usage`, `firmware_revision`, `esim`, `cell_info`) are additive-only. This
 * suite is the acceptance gate for "old payloads still parse": a modem entry that
 * omits EVERY new field must parse, and a payload that carries them must round-trip
 * losslessly — proving an old backend/frontend pair never breaks on the new wire.
 */

import { describe, expect, test } from "bun:test";
import { modemListSchema, modemSchema } from "@ceraui/rpc/schemas";

const OLD_MODEM_ENTRY = {
	ifname: "wwan0",
	name: "Quectel EM120R-GL",
	model: "EM120R-GL",
	manufacturer: "Quectel",
	network_type: { supported: ["4g", "5g"], active: "5g" },
	config: {
		apn: "internet",
		username: "",
		password: "",
		roaming: false,
		network: "",
	},
	status: {
		connection: "connected" as const,
		network_type: "5G",
		signal: 72,
		roaming: false,
	},
} as const;

describe("modem additive-optional field contract (T5.4)", () => {
	test("an old modem entry (zero Phase-B fields) still parses", () => {
		const parsed = modemSchema.parse(OLD_MODEM_ENTRY);
		expect(parsed.device_class).toBeUndefined();
		expect(parsed.availability_reason).toBeUndefined();
		expect(parsed.slot_label).toBeUndefined();
		expect(parsed.recovery_state).toBeUndefined();
		expect(parsed.usb_mode).toBeUndefined();
		expect(parsed.recommended_usb_mode).toBeUndefined();
		expect(parsed.data_usage).toBeUndefined();
		expect(parsed.firmware_revision).toBeUndefined();
		expect(parsed.esim).toBeUndefined();
		expect(parsed.cell_info).toBeUndefined();
	});

	test("an old modem entry round-trips byte-identically through the schema", () => {
		const parsed = modemSchema.parse(OLD_MODEM_ENTRY);
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(OLD_MODEM_ENTRY));
	});

	test("an old modem LIST payload (record) still parses", () => {
		const list = {
			"0": OLD_MODEM_ENTRY,
			"1": { ...OLD_MODEM_ENTRY, ifname: "wwan1" },
		};
		const parsed = modemListSchema.parse(list);
		expect(Object.keys(parsed)).toEqual(["0", "1"]);
	});

	test("a new payload carrying every Phase-B field round-trips losslessly", () => {
		const enriched = {
			...OLD_MODEM_ENTRY,
			device_class: "usb" as const,
			availability_reason: "SIM slot empty",
			slot_label: "SIM 1",
			recovery_state: "online" as const,
			usb_mode: "mbim" as const,
			recommended_usb_mode: "qmi" as const,
			data_usage: {
				session_bytes: 1024,
				monthly_bytes: 4096,
				cycle_day: 1,
				threshold_bytes: 5_000_000,
			},
			firmware_revision: "EM120RGLAR03A03M4G",
			esim: {
				sim_type: "physical" as const,
				esim_status: "unknown" as const,
			},
			cell_info: {
				tech: "nr" as const,
				cell_id: "0x1A2B",
				band: "n78",
				rsrp: -85,
				rsrq: -11,
				sinr: 18,
				provenance: { source: "mmcli", observed_at: 1_700_000_000 },
			},
		};
		const parsed = modemSchema.parse(enriched);
		expect(JSON.stringify(parsed)).toBe(JSON.stringify(enriched));
	});

	test("every Phase-B field is INDEPENDENTLY optional (omit-one still parses)", () => {
		const keys = [
			"device_class",
			"availability_reason",
			"slot_label",
			"recovery_state",
			"usb_mode",
			"recommended_usb_mode",
			"data_usage",
			"firmware_revision",
			"esim",
			"cell_info",
		] as const;
		for (const omit of keys) {
			const full: Record<string, unknown> = {
				...OLD_MODEM_ENTRY,
				device_class: "pcie-mhi",
				availability_reason: "recovering",
				slot_label: "SIM 2",
				recovery_state: "recovering",
				usb_mode: "qmi",
				recommended_usb_mode: "mbim",
				data_usage: { session_bytes: 1 },
				firmware_revision: "rev",
				esim: { sim_type: "esim" },
				cell_info: { tech: "lte", rsrp: -90 },
			};
			delete full[omit];
			expect(() => modemSchema.parse(full)).not.toThrow();
		}
	});

	test("cell_info accepts LTE snr and NR sinr separately (ledger sinr-not-snr)", () => {
		const lte = modemSchema.parse({
			...OLD_MODEM_ENTRY,
			cell_info: { tech: "lte", snr: 12 },
		});
		expect(lte.cell_info?.snr).toBe(12);
		const nr = modemSchema.parse({
			...OLD_MODEM_ENTRY,
			cell_info: { tech: "nr", sinr: 20 },
		});
		expect(nr.cell_info?.sinr).toBe(20);
	});
});
