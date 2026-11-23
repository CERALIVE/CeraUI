import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as exec from "../helpers/exec.ts";
import { logger } from "../helpers/logger.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as profileRead from "../modules/network/network-manager-profile-instance.ts";
import {
	getHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { runHotspotProfileOperation } from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { replaceNmcliField } from "./helpers/nmcli-field-output.ts";
import { firstAp, MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

const readProfile = profileRead.readNmProfileInstance;

for (const unavailable of ["", "<hidden>"]) {
	for (const unresolved of [false, true]) {
		for (const cold of [false, true]) {
			test(`rediscovery retains owned credential: hidden=${unavailable !== ""}, unresolved=${unresolved}, cold=${cold}`, async () => {
				const f = await firstAp();
				try {
					expect((await f.start()).success).toBe(true);
					await settlePending("wlan0", true);
					const uuid = f.created();
					if (!uuid) throw new Error("Missing owned profile");
					const bytes = await readFile(f.nm.files.filename(uuid));
					f.row.activeConn = uuid;
					f.row.activeMode = "ap";
					if (unresolved) f.row.degradedReason = "permanent-mac-unresolved";
					expect(wifiBuildMsg()[f.row.id]?.hotspot?.password).toBe(f.secret);
					if (cold) delete f.row.hotspot.password;
					const boundary = spyOn(exec, "execFileP").getMockImplementation();
					if (!boundary) throw new Error("Missing fake NM boundary");
					spyOn(exec, "execFileP").mockImplementation(
						async (binary, args, options) => {
							const output = await boundary(binary, args, options);
							const selector = Math.max(
								args?.indexOf("--get-values") ?? -1,
								args?.indexOf("--fields") ?? -1,
							);
							const fields = args?.[selector + 1]?.split(",") ?? [];
							const secret = fields.indexOf("802-11-wireless-security.psk");
							if (selector < 0 || secret < 0 || !args?.includes(uuid))
								return output;
							const observed = unavailable;
							return {
								...output,
								stdout: replaceNmcliField(
									args ?? [],
									output.stdout,
									"802-11-wireless-security.psk",
									observed,
								),
							};
						},
					);
					const warnings: unknown[][] = [];
					spyOn(logger, "warn").mockImplementation(
						(message: unknown, ...meta: unknown[]) => {
							warnings.push([message, ...meta]);
							return logger;
						},
					);
					await handleHotspotConn(MAC, uuid, { active: true });
					expect(wifiBuildMsg()[f.row.id]?.hotspot?.password).toBe(f.secret);
					expect(getHotspotCredentials(MAC)?.password).toBe(f.secret);
					expect(
						(await readFile(f.nm.files.filename(uuid))).equals(bytes),
					).toBe(true);
					expect(warnings).toHaveLength(1);
					expect(JSON.stringify(warnings)).not.toContain(f.secret);
					expect(JSON.stringify(warnings)).not.toContain(
						new Bun.CryptoHasher("sha256")
							.update(f.secret)
							.digest("hex")
							.slice(0, 12),
					);
					expect(warnings[0]?.[0]).toBe(
						"Hotspot credential readback preserved",
					);
					expect(warnings[0]?.[1]).toMatchObject({
						storedPresent: true,
						observedPresent: unavailable !== "",
						observedHidden: unavailable === "<hidden>",
					});
					const meta = warnings[0]?.[1];
					if (!meta || typeof meta !== "object")
						throw new Error("Missing credential diagnostic");
					expect(Object.keys(meta).sort()).toEqual(
						[
							"storedPresent",
							"cachedPresent",
							"observedPresent",
							"observedHidden",
							"verifiedRead",
							"ownWriteWon",
							"sameProfile",
							"source",
						].sort(),
					);
				} finally {
					await f.restore();
				}
			});
		}
	}
}

test("an owned write during credential verification wins over the older read", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const uuid = f.created();
		const fields = uuid && f.settings.get(uuid);
		if (!uuid || !fields) throw new Error("Missing owned profile");
		const candidate = `${f.secret}-observed`;
		const written = `${f.secret}-written`;
		fields["802-11-wireless-security.psk"] = candidate;
		f.nm.files.write(uuid);
		let once = true;
		spyOn(profileRead, "readNmProfileInstance").mockImplementation(
			async (id, submitted, trace) => {
				const snapshot = await readProfile(id, submitted, trace);
				if (
					once &&
					submitted?.["802-11-wireless.mode"] === "ap" &&
					submitted["802-11-wireless-security.psk-flags"] === "0"
				) {
					once = false;
					expect(
						(
							await runHotspotProfileOperation({
								uuid,
								kind: "modify",
								fields: { "802-11-wireless-security.psk": written },
								run: (delta) => nm.nmConnSetFields(uuid, delta),
							})
						).success,
					).toBe(true);
					const stored = getHotspotCredentials(MAC);
					if (!stored) throw new Error("Missing owned credential");
					f.row.hotspot.password = written;
					rememberHotspotCredentials(MAC, { ...stored, password: written });
				}
				return snapshot;
			},
		);
		const warnings: unknown[][] = [];
		spyOn(logger, "warn").mockImplementation(
			(message: unknown, ...meta: unknown[]) => {
				warnings.push([message, ...meta]);
				return logger;
			},
		);
		await handleHotspotConn(MAC, uuid, { active: true });
		expect(wifiBuildMsg()[f.row.id]?.hotspot?.password).toBe(written);
		expect(getHotspotCredentials(MAC)?.password).toBe(written);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.[1]).toMatchObject({ ownWriteWon: true });
		expect(JSON.stringify(warnings)).not.toContain(f.secret);
	} finally {
		await f.restore();
	}
});

