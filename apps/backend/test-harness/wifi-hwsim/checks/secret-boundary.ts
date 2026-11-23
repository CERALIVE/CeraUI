import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../../src/helpers/run.ts";
import { getConfig } from "../../../src/modules/config.ts";
import {
	nmConnect,
	nmConnGetFields,
	nmConnSetFields,
	nmDeviceProp,
	nmDisconnect,
} from "../../../src/modules/network/network-manager.ts";
import { readVerifiedNmWifiSecret } from "../../../src/modules/network/network-manager-secret.ts";
import {
	getHotspotCredentials,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../../../src/modules/wifi/hotspot-credentials.ts";
import { withWifiRequestBinding } from "../../../src/modules/wifi/wifi-binding.ts";
import { removeWifiInterface } from "../../../src/modules/wifi/wifi-connections.ts";
import {
	defaultHotspotDeps,
	wifiHotspotStart,
} from "../../../src/modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	wifiHotspotConfig,
} from "../../../src/modules/wifi/wifi-hotspot-config.ts";
import {
	handleWifiMonitorEvent,
	settlePending,
} from "../../../src/modules/wifi/wifi-hotspot-monitor.ts";
import {
	getWifiIdToMacAddress,
	terminateWifiDiscovery,
} from "../../../src/modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../../src/modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../../../src/modules/wifi/wifi-radio-observation.ts";
import { projectWifiRadioIncarnation } from "../../../src/modules/wifi/wifi-radio-publication.ts";
import { observeSavedProfileRadio, seedObservedRadioRow } from "./first-ap-radio.ts";

const variants = [
	{ kind: "stored", flags: "0", persistent: true },
	{ kind: "agent-owned", flags: "1", persistent: false },
	{ kind: "not-saved", flags: "2", persistent: false },
	{ kind: "missing", flags: "0", persistent: false },
] as const;

