import { expect, spyOn, test } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import * as exec from "../helpers/exec.ts";
import * as runner from "../helpers/run.ts";
import { readNmProfileInstance } from "../modules/network/network-manager-profile-instance.ts";
import { readNmVersionId } from "../modules/network/network-manager-profile-write.ts";
import {
	getBootReadiness,
	resetBootReadiness,
} from "../modules/system/readiness.ts";
import {
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
} from "../modules/wifi/hotspot-credentials.ts";
import { cleanupCreatedHotspotProfile } from "../modules/wifi/wifi-hotspot-cleanup.ts";
import { runHotspotProfileOperation } from "../modules/wifi/wifi-hotspot-profile-operation.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import {
	decodeProfile,
	encodeProfile,
} from "./helpers/wifi-first-ap-keyfile-codec.ts";

test("failed Start retains an inactive replacement that reuses the UUID during the delete activity read", async () => {
	const f = await firstAp("up");
	const original = spyOn(exec, "execFileP").getMockImplementation();
	if (!original) throw new Error("Missing fake NM command boundary");
	let replaced = false;
	try {
		spyOn(exec, "execFileP").mockImplementation(async (bin, args, options) => {
			const reply = await original(bin, args, options);
			const uuid = f.created();
			if (
				!replaced &&
				uuid &&
				bin === "nmcli" &&
				args?.some(
					(arg) => arg === "uuid,active" || arg === "uuid,active,dbus-path",
				) &&
				f.commands.filter((cmd) =>
					cmd.some(
						(arg) => arg === "uuid,active" || arg === "uuid,active,dbus-path",
					),
				).length === 2
			) {
				f.nm.replace(uuid, "Inactive successor");
				replaced = true;
			}
			return reply;
		});
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing failed Start target");
		expect(replaced).toBe(true);
		expect(f.profiles.has(uuid)).toBe(true);
		expect(f.settings.get(uuid)?.["802-11-wireless.ssid"]).toBe(
			"Inactive successor",
		);
		expect(
			f.commands.some((args) => args[0] === "conn" && args[1] === "del"),
		).toBe(false);
	} finally {
		await f.restore();
	}
});

for (const window of [
	"restore",
	"restore-failed-reply",
	"edit",
	"atomic-restore",
	"pre-rename-in-place",
	"nm-byte-edit",
] as const) {
	test(`owned disarm rejects foreign ${window} and sends no later mutation`, async () => {
		const f = await firstAp();
		const write = f.deps.nmConnSetFields;
		let foreignAt = -1;
		let expected = Buffer.alloc(0);
		if (window === "nm-byte-edit") f.nm.version("1.52.1");
		const interfere: typeof write = async (uuid, fields) => {
			if (fields["connection.autoconnect"] !== "no") return write(uuid, fields);
			const filename = f.nm.files.filename(uuid);
			const before = readFileSync(filename);
			if (window === "pre-rename-in-place")
				writeFileSync(
					filename,
					Buffer.concat([before, Buffer.from("\n# operator edit\n")]),
				);
			const result = await write(uuid, fields);
			if (window === "nm-byte-edit") {
				const settings = f.settings.get(uuid);
				if (!settings) throw new Error("Missing NM-side edited profile");
				settings["802-11-wireless.ssid"] = "Operator NM-side edit";
				f.nm.files.write(uuid);
				f.nm.bumpVersion(uuid);
			}
			const after = readFileSync(filename);
			if (window === "restore" || window === "restore-failed-reply")
				writeFileSync(filename, before);
			if (window === "atomic-restore") {
				writeFileSync(`${filename}.operator`, before, { mode: 0o600 });
				renameSync(`${filename}.operator`, filename);
			}
			if (window === "edit") {
				const edited = decodeProfile(after.toString());
				edited["802-11-wireless.ssid"] = "Operator after NM";
				writeFileSync(filename, encodeProfile(edited));
			}
			expected = readFileSync(filename);
			foreignAt = f.commands.length;
			return window === "restore-failed-reply" ? false : result;
		};
		resetBootReadiness();
		try {
			expect((await f.start()).success).toBe(true);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing raced profile");
			expect(
				(
					await runHotspotProfileOperation({
						uuid,
						kind: "modify",
						fields: { "connection.autoconnect": "yes" },
						run: (fields) => write(uuid, fields),
					})
				).success,
			).toBe(true);
			f.deps.nmConnSetFields = interfere;
			await cleanupCreatedHotspotProfile(
				MAC,
				{
					uuid,
					registryKey: MAC,
					iface: f.row,
					hotspot: f.row.hotspot,
					activationAttempted: true,
					activation: undefined,
					instance: getPendingHotspotCreationInstance(MAC),
				},
				f.deps,
			);
			expect(f.profiles.has(uuid)).toBe(true);
			expect(f.active()).toBe(uuid);
			expect(readFileSync(f.nm.files.filename(uuid)).equals(expected)).toBe(
				true,
			);
			expect(
				f.commands
					.slice(foreignAt)
					.some(
						(args) =>
							args.includes(uuid) &&
							args.some((arg) => ["up", "down", "del", "modify"].includes(arg)),
					),
			).toBe(false);
			expect(getPendingHotspotCreation(MAC)).toBeUndefined();
			expect(getPendingHotspotCreationInstance(MAC)).toBeUndefined();
			expect(getBootReadiness().degraded).toBe(true);
		} finally {
			await f.restore();
			resetBootReadiness();
		}
	});
}