test("an unavailable credential is never carried into a different UUID", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const original = f.created();
		const fields = original && f.settings.get(original);
		if (!original || !fields) throw new Error("Missing owned profile");
		f.settings.set(OTHER_UUID, {
			...fields,
			"connection.uuid": OTHER_UUID,
			"802-11-wireless.ssid": "Other profile",
			"802-11-wireless-security.psk": "other-profile-secret",
		});
		f.nm.add(OTHER_UUID);
		await f.deps.nmConnect(OTHER_UUID, 30);
		f.row.activeConn = OTHER_UUID;
		f.row.activeMode = "ap";
		delete f.row.hotspot.conn;
		const boundary = spyOn(exec, "execFileP").getMockImplementation();
		if (!boundary) throw new Error("Missing fake NM boundary");
		spyOn(exec, "execFileP").mockImplementation(
			async (binary, args, options) => {
				const output = await boundary(binary, args, options);
				const selector = Math.max(
					args?.indexOf("--get-values") ?? -1,
					args?.indexOf("--fields") ?? -1,
				);
				const names = args?.[selector + 1]?.split(",") ?? [];
				const index = names.indexOf("802-11-wireless-security.psk");
				if (selector < 0 || index < 0 || !args?.includes(OTHER_UUID))
					return output;
				const observed = "<hidden>";
				return {
					...output,
					stdout: replaceNmcliField(
						args ?? [],
						output.stdout,
						"802-11-wireless-security.psk",
						observed,
					),
				};
			},
		);
		await handleHotspotConn(MAC, OTHER_UUID, { active: true });
		expect(wifiBuildMsg()[f.row.id]?.hotspot?.password).toBeUndefined();
		expect(getHotspotCredentials(MAC)?.conn).toBe(original);
		expect(getHotspotCredentials(MAC)?.password).toBe(f.secret);
	} finally {
		await f.restore();
	}
});

test("a changed binding never inherits the known credential", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const uuid = f.created();
		const fields = uuid && f.settings.get(uuid);
		if (!uuid || !fields) throw new Error("Missing owned profile");
		const other = "24:c3:93:b6:9c:a8";
		rememberHotspotCredentials(other, {
			ssid: "Other",
			password: "other-radio-secret",
			conn: OTHER_UUID,
		});
		fields["802-11-wireless.mac-address"] = other;
		f.nm.files.write(uuid);
		await handleHotspotConn(MAC, uuid, { active: true });
		expect(wifiBuildMsg()[f.row.id]?.hotspot?.password).toBeUndefined();
		expect(getHotspotCredentials(MAC)?.password).toBe(f.secret);
	} finally {
		await f.restore();
	}
});

for (const read of [
	"persistent-change",
	"stale-first-read",
	"unpersisted-read",
	"unavailable-verification",
] as const) {
	for (const unresolved of [false, true]) {
		test(`only a verified changed secret reaches public status: ${read}, unresolved=${unresolved}`, async () => {
			const f = await firstAp();
			try {
				expect((await f.start()).success).toBe(true);
				await settlePending("wlan0", true);
				const uuid = f.created();
				const fields = uuid && f.settings.get(uuid);
				if (!uuid || !fields)
					throw new Error("Missing owned credential profile");
				f.row.activeConn = uuid;
				f.row.activeMode = "ap";
				if (unresolved) f.row.degradedReason = "permanent-mac-unresolved";
				const candidate = ` ${f.secret}\\changed`;
				if (read === "persistent-change") {
					fields["802-11-wireless-security.psk"] = candidate;
					f.nm.files.write(uuid);
				}
				const bytes = await readFile(f.nm.files.filename(uuid));
				const boundary = spyOn(exec, "execFileP").getMockImplementation();
				if (!boundary) throw new Error("Missing fake NM boundary");
				spyOn(exec, "execFileP").mockImplementation(
					async (binary, args, options) => {
						const output = await boundary(binary, args, options);
						const selector = Math.max(
							args?.indexOf("--get-values") ?? -1,
							args?.indexOf("--fields") ?? -1,
						);
						const names = args?.[selector + 1]?.split(",") ?? [];
						const secret = names.indexOf("802-11-wireless-security.psk");
						if (
							selector < 0 ||
							secret < 0 ||
							!args?.includes(uuid) ||
							read === "persistent-change"
						)
							return output;
						const checking = names.includes("match.path");
						if (read === "stale-first-read" && checking) return output;
						const observed =
							read === "unavailable-verification" && checking
								? "<hidden>"
								: candidate;
						return {
							...output,
							stdout: replaceNmcliField(
								args ?? [],
								output.stdout,
								"802-11-wireless-security.psk",
								observed,
							),
						};
					},
				);
				const warnings: unknown[][] = [];
				spyOn(logger, "warn").mockImplementation(
					(message: unknown, ...meta: unknown[]) => {
						warnings.push([message, ...meta]);
						return logger;
					},
				);
				await handleHotspotConn(MAC, uuid, { active: true });
				const verified = read === "persistent-change";
				const expected = verified ? candidate : f.secret;
				expect(wifiBuildMsg()[f.row.id]?.hotspot?.password).toBe(expected);
				expect(getHotspotCredentials(MAC)?.password).toBe(expected);
				expect((await readFile(f.nm.files.filename(uuid))).equals(bytes)).toBe(
					true,
				);
				expect(warnings).toHaveLength(1);
				expect(warnings[0]?.[1]).toMatchObject({ verifiedRead: verified });
				expect(JSON.stringify(warnings)).not.toContain(f.secret);
				expect(f.commands.flat()).not.toContain(candidate);
			} finally {
				await f.restore();
			}
		});
	}
}
