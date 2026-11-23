import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as exec from "../helpers/exec.ts";
import { run } from "../helpers/run.ts";
import {
	nmConnDelete,
	nmConnect,
	nmConnSetFields,
} from "../modules/network/network-manager.ts";
import { getHotspotCredentialOwners } from "../modules/wifi/hotspot-credentials.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

async function addClient(): Promise<string> {
	const uuid = crypto.randomUUID();
	await run("nmcli", [
		"connection",
		"add",
		"type",
		"wifi",
		"ifname",
		"wlan3",
		"connection.id",
		"Saved client",
		"connection.uuid",
		uuid,
		"connection.autoconnect",
		"no",
		"802-11-wireless.mode",
		"infrastructure",
		"802-11-wireless.ssid",
		"Saved network",
		"802-11-wireless-security.key-mgmt",
		"wpa-psk",
		"ipv4.method",
		"auto",
		"ipv6.method",
		"ignore",
	]);
	return uuid;
}

test.each(["modify", "publish", "load"] as const)(
	"NetworkManager refuses an expired async permit at %s",
	async (boundary) => {
		const f = await firstAp();
		try {
			const uuid = await addClient();
			const settings = { ...f.settings.get(uuid) };
			const filename = f.nm.files.filename(uuid);
			const before = readFileSync(filename);
			let calls = 0;
			let current = true;
			const permit = Object.assign(
				async () => {
					if (++calls === (boundary === "load" ? 2 : 1))
						queueMicrotask(() => {
							current = false;
						});
					return true;
				},
				{ current: () => current },
			);

			const result = await nmConnSetFields(
				uuid,
				boundary === "modify"
					? { "connection.autoconnect": "yes" }
					: { "802-11-wireless-security.psk": "test-new-secret" },
				permit,
			);

			expect(result).toBe(false);
			expect(current).toBe(false);
			expect(f.settings.get(uuid)).toEqual(settings);
			expect(readFileSync(filename)).toEqual(before);
			expect(calls).toBe(boundary === "load" ? 2 : 1);
		} finally {
			await f.restore();
		}
	},
);

for (const missingMatch of [false, true]) {
	for (const existingSecret of [false, true]) {
		test(`unowned infrastructure profile confirms its protected password update, missingMatch=${missingMatch}, existing=${existingSecret}`, async () => {
			const f = await firstAp();
			try {
				const uuid = await addClient();
				const settings = f.settings.get(uuid);
				if (!settings) throw new Error("Missing ordinary client fixture");
				if (!missingMatch) settings["match.path"] = "";
				if (existingSecret) {
					settings["802-11-wireless-security.psk"] =
						"previous-client-credential";
				}
				f.nm.files.write(uuid);
				const platform = spyOn(exec, "execFileP").getMockImplementation();
				if (!platform) throw new Error("Missing fake platform");
				spyOn(exec, "execFileP").mockImplementation(
					async (binary, args, options) => {
						const output = await platform(binary, args, options);
						const at = args?.indexOf("--get-values") ?? -1;
						const requested = args?.[at + 1]?.split(",") ?? [];
						const match = requested.indexOf("match.path");
						if (
							binary !== "nmcli" ||
							!args?.includes(uuid) ||
							at < 0 ||
							match < 0 ||
							!missingMatch
						)
							return output;
						// NM omits an absent setting, not an empty positional value.
						const values = output.stdout.split("\n");
						values.splice(match, 1);
						return { ...output, stdout: `${values.join("\n")}\n` };
					},
				);
				expect(getHotspotCredentialOwners(uuid)).toEqual([]);
				expect(settings["802-11-wireless.mac-address"]).toBeUndefined();
				const updated = await nmConnSetFields(uuid, {
					"802-11-wireless-security.psk": f.secret,
				});
				expect({
					updated,
					mode: settings["802-11-wireless.mode"],
					credentialMatches:
						f.settings.get(uuid)?.["802-11-wireless-security.psk"] === f.secret,
					noHotspotAuthority: getHotspotCredentialOwners(uuid).length === 0,
					noMacBinding: settings["802-11-wireless.mac-address"] === undefined,
					noActivation: f.active() === undefined,
					argvClean: !f.commands.flat().some((arg) => arg.includes(f.secret)),
					diagnosticsClean: !f.logs.some((line) => line.includes(f.secret)),
				}).toEqual({
					updated: true,
					mode: "infrastructure",
					credentialMatches: true,
					noHotspotAuthority: true,
					noMacBinding: true,
					noActivation: true,
					argvClean: true,
					diagnosticsClean: true,
				});
			} finally {
				await f.restore();
			}
		});
	}
}

