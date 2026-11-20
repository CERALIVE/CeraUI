import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	NmApConnAddError,
	nmApConnAdd,
} from "../modules/network/network-manager.ts";
import * as secrets from "../modules/network/network-manager-secret.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

type Permit = () => Promise<boolean>;

test("a credential write refuses at publish when the radio is replaced during serialization", async () => {
	const fixture = await firstAp();
	try {
		expect((await fixture.start()).success).toBeTrue();
		const uuid = fixture.created();
		if (!uuid) throw new Error("Missing temporary AP");
		const filename = fixture.nm.files.filename(uuid);
		const before = await readFile(filename);
		let current = true;
		const serialize = secrets.serializeNmProfileModify;
		spyOn(secrets, "serializeNmProfileModify").mockImplementation(
			async (...args) => {
				const output = await serialize(...args);
				current = false;
				return output;
			},
		);
		const write: (
			uuid: string,
			fields: Readonly<Record<string, string>>,
			permit: Permit,
		) => Promise<boolean> = secrets.writeNmWifiSecret;
		expect(
			await write(
				uuid,
				{
					"802-11-wireless-security.psk": "Replacement-password",
				},
				async () => current,
			),
		).toBeFalse();
		expect(await readFile(filename)).toEqual(before);
	} finally {
		await fixture.restore();
	}
});

test("radio replacement during inactive creation prevents the nested credential write", async () => {
	const fixture = await firstAp();
	let current = true;
	fixture.faults.afterAdd = async () => {
		current = false;
	};
	try {
		await expect(
			nmApConnAdd(
				"wlan0",
				{ name: "Test AP", password: fixture.secret },
				{ "connection.autoconnect": "no" },
				() => true,
				async () => current,
			),
		).rejects.toBeInstanceOf(NmApConnAddError);
		const uuid = fixture.created();
		if (!uuid) throw new Error("Inactive creation was not reached");
		expect(
			fixture.settings.get(uuid)?.["802-11-wireless-security.psk"],
		).toBeUndefined();
		expect(fixture.active()).toBeUndefined();
	} finally {
		await fixture.restore();
	}
});