async function checkProfile(target: {
	readonly ifname: string;
	readonly owner: string;
	readonly store: string;
	readonly variant: (typeof variants)[number];
}) {
	const { ifname, owner, store, variant } = target;
	const { kind, flags, persistent } = variant;
	const uuid = crypto.randomUUID();
	const ssid = `Cera603-${kind}`;
	const original = crypto.randomUUID();
	const updated = crypto.randomUUID();
	const profile = `/etc/NetworkManager/system-connections/ceraui-603-${uuid}.nmconnection`;
	const passwordFile = `${store}.passwd`;
	let device: number | undefined;
	const record = (phase: string, result: string) =>
		process.stdout.write(`B8-603 ${kind} ${phase} ${result}\n`);
	const observe = async (phase: string, expected: string) => {
		const values = await nmConnGetFields(uuid, ["802-11-wireless-security.psk-flags"] as const);
		const actualFlags = values?.[0]?.split(" ")[0];
		assert(actualFlags !== undefined && /^[0-7]$/.test(actualFlags), "Cannot read PSK flags");
		const bytes = await readFile(profile, "utf8");
		const onDisk = /^psk=.+$/m.test(bytes);
		const usable = await readVerifiedNmWifiSecret(uuid, {
			"802-11-wireless.mac-address": owner,
		});
		record(
			phase,
			`flags=${actualFlags} persistent=${onDisk} verified=${usable !== undefined} matches=${usable === expected}`,
		);
		return { flags: actualFlags, onDisk, matches: usable === expected };
	};
	const active = async () => {
		const state = await nmDeviceProp(ifname, "GENERAL.STATE,GENERAL.CON-UUID");
		assert(state?.[0], "Cannot read native device state");
		return Number.parseInt(state[0], 10) === 100 && state[1] === uuid;
	};
	await initHotspotCredentials(store);
	const released = [
		`[connection]\nid=Hotspot\nuuid=${uuid}\ntype=wifi\nautoconnect=false`,
		`[wifi]\nmode=ap\nssid=${ssid}\nmac-address=${owner}\nband=bg\nchannel=6`,
		`[wifi-security]\nkey-mgmt=wpa-psk\nproto=rsn\npairwise=ccmp\ngroup=ccmp\npsk-flags=${flags}${persistent ? `\npsk=${original}` : ""}`,
		"[ipv4]\nmethod=shared",
		"[ipv6]\nmethod=ignore",
		"",
	].join("\n\n");
	await writeFile(profile, released, { flag: "wx", mode: 0o600 });
	try {
		await run("nmcli", ["connection", "load", profile]);
		const seeded = await observe("legacy-before", original);
		assert.deepEqual(seeded, { flags, onDisk: persistent, matches: persistent });
		const first = Boolean(await nmConnect(uuid, 12));
		if (first) assert(await nmDisconnect(uuid), "Cannot stop first legacy Up");
		let supplied = false;
		if (flags !== "0") {
			await writeFile(passwordFile, `802-11-wireless-security.psk:${original}\n`, {
				flag: "wx",
				mode: 0o600,
			});
			try {
				await run("nmcli", [
					"-w",
					"12",
					"connection",
					"up",
					"uuid",
					uuid,
					"passwd-file",
					passwordFile,
				]);
				supplied = await active();
			} catch {
				// The one-use credential may still be unavailable to the native AP.
				supplied = false;
			} finally {
				await rm(passwordFile);
			}
		}
		await observe("legacy-before-rewrite", original);
		assert(
			await nmConnSetFields(uuid, {
				"connection.interface-name": ifname,
				"802-11-wireless-security.key-mgmt": "wpa-psk",
				"802-11-wireless-security.pmf": "disable",
			}),
			"Legacy nonsecret rewrite failed",
		);
		await observe("legacy-after-rewrite", original);
		if (supplied) assert(await nmDisconnect(uuid), "Cannot stop the one-use activation");
		const second = Boolean(await nmConnect(uuid, 12));
		record("legacy-up", `first=${first} one_use=${supplied} after_rewrite=${second}`);
		if (second) assert(await nmDisconnect(uuid), "Cannot stop second legacy Up");
		if (persistent) assert(first, "Stored-secret positive control did not activate");

		await run("nmcli", ["connection", "delete", "uuid", uuid]);
		await rm(profile, { force: true });
		await writeFile(profile, released, { flag: "wx", mode: 0o600 });
		await run("nmcli", ["connection", "load", profile]);
		rememberHotspotCredentials(owner, { ssid, password: original, channel: "ch_6", conn: uuid });
		getConfig().wifi_modes = { ...getConfig().wifi_modes, [owner]: "hotspot" };
		const row = await seedObservedRadioRow({ ifname, owner, uuid, ssid, password: original });
		device = row.id;
		await observeSavedProfileRadio(ifname);
		await wifiRadioIdentity.discover([{ ifname, row }]);
		const token = projectWifiRadioIncarnation(row, wifiRadioIdentity.state.rows.get(ifname));
		assert(token, "Fixture has no current radio incarnation");
		const bound = <T>(op: () => Promise<T>) =>
			withWifiRequestBinding({ device: String(row.id), expected: token, kind: "config" }, op);
		let upCalls = 0;
		const { pollHotspotActive: _poll, ...startDeps } = defaultHotspotDeps;
		const start = (refuseRepair: boolean) =>
			bound(() =>
				wifiHotspotStart(
					{ device: row.id },
					{
						...startDeps,
						nmConnSetFields: (id, fields) =>
							refuseRepair && Object.hasOwn(fields, "802-11-wireless-security.psk")
								? Promise.resolve(false)
								: defaultHotspotDeps.nmConnSetFields(id, fields),
						nmConnect: (...args) => {
							upCalls++;
							return defaultHotspotDeps.nmConnect(...args);
						},
					},
				),
			);
		if (!persistent) {
			delete row.hotspot.password;
			const refused = await start(true);
			assert(
				!refused.success && upCalls === 0 && !(await active()),
				"Refused secret repair attempted activation",
			);
			record("repair-refused", "up_calls=0 active=false");
			delete row.hotspot.password;
		}
		const started = await start(false);
		const isActive = await active();
		const current = await observe("candidate-start", original);
		record(
			"candidate-start-result",
			`accepted=${started.success} active=${isActive} up_calls=${upCalls}`,
		);
		if (!started.success) {
			assert(
				!persistent && !isActive,
				"Start failed with a usable stored secret or left the profile active",
			);
			assert(
				await nmConnSetFields(uuid, {
					"802-11-wireless-security.psk-flags": "0",
					"802-11-wireless-security.psk": original,
				}),
				"Cannot install the stored control secret for the Save phases",
			);
			assert(
				(await observe("save-control", original)).matches,
				"Stored control secret is not usable",
			);
			row.hotspot.password = original;
			assert((await start(false)).success, "Cannot activate the stored control for Save");
		} else {
			assert(
				isActive && current.matches,
				"Start accepted an AP without a persistent usable secret",
			);
		}
		await handleWifiMonitorEvent({ type: "device-state", device: ifname, state: "connected" });
		assert(
			row.hotspot.transition === undefined && row.conn === uuid,
			"Native confirmation did not settle the selected profile",
		);

		for (const rollback of [true, false]) {
			const proposed = rollback ? "Rollback603" : "Updated603";
			const frames: string[] = [];
			let attempts = 0;
			const attemptsSeen: boolean[] = [];
			await bound(() =>
				wifiHotspotConfig(
					{
						send: (raw) => {
							frames.push(raw);
						},
					},
					{
						device: row.id,
						name: proposed,
						password: updated,
						channel: "ch_6",
					},
					{
						...defaultHotspotConfigDeps,
						nmConnect: async (id, timeout) => {
							attempts++;
							assert.equal(id, uuid);
							if (rollback && attempts === 1) {
								assert(
									(await observe("forward-before-fault", updated)).matches,
									"Forward settings did not commit before the failure",
								);
								assert(await nmDisconnect(id), "Could not stop the AP for the rollback control");
								attemptsSeen.push(false);
								return false;
							}
							const up = Boolean(await nmConnect(id, timeout));
							attemptsSeen.push(up);
							return up;
						},
					},
				),
			);
			assert.equal(frames.length, 1, "Expected one Configure terminal");
			const terminal: { wifi?: { hotspot?: { config?: { success?: boolean; error?: string } } } } =
				JSON.parse(frames[0] ?? "{}");
			const result = terminal.wifi?.hotspot?.config;
			const expected = rollback ? original : updated;
			assert(
				rollback ? result?.error === "activating" : result?.success === true,
				"Unexpected Configure terminal",
			);
			assert.deepEqual(attemptsSeen, rollback ? [false, true] : [true]);
			assert(
				(await observe(rollback ? "rollback" : "save", expected)).matches,
				"Configure did not retain the selected persistent secret",
			);
			assert(await active(), "Configure did not leave the selected profile active");
			assert(
				getHotspotCredentials(owner)?.password === expected,
				"Credential store diverged from native profile",
			);
			record(rollback ? "rollback-result" : "save-result", `up_calls=${attempts} active=true`);
		}
	} finally {
		settlePending(ifname, false);
		wifiRadioObservation.stop();
		removeWifiInterface(owner);
		if (device !== undefined && getWifiIdToMacAddress()[device] === owner)
			delete getWifiIdToMacAddress()[device];
		if (await active()) await nmDisconnect(uuid);
		await run("nmcli", ["connection", "delete", "uuid", uuid]);
		await rm(profile, { force: true });
	}
}