for (const operation of [
	"rename",
	"autoconnect",
	"activate",
	"delete",
] as const) {
	test(`ordinary client ${operation} needs no hotspot authority`, async () => {
		const f = await firstAp();
		try {
			const uuid = await addClient();
			expect(
				await nmConnSetFields(uuid, {
					"802-11-wireless-security.psk": f.secret,
				}),
			).toBe(true);
			f.faults.observedMode = "infrastructure";
			const success =
				operation === "rename"
					? await nmConnSetFields(uuid, { "connection.id": "Renamed client" })
					: operation === "autoconnect"
						? await nmConnSetFields(uuid, { "connection.autoconnect": "yes" })
						: operation === "activate"
							? await nmConnect(uuid, 30)
							: await nmConnDelete(uuid);
			expect({
				success,
				noOwner: getHotspotCredentialOwners(uuid).length === 0,
				observed:
					operation === "rename"
						? f.settings.get(uuid)?.["connection.id"] === "Renamed client"
						: operation === "autoconnect"
							? f.autoconnect.has(uuid)
							: operation === "activate"
								? f.active() === uuid
								: !f.profiles.has(uuid),
				noSecretInArgv: !f.commands
					.flat()
					.some((arg) => arg.includes(f.secret)),
			}).toEqual({
				success: true,
				noOwner: true,
				observed: true,
				noSecretInArgv: true,
			});
		} finally {
			await f.restore();
		}
	});
}

test("an explicit activation target reaches NetworkManager as an ifname selector", async () => {
	const f = await firstAp();
	try {
		const uuid = await addClient();
		expect(await nmConnect(uuid, 30, undefined, undefined, "wlan0")).toBe(true);
		expect(f.active()).toBe(uuid);
		expect(f.commands).toContainEqual([
			"-w",
			"30",
			"conn",
			"up",
			"uuid",
			uuid,
			"ifname",
			"wlan0",
		]);
	} finally {
		await f.restore();
	}
});

for (const failure of [
	"serialization",
	"load",
	"readback",
	"foreign-secret",
] as const) {
	test(`client ${failure} rejection logs only its whitelisted reason`, async () => {
		const f = await firstAp();
		try {
			const uuid = await addClient();
			let loaded = false;
			f.faults.afterSecretWrite = async () => {
				loaded = true;
				if (failure === "foreign-secret") {
					const fields = f.settings.get(uuid);
					if (!fields) throw new Error("Missing loaded client");
					fields["802-11-wireless-security.psk"] = "foreign-credential-value";
					f.nm.files.write(uuid);
				}
			};
			const original = spyOn(exec, "execFileP").getMockImplementation();
			if (!original) throw new Error("Missing fake platform");
			spyOn(exec, "execFileP").mockImplementation(
				async (binary, args = [], options) => {
					if (
						failure === "load" &&
						args[0] === "connection" &&
						args[1] === "load"
					)
						throw new Error(`Command failed with ${f.secret}`);
					if (
						failure === "readback" &&
						loaded &&
						args.includes("--fields") &&
						args.includes(uuid)
					)
						return { stdout: "unlabelled metadata\n", stderr: "" };
					return original(binary, args, options);
				},
			);
			if (failure === "serialization") {
				const runner = await import("../helpers/run.ts");
				spyOn(runner, "runWithStdin").mockRejectedValue(
					new Error(`Command failed with ${f.secret}`),
				);
			}
			expect(
				await nmConnSetFields(uuid, {
					"802-11-wireless-security.psk": f.secret,
				}),
			).toBe(false);
			const reason =
				failure === "serialization"
					? "serialization-failed"
					: failure === "load"
						? "load-failed"
						: failure === "readback"
							? "post-read-fields-unreadable"
							: "post-read-submitted-mismatch";
			expect(f.logs.filter((line) => line.startsWith('{"reason":'))).toEqual([
				JSON.stringify({ reason }),
			]);
			expect(
				f.logs.some(
					(line) =>
						line.includes(f.secret) ||
						line.includes("foreign-credential-value"),
				),
			).toBe(false);
			expect(getHotspotCredentialOwners(uuid)).toEqual([]);
			expect(
				f.commands.some(
					(args) =>
						args.includes("up") ||
						args.includes("down") ||
						args.includes("del"),
				),
			).toBe(false);
		} finally {
			await f.restore();
		}
	});
}
