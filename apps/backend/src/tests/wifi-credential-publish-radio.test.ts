import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as profiles from "../modules/network/network-manager-profile-instance.ts";
import * as secrets from "../modules/network/network-manager-secret.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

const readProfile = profiles.readNmProfileInstance;
const serialize = secrets.serializeNmProfileModify;
const { readFile } = fs;
const loads = (commands: readonly string[][]) =>
	commands.filter(
		([object, action]) => object === "connection" && action === "load",
	);

async function savedHotspot() {
	const f = await firstAp();
	const started = await f.start();
	const uuid = f.created();
	if (!started.success || !uuid) throw new Error("Missing initial hotspot");
	const filename = f.nm.files.filename(uuid);
	return {
		f,
		uuid,
		filename,
		before: await readFile(filename),
		first: f.commands.length,
	};
}

test("a radio replaced during the final profile read leaves the keyfile unpublished and unloaded", async () => {
	const { f, uuid, filename, before, first } = await savedHotspot();
	try {
		let current = true;
		let staged = false;
		spyOn(secrets, "serializeNmProfileModify").mockImplementation(
			async (...args) => {
				const output = await serialize(...args);
				staged = true;
				return output;
			},
		);
		spyOn(profiles, "readNmProfileInstance").mockImplementation(
			async (...args) => {
				const instance = await readProfile(...args);
				if (staged) current = false;
				return instance;
			},
		);
		const result = await secrets.writeNmWifiSecret(
			uuid,
			{ "802-11-wireless-security.psk": "requested-test-password" },
			async () => current,
		);
		expect(await readFile(filename)).toEqual(before);
		expect(loads(f.commands.slice(first))).toEqual([]);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});

test("a radio replaced after the last pre-publication check rolls the keyfile back before load", async () => {
	const { f, uuid, filename, before, first } = await savedHotspot();
	try {
		const answers = [true, false];
		const result = await secrets.writeNmWifiSecret(
			uuid,
			{ "802-11-wireless-security.psk": "requested-test-password" },
			async () => answers.shift() ?? false,
		);
		expect(await readFile(filename)).toEqual(before);
		expect(loads(f.commands.slice(first))).toEqual([]);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});

test.each([true, false])(
	"a keyfile superseded during the final radio permit stays live with permit=%s",
	async (allowed) => {
		const { f, uuid, filename, first } = await savedHotspot();
		try {
			let permits = 0;
			let successor: Buffer | undefined;
			const result = await secrets.writeNmWifiSecret(
				uuid,
				{ "802-11-wireless-security.psk": "requested-test-password" },
				async () => {
					if (++permits === 1) return true;
					f.replace(uuid);
					successor = await readFile(filename);
					return allowed;
				},
			);
			if (!successor) throw new Error("No successor installed");
			expect((await readFile(filename)).equals(successor)).toBeTrue();
			expect(loads(f.commands.slice(first))).toEqual([]);
			expect(result).toBeFalse();
		} finally {
			await f.restore();
		}
	},
);

test("an error during post-publication inspection restores the original instead of leaving staged bytes live", async () => {
	const { f, uuid, filename, before, first } = await savedHotspot();
	try {
		let permits = 0;
		const result = await secrets.writeNmWifiSecret(
			uuid,
			{ "802-11-wireless-security.psk": "requested-test-password" },
			async () => {
				if (++permits === 1) return true;
				throw new Error("Radio inspection failed");
			},
		);
		expect(await readFile(filename)).toEqual(before);
		expect(loads(f.commands.slice(first))).toEqual([]);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});

test("a same-byte successor installed during load is not reported as our committed keyfile", async () => {
	const { f, uuid, filename, first } = await savedHotspot();
	try {
		let installed = false;
		f.faults.afterSecretWrite = async () => {
			const successor = `${filename}.successor`;
			await fs.copyFile(filename, successor);
			await fs.rename(successor, filename);
			installed = true;
		};
		const result = await secrets.writeNmWifiSecret(uuid, {
			"802-11-wireless-security.psk": "requested-test-password",
		});
		expect(installed).toBeTrue();
		expect(loads(f.commands.slice(first))).toHaveLength(1);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});