test.each(["1.42.4", "1.52.1"])(
	"uncontended back-to-back modifies retain exact authority on NM %s",
	async (version) => {
		const f = await firstAp();
		f.nm.version(version);
		try {
			expect((await f.start()).success).toBe(true);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing owned profile");
			const original = f.settings.get(uuid)?.["connection.autoconnect"];
			if (original !== "yes" && original !== "no")
				throw new Error("Missing policy");
			for (const value of [original === "yes" ? "no" : "yes", original]) {
				const fields = { "connection.autoconnect": value };
				expect(
					(
						await runHotspotProfileOperation({
							uuid,
							kind: "modify",
							fields,
							run: () => f.deps.nmConnSetFields(uuid, fields),
						})
					).success,
				).toBe(true);
			}
			expect(await readNmProfileInstance(uuid)).toEqual(
				getPendingHotspotCreationInstance(MAC),
			);
			expect(
				(
					await runHotspotProfileOperation({
						uuid,
						kind: "delete",
						run: () => f.deps.nmConnDelete(uuid),
					})
				).success,
			).toBe(true);
			expect(f.profiles.has(uuid)).toBe(false);
		} finally {
			await f.restore();
		}
	},
);

test("a no-op modify dispatches nothing and keeps the receipt", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing owned profile");
		const before = getPendingHotspotCreationInstance(MAC);
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		if (value !== "yes" && value !== "no") throw new Error("Missing policy");
		const fields = { "connection.autoconnect": value };
		let dispatched = false;
		expect(
			(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields,
					run: () => {
						dispatched = true;
						return f.deps.nmConnSetFields(uuid, fields);
					},
				})
			).success,
		).toBe(true);
		expect(dispatched).toBe(false);
		expect(getPendingHotspotCreationInstance(MAC)).toEqual(before);
	} finally {
		await f.restore();
	}
});

test("offline prediction failure preserves authority without a dispatch", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing owned profile");
		const before = getPendingHotspotCreationInstance(MAC);
		spyOn(runner, "runWithStdin").mockRejectedValue(
			new Error("Offline unavailable"),
		);
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		const fields = { "connection.autoconnect": value === "yes" ? "no" : "yes" };
		let dispatched = false;
		expect(
			(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields,
					run: () => {
						dispatched = true;
						return f.deps.nmConnSetFields(uuid, fields);
					},
				})
			).success,
		).toBe(false);
		expect(dispatched).toBe(false);
		expect(getPendingHotspotCreationInstance(MAC)).toEqual(before);
	} finally {
		await f.restore();
	}
});

test("a failed modify with unchanged inode metadata and bytes retains prior authority", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing unchanged-failure profile");
		const before = getPendingHotspotCreationInstance(MAC);
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		const result = await runHotspotProfileOperation({
			uuid,
			kind: "modify",
			fields: { "connection.autoconnect": value === "yes" ? "no" : "yes" },
			run: async () => false,
		});
		expect(result).toEqual({ success: false, checked: true, instance: before });
		expect(getPendingHotspotCreationInstance(MAC)).toEqual(before);
	} finally {
		await f.restore();
	}
});