async function main() {
	assert.equal(process.env.HWSIM_REPO, "/repo", "Use the disposable native VM");
	assert.equal(process.getuid?.(), 0);
	const radios: string[] = [];
	for (const name of (await readdir("/sys/class/net")).sort()) {
		const phy = await realpath(`/sys/class/net/${name}/phy80211`).catch(() => "");
		if (phy.includes("/mac80211_hwsim/")) radios.push(name);
	}
	assert.equal(radios.length, 4);
	const [, ifname] = radios;
	assert(ifname);
	const owner = (await readFile(`/sys/class/net/${ifname}/phy80211/macaddress`, "utf8"))
		.trim()
		.toLowerCase();
	const scratch = await mkdtemp(join(tmpdir(), "ceraui-603-"));
	const previous = getConfig().wifi_modes;
	try {
		await run("nmcli", ["device", "set", ifname, "managed", "yes"]);
		await run("nmcli", ["device", "set", ifname, "autoconnect", "no"]);
		for (const variant of variants)
			await checkProfile({ ifname, owner, store: join(scratch, `${variant.kind}.json`), variant });
		process.stdout.write("B8-603 complete\n");
	} finally {
		if (previous === undefined) delete getConfig().wifi_modes;
		else getConfig().wifi_modes = previous;
		terminateWifiDiscovery();
		await rm(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch {
		// A native tool can include a keyfile in its error. Report the completed phase only.
		process.stderr.write("B8-603 failed; see last phase receipt\n");
		process.exitCode = 1;
	}
}
