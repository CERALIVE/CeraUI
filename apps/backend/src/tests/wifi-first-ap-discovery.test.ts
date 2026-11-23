import { expect, spyOn, test } from "bun:test";
import * as exec from "../helpers/exec.ts";
import {
	getHotspotCredentials,
	hotspotCredentialsStore,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiBuildMsg, wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	nmcliFieldNames,
	replaceNmcliField,
} from "./helpers/nmcli-field-output.ts";
import { firstAp, MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

test("first Start never publishes or persists an unverified discovery credential", async () => {
	const f = await firstAp();
	const unpersisted = "unpersisted-first-start-sentinel";
	let initialRead = 0;
	try {
		const boundary = spyOn(exec, "execFileP").getMockImplementation();
		if (!boundary) throw new Error("Missing first-Start NM boundary");
		spyOn(exec, "execFileP").mockImplementation(
			async (binary, args, options) => {
				const output = await boundary(binary, args, options);
				const fields = nmcliFieldNames(args ?? []);
				const secret = fields.indexOf("802-11-wireless-security.psk");
				const created = f.created();
				if (
					initialRead === 0 &&
					fields.length > 0 &&
					fields[0] === "connection.autoconnect-priority" &&
					secret >= 0 &&
					created !== undefined &&
					args?.includes(created)
				) {
					initialRead++;
					return {
						...output,
						stdout: replaceNmcliField(
							args ?? [],
							output.stdout,
							"802-11-wireless-security.psk",
							unpersisted,
						),
					};
				}
				return output;
			},
		);
		f.deps.wifiUpdateSavedConns = wifiUpdateSavedConns;
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing first-Start profile");
		expect(initialRead).toBe(1);
		expect({
			nmCredentialUnchanged:
				f.settings.get(uuid)?.["802-11-wireless-security.psk"] === f.secret,
			unverifiedReadPublished:
				wifiBuildMsg()[f.row.id]?.hotspot?.password === unpersisted,
			unverifiedReadPersisted:
				getHotspotCredentials(MAC)?.password === unpersisted,
			activeMatchesCreated: f.active() === uuid,
		}).toEqual({
			nmCredentialUnchanged: true,
			unverifiedReadPublished: false,
			unverifiedReadPersisted: false,
			activeMatchesCreated: true,
		});
	} finally {
		await f.restore();
	}
});

for (const replacement of [false, true]) {
	test(`unreadable add invalidates only its deleted discovery adoption, replacement=${replacement}`, async () => {
		const f = await firstAp();
		f.deps.credentials = hotspotCredentialsStore;
		f.faults.receiptUnreadable = true;
		let adopted: string | undefined;
		f.faults.afterSecretWrite = async () => {
			await wifiUpdateSavedConns();
			adopted = getHotspotCredentials(MAC)?.conn;
			if (replacement) {
				f.row.hotspot = { ...f.row.hotspot, conn: OTHER_UUID };
				rememberHotspotCredentials(MAC, {
					ssid: "Replacement",
					password: "replacement-secret",
					conn: OTHER_UUID,
				});
			}
		};
		try {
			expect((await f.start()).success).toBe(false);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing generated UUID");
			expect(adopted).toBe(uuid);
			expect(f.profiles.has(uuid)).toBe(false);
			expect(f.row.hotspot.conn).toBe(replacement ? OTHER_UUID : undefined);
			expect(getHotspotCredentials(MAC)?.conn).toBe(
				replacement ? OTHER_UUID : undefined,
			);
			expect(f.profiles.has(OTHER_UUID)).toBe(true);
			if (!replacement) {
				f.faults.receiptUnreadable = false;
				f.faults.afterSecretWrite = async () => undefined;
				expect(await f.start()).toEqual({ success: true });
				expect(f.commands.filter((args) => args[1] === "add")).toHaveLength(2);
				expect(f.row.hotspot.conn).not.toBe(uuid);
			}
		} finally {
			await f.restore();
		}
	});
}