test("a failure reply after a committed predicted write retires authority", async () => {
	const f = await firstAp();
	resetBootReadiness();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing changed-failure profile");
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		const fields = { "connection.autoconnect": value === "yes" ? "no" : "yes" };
		const result = await runHotspotProfileOperation({
			uuid,
			kind: "modify",
			fields,
			run: async (delta) => {
				await f.deps.nmConnSetFields(uuid, delta);
				return false;
			},
		});
		expect(result.checked).toBe(false);
		expect(result.success).toBe(false);
		expect(getPendingHotspotCreationInstance(MAC)).toBeUndefined();
		expect(getBootReadiness().degraded).toBe(true);
		expect(f.profiles.has(uuid)).toBe(true);
	} finally {
		await f.restore();
		resetBootReadiness();
	}
});

test("a failed unchanged modify across an NM restart retains prior authority", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing unchanged-restart profile");
		const before = getPendingHotspotCreationInstance(MAC);
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		const result = await runHotspotProfileOperation({
			uuid,
			kind: "modify",
			fields: { "connection.autoconnect": value === "yes" ? "no" : "yes" },
			run: async () => {
				f.nm.restart();
				return false;
			},
		});
		expect(result).toEqual({ success: false, checked: true, instance: before });
		expect(getPendingHotspotCreationInstance(MAC)).toEqual(before);
	} finally {
		await f.restore();
	}
});

test("NM 1.42 uses content validation without VersionId", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing legacy owned profile");
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		const fields = { "connection.autoconnect": value === "yes" ? "no" : "yes" };
		expect(
			(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields,
					run: () => f.deps.nmConnSetFields(uuid, fields),
				})
			).success,
		).toBe(true);
	} finally {
		await f.restore();
	}
});

test("activation during a modify may bump VersionId by two without retiring authority", async () => {
	const f = await firstAp();
	f.nm.version("1.52.1");
	resetBootReadiness();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		const instance = getPendingHotspotCreationInstance(MAC);
		if (!uuid || !instance) throw new Error("Missing activation-jump profile");
		const before = await readNmVersionId(instance.path);
		if (before === null || before === undefined)
			throw new Error("Missing modern revision");
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		const result = await runHotspotProfileOperation({
			uuid,
			kind: "modify",
			fields: { "connection.autoconnect": value === "yes" ? "no" : "yes" },
			run: async (fields) => {
				const written = await f.deps.nmConnSetFields(uuid, fields);
				await f.deps.nmConnect(uuid, 30);
				return written;
			},
		});
		expect(await readNmVersionId(instance.path)).toBe(before + 3n);
		expect(result.success).toBe(true);
		expect(result.checked).toBe(true);
		expect(getPendingHotspotCreationInstance(MAC)).toBeDefined();
		expect(getBootReadiness().degraded).toBe(false);
	} finally {
		await f.restore();
		resetBootReadiness();
	}
});

test("PSK prediction preserves leading space and backslash without argv exposure", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing owned profile");
		const secret = ` \\${f.secret}`;
		const fields = { "802-11-wireless-security.psk": secret };
		const result = await runHotspotProfileOperation({
			uuid,
			kind: "modify",
			fields,
			run: () => f.deps.nmConnSetFields(uuid, fields),
		});
		expect(result.success).toBe(true);
		expect(
			f.settings.get(uuid)?.["802-11-wireless-security.psk"] === secret,
		).toBe(true);
		expect(
			f.commands.some((args) => args.some((arg) => arg.includes(secret))),
		).toBe(false);
	} finally {
		await f.restore();
	}
});

test("the documented byte-identical post-rename rewrite is adopted", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing owned profile");
		const write = f.deps.nmConnSetFields;
		const value = f.settings.get(uuid)?.["connection.autoconnect"];
		const fields = { "connection.autoconnect": value === "yes" ? "no" : "yes" };
		let expected = Buffer.alloc(0);
		expect(
			(
				await runHotspotProfileOperation({
					uuid,
					kind: "modify",
					fields,
					run: async () => {
						const result = await write(uuid, fields);
						const filename = f.nm.files.filename(uuid);
						expected = readFileSync(filename);
						writeFileSync(filename, expected);
						return result;
					},
				})
			).success,
		).toBe(true);
		expect(readFileSync(f.nm.files.filename(uuid)).equals(expected)).toBe(true);
		expect(await readNmProfileInstance(uuid)).toEqual(
			getPendingHotspotCreationInstance(MAC),
		);
	} finally {
		await f.restore();
	}
});
