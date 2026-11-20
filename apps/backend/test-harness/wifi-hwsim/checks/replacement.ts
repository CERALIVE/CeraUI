import assert from "node:assert/strict";
import { readdir, readFile, realpath } from "node:fs/promises";
import { run } from "../../../src/helpers/run.ts";
import { getConfig } from "../../../src/modules/config.ts";
import {
	nmApConnAdd,
	nmConnDelete,
	nmDeviceProp,
	nmDisconnect,
} from "../../../src/modules/network/network-manager.ts";
import {
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../../../src/modules/wifi/hotspot-credentials.ts";
import { withWifiRequestBinding } from "../../../src/modules/wifi/wifi-binding.ts";
import {
	defaultHotspotDeps,
	wifiHotspotStart,
} from "../../../src/modules/wifi/wifi-hotspot-activation.ts";
import { hotspotBindingFields } from "../../../src/modules/wifi/wifi-hotspot-types.ts";
import { terminateWifiDiscovery } from "../../../src/modules/wifi/wifi-interfaces.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../../../src/modules/wifi/wifi-radio-identity.ts";
import { projectWifiRadioIncarnation } from "../../../src/modules/wifi/wifi-radio-publication.ts";
import { observeSavedProfileRadio, seedObservedRadioRow } from "./first-ap-radio.ts";

async function main() {
	assert.equal(process.env.HWSIM_REPO, "/repo", "Use the isolated native VM");
	assert.equal(process.getuid?.(), 0);
	const radios: string[] = [];
	for (const name of (await readdir("/sys/class/net")).sort()) {
		const phy = await realpath(`/sys/class/net/${name}/phy80211`).catch(() => "");
		if (phy.includes("/mac80211_hwsim/")) radios.push(name);
	}
	assert.equal(radios.length, 4);
	const [, a, b] = radios;
	assert(a && b);
	const address = async (name: string) =>
		(await readFile(`/sys/class/net/${name}/phy80211/macaddress`, "utf8")).trim();
	const owner = await address(a);
	const other = await address(b);
	assert.notEqual(owner, other);
	const identity = {
		name: "CeraUI replacement check",
		password: crypto.randomUUID(),
	};
	await initHotspotCredentials();
	for (const name of [a, b]) {
		await run("nmcli", ["device", "set", name, "managed", "yes"]);
		await run("nmcli", ["device", "set", name, "autoconnect", "no"]);
	}
	const uuid = await nmApConnAdd(a, identity, hotspotBindingFields(owner));
	assert(uuid, "Fixture profile was not created");
	try {
		rememberHotspotCredentials(owner, {
			ssid: identity.name,
			password: identity.password,
			conn: uuid,
		});
		getConfig().wifi_modes = { [owner]: "hotspot" };
		const row = await seedObservedRadioRow({
			ifname: a,
			owner,
			uuid,
			ssid: identity.name,
			password: identity.password,
		});
		await observeSavedProfileRadio(a);
		await wifiRadioIdentity.discover([{ ifname: a, row }]);
		const token = projectWifiRadioIncarnation(row, wifiRadioIdentity.state.rows.get(a));
		assert(token, "Fixture radio has no current incarnation");
		const originalRead = radioIdentityReaders.readText;
		let startedUp = false;
		let stoppedUp = false;
		try {
			const changedAfterUp = await withWifiRequestBinding(
				{ device: String(row.id), expected: token, kind: "config" },
				() =>
					wifiHotspotStart(
						{ device: row.id },
						{
							...defaultHotspotDeps,
							nmConnect: async (...args) => {
								const up = await defaultHotspotDeps.nmConnect(...args);
								assert(up, "Native post-Up fixture did not activate");
								startedUp = true;
								// Keep NM's real active instance observable while changing the
								// kernel lifetime witness seen by the pending operation.
								const changed: typeof originalRead = async (path) =>
									path === `/sys/class/net/${a}/ifindex` ? "1000000" : originalRead(path);
								Object.defineProperty(radioIdentityReaders, "readText", { value: changed });
								return up;
							},
							nmDisconnect: async (id, activePath) => {
								assert.equal(id, uuid);
								assert(activePath, "Native Up did not return an active path");
								stoppedUp = await defaultHotspotDeps.nmDisconnect(id, activePath);
								return stoppedUp;
							},
						},
					),
			);
			assert.deepEqual(changedAfterUp, { success: false, error: "radio-changed" });
			assert(startedUp && stoppedUp, "Start did not reconcile its native activation");
			assert.notEqual((await nmDeviceProp(a, "GENERAL.CON-UUID"))?.[0], uuid);
			process.stdout.write(
				"B8 replacement: native Up reconciled with exact Down after lifetime change\n",
			);
		} finally {
			Object.defineProperty(radioIdentityReaders, "readText", { value: originalRead });
		}
		let swapped = false;
		let upCalls = 0;
		const result = await withWifiRequestBinding(
			{ device: String(row.id), expected: token, kind: "config" },
			() =>
				wifiHotspotStart(
					{ device: row.id },
					{
						...defaultHotspotDeps,
						wifiUpdateSavedConns: async () => {
							await defaultHotspotDeps.wifiUpdateSavedConns();
							if (swapped) return;
							for (const name of [a, b]) await run("ip", ["link", "set", name, "down"]);
							await run("ip", ["link", "set", a, "name", "swap-temp"]);
							await run("ip", ["link", "set", b, "name", a]);
							await run("ip", ["link", "set", "swap-temp", "name", b]);
							assert.equal(await address(a), other);
							assert.equal(await address(b), owner);
							swapped = true;
						},
						nmConnect: (...args) => {
							upCalls++;
							return defaultHotspotDeps.nmConnect(...args);
						},
					},
				),
		);
		assert(
			swapped,
			`The profile refresh did not reach the swap fixture (Start: ${result.success ? "accepted" : result.error}, Up calls: ${upCalls})`,
		);
		assert.deepEqual(result, { success: false, error: "radio-changed" });
		assert.equal(upCalls, 0);
		for (const name of [a, b])
			assert.doesNotMatch(await run("iw", ["dev", name, "info"]), /\btype AP\b/);
		process.stdout.write(
			"B8 replacement: native swap refused, zero Up calls and neither radio hosts an AP\n",
		);
	} finally {
		terminateWifiDiscovery();
		await nmDisconnect(uuid);
		assert(await nmConnDelete(uuid), "Fixture profile cleanup failed");
	}
}

await main();
