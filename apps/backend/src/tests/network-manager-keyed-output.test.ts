import { expect, spyOn, test } from "bun:test";
import * as exec from "../helpers/exec.ts";
import * as mockService from "../mocks/mock-service.ts";
import * as mockWifi from "../mocks/providers/wifi.ts";
import {
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
	nmDeviceProp,
	nmDevices,
	nmScanResults,
} from "../modules/network/network-manager.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

const UUID = "6f1ba4d4-a753-4782-a1ab-a09246a5ec46";
const escapeFieldValue = (value: string) =>
	value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");

function platform(rows: readonly Readonly<Record<string, string>>[]) {
	spyOn(exec, "execFileP").mockImplementation(async (_bin, args = []) => {
		const get = args.indexOf("--get-values");
		const selected = args[get >= 0 ? get + 1 : args.indexOf("--fields") + 1];
		const fields = selected?.split(",") ?? [];
		const named = args.includes("multiline") && get < 0;
		return {
			stdout: `${rows
				.map((row) =>
					named
						? Object.entries(row)
								.filter(([key]) => fields.includes(key))
								.map(([key, value]) => `${key}:${value}`)
								.join("\n")
						: get >= 0
							? fields
									.filter((key) => Object.hasOwn(row, key))
									.map((key) => row[key] ?? "")
									.join("\n")
							: fields.map((key) => escapeFieldValue(row[key] ?? "")).join(":"),
				)
				.join("\n")}\n`,
			stderr: "",
		};
	});
}

test("the mock NM boundary emits named profile and inventory fields", async () => {
	const f = await firstAp();
	try {
		spyOn(mockWifi, "shouldMockWifi").mockReturnValue(true);
		spyOn(mockService, "shouldUseMocks").mockReturnValue(true);
		const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		expect(
			await nmConnGetFields(uuid, [
				"GENERAL.STATE",
				"802-11-wireless.ssid",
				"802-11-wireless.mac-address",
			] as const),
		).toEqual(["activated", "HomeNetwork", "dc:a6:32:12:34:57"]);
		expect(
			(await nmConnsGet("uuid,type"))
				?.filter(Boolean)
				.map(nmcliParseSep)
				.some(([id, type]) => id === uuid && type === "802-11-wireless"),
		).toBe(true);
	} finally {
		await f.restore();
	}
});

test("an empty mixed-setting reply is unreadable rather than blank evidence", async () => {
	const f = await firstAp();
	try {
		platform([]);
		expect(
			await nmConnGetFields(UUID, ["connection.id", "match.path"] as const),
		).toBeUndefined();
		platform([{ "connection.id": "" }]);
		expect(
			await nmConnGetFields(UUID, ["connection.id", "match.path"] as const),
		).toEqual(["", ""]);
	} finally {
		await f.restore();
	}
});

for (const layout of ["single", "one-setting", "required-settings"] as const) {
	test(`non-shiftable ${layout} profile queries keep their original argv`, async () => {
		const f = await firstAp();
		try {
			const fields =
				layout === "single"
					? ["GENERAL.STATE"]
					: layout === "one-setting"
						? ["802-11-wireless.mode", "802-11-wireless.ssid"]
						: [
								"gsm.device-id",
								"gsm.sim-id",
								"connection.autoconnect",
								"connection.timestamp",
							];
			const observed: string[][] = [];
			spyOn(exec, "execFileP").mockImplementation(
				async (_binary, args = []) => {
					observed.push([...args]);
					return {
						stdout: fields.map(() => "fixture-value").join("\n"),
						stderr: "",
					};
				},
			);
			expect(
				await nmConnGetFields(
					UUID,
					fields,
					layout === "required-settings" ? "fixed" : undefined,
				),
			).toEqual(fields.map(() => "fixture-value"));
			expect(observed).toEqual([
				[
					"--terse",
					"--escape",
					"no",
					"--show-secrets",
					"--get-values",
					fields.join(","),
					"connection",
					"show",
					UUID,
				],
			]);
		} finally {
			await f.restore();
		}
	});
}

for (const missing of [
	"match.path",
	"ipv4.method",
	"ipv6.method",
	"802-1x.identity",
	"proxy.method",
	"802-11-wireless-security.psk-flags",
]) {
	test(`profile read keeps field identities when ${missing} is absent`, async () => {
		const f = await firstAp();
		try {
			const fields = [
				"connection.id",
				missing,
				"802-11-wireless.ssid",
			] as const;
			platform([
				{
					"802-11-wireless.ssid": "Actual network",
					"connection.id": "Saved client",
				},
			]);
			expect(await nmConnGetFields(UUID, fields)).toEqual([
				"Saved client",
				"",
				"Actual network",
			]);
		} finally {
			await f.restore();
		}
	});
}

test("profile read distinguishes a present zero secret flag from an absent setting", async () => {
	const f = await firstAp();
	try {
		platform([
			{
				"802-11-wireless-security.psk-flags": "0",
				"connection.id": "Saved client",
			},
		]);
		expect(
			await nmConnGetFields(UUID, [
				"connection.id",
				"802-11-wireless-security.psk-flags",
			] as const),
		).toEqual(["Saved client", "0"]);
	} finally {
		await f.restore();
	}
});

test("device read keeps the owner UUID after absent IPv4 and IPv6 sections", async () => {
	const f = await firstAp();
	try {
		platform([
			{ "GENERAL.CON-UUID": UUID, "GENERAL.STATE": "100 (connected)" },
		]);
		expect(
			await nmDeviceProp(
				"wlan3",
				"GENERAL.STATE,IP4.ADDRESS,IP6.ADDRESS,GENERAL.CON-UUID",
			),
		).toEqual(["100 (connected)", "", "", UUID]);
	} finally {
		await f.restore();
	}
});

for (const kind of ["connections", "devices", "scan"] as const) {
	test(`${kind} rows preserve escaped colons, terminal backslashes and empty values`, async () => {
		const f = await firstAp();
		try {
			const name = "Office:\\";
			const fields =
				kind === "connections"
					? "NAME,UUID,FILENAME"
					: kind === "devices"
						? "DEVICE,TYPE,CONNECTION"
						: "SSID,BSSID,SECURITY";
			const values =
				kind === "connections"
					? [name, UUID, ""]
					: kind === "devices"
						? [name, "wifi", ""]
						: [name, "02:00:00:00:00:01", ""];
			platform([
				Object.fromEntries(
					fields.split(",").map((key, index) => [key, values[index] ?? ""]),
				),
			]);
			const rows =
				kind === "connections"
					? await nmConnsGet(fields)
					: kind === "devices"
						? await nmDevices(fields)
						: await nmScanResults(fields);
			expect(rows?.filter(Boolean).map(nmcliParseSep)).toEqual([values]);
		} finally {
			await f.restore();
		}
	});
}
