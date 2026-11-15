// allow: SIZE_OK - One native scenario keeps the frozen assertions beside their phase receipts.
import assert from "node:assert/strict";
import { savedProfileBackendCycle } from "./first-ap-saved-profile.ts";
import { installNativeNmcliShim } from "./first-ap-nmcli-shim.ts";
import { nativeEditRaceCases } from "./first-ap-edit-race.ts";
import { runFirstAp, type FirstApCheckpoint } from "./first-ap-diagnostics.ts";
import { readdir, readFile, realpath } from "node:fs/promises";
import { logRedact } from "../../../src/helpers/logger.ts";
import { run } from "../../../src/helpers/run.ts";
import {
	readNmProfileInstance,
	sameNmProfileInstance,
	sameNmProfileFile,
	sameNmProfileResource,
} from "../../../src/modules/network/network-manager-profile-instance.ts";
import {
	nmApConnAdd,
	nmConnDelete as rawNmConnDelete,
	nmConnect as rawNmConnect,
	nmConnGetFields,
	nmConnSetFields,
	nmDeviceProp,
	nmDisconnect as rawNmDisconnect,
	parseNmConnAddUuid,
} from "../../../src/modules/network/network-manager.ts";
import { hotspotBindingFields } from "../../../src/modules/wifi/wifi-hotspot-types.ts";
import { observeHotspotProfile } from "../../../src/modules/wifi/wifi-hotspot-profile-observation.ts";
import { runHotspotProfileOperation } from "../../../src/modules/wifi/wifi-hotspot-profile-operation.ts";
import {
	clearHotspotProfileCreation,
	getHotspotCredentialOwners,
	getPendingHotspotCreationInstance,
	initHotspotCredentials,
	recordHotspotProfileCreation,
	rememberHotspotCredentials,
} from "../../../src/modules/wifi/hotspot-credentials.ts";

const nmConnect = async (...args: Parameters<typeof rawNmConnect>) =>
	(await runHotspotProfileOperation({ uuid: args[0], kind: "up", run: () => rawNmConnect(...args) })).success;
const nmDisconnect = async (uuid: string) =>
	(await runHotspotProfileOperation({ uuid, kind: "down", run: () => rawNmDisconnect(uuid) })).success;
const nmConnDelete = async (uuid: string) =>
	(await runHotspotProfileOperation({ uuid, kind: "delete", selected: true, run: () => rawNmConnDelete(uuid) })).success;

async function refreshCreation(owner: string, uuid: string): Promise<void> {
	const previous = getPendingHotspotCreationInstance(owner);
	const current = await readNmProfileInstance(uuid);
	if (!sameNmProfileResource(previous, current))
		throw new Error("Runtime operation changed the keyfile receipt");
	assert(current && sameNmProfileInstance(previous, current), "Owned write lost same-run object continuity");
	assert(recordHotspotProfileCreation(owner, uuid, current), "Owned write receipt did not persist");
}

// Local-only: the VM runner exports the committed checkout and supplies /repo.
async function main(checkpoint: FirstApCheckpoint): Promise<void> {
	assert.equal(process.getuid?.(), 0, "Run as root in the hwsim VM");
	assert.equal(process.env.HWSIM_REPO, "/repo", "Use the isolated VM runner");
	assert(Bun.which("dnsmasq"), "Install dnsmasq-base in the guest for shared IPv4");
	const radios: string[] = [];
	for (const name of (await readdir("/sys/class/net")).sort()) {
		const phy = await realpath(`/sys/class/net/${name}/phy80211`).catch(() => "");
		if (phy.includes("/mac80211_hwsim/")) radios.push(name);
	}
	assert.equal(radios.length, 4, "The first-AP gate requires four hwsim radios");
	const [, a, b, c] = radios;
	assert(a && b && c, "Missing A, B or client radio");
	const address = async (device: string) =>
		(await readFile(`/sys/class/net/${device}/phy80211/macaddress`, "utf8"))
			.trim()
			.toLowerCase();
	const macA = await address(a);
	const macB = await address(b);
	assert.notEqual(macA, macB, "The wrong-radio control requires distinct MACs");
	const channel = "6";
	const identity = {
		name: `CeraB7-${crypto.randomUUID().slice(0, 8)}`,
		password: ` \\CeraB7-sentinel-${crypto.randomUUID()}`,
	};
	const created: string[] = [];
	const probe = await installNativeNmcliShim(identity.password);
	await initHotspotCredentials();
	rememberHotspotCredentials(macA, { ssid: identity.name, password: identity.password });
	rememberHotspotCredentials(macB, { ssid: `${identity.name}-control`, password: identity.password });
	try {
		for (const device of [a, b, c]) {
			await run("nmcli", ["device", "set", device, "managed", "yes"]);
			await run("nmcli", ["device", "set", device, "autoconnect", "no"]);
			const state = await nmDeviceProp(device, "GENERAL.STATE");
			assert(state?.[0], "Initial device state read failed");
			if (Number.parseInt(state[0], 10) === 100)
				await run("nmcli", ["device", "disconnect", device]);
		}
		// Prove B can host an AP before treating its refusal of A as evidence.
		checkpoint("b.control");
		const control = await nmApConnAdd(
			b,
			{ ...identity, name: `${identity.name}-control` },
			{
				...hotspotBindingFields(macB),
				"802-11-wireless.band": "bg",
				"802-11-wireless.channel": channel,
			},
			(uuid, checked) => recordHotspotProfileCreation(macB, uuid, checked),
		);
		assert(control, "B control profile add failed");
		created.push(control);
		const controlInstance = getPendingHotspotCreationInstance(macB);
		if (!controlInstance || !recordHotspotProfileCreation(macB, control, controlInstance))
			throw new Error("B control creation-instance persistence failed");
		assert(await nmConnect(control, 30), "B control AP did not activate");
		await refreshCreation(macB, control);
		assert.match(await run("iw", ["dev", b, "info"]), /\btype AP\b/);
		assert(await nmDisconnect(control), "B control AP did not stop");
		await refreshCreation(macB, control);
		console.log("first-ap: distinct-address B activation control passed");

		checkpoint("a.add");
		const uuid = await nmApConnAdd(a, identity, {
			...hotspotBindingFields(macA),
			"802-11-wireless.band": "bg",
			"802-11-wireless.channel": channel,
		}, (generated, checked) => recordHotspotProfileCreation(macA, generated, checked));
		checkpoint("a.add-result");
		assert(uuid, "A profile add failed");
		created.push(uuid);
		checkpoint("a.receipt");
		const instance = getPendingHotspotCreationInstance(macA);
		if (!instance || !recordHotspotProfileCreation(macA, uuid, instance))
			throw new Error("A creation-instance persistence failed");
		checkpoint("a.fields");
		const fields = await nmConnGetFields(uuid, [
			"connection.autoconnect",
			"802-11-wireless.mode",
			"802-11-wireless.mac-address",
			"ipv4.method",
		] as const);
		assert(fields, "A profile read failed");
		checkpoint("a.provenance");
		const provenance = await observeHotspotProfile(uuid);
		assert(
			provenance.kind === "read" && provenance.firstStart,
			"First-start provenance must survive in the native NM profile",
		);
		checkpoint("a.binding");
		assert.deepEqual(
			[fields[0], fields[1], fields[2].toLowerCase(), fields[3]],
			["no", "ap", macA, "shared"],
		);
		checkpoint("a.state");
		const before = await nmDeviceProp(a, "GENERAL.STATE");
		assert(before?.[0], "A device state read failed");
		checkpoint("a.inactive");
		assert.notEqual(Number.parseInt(before[0], 10), 100);
		console.log("first-ap: before up: no, ap, A MAC, shared; A inactive");

		checkpoint("a.runtime");
		assert(await nmConnect(uuid, 30), "A AP did not activate");
		await refreshCreation(macA, uuid);
		const info = await run("iw", ["dev", a, "info"]);
		assert.match(info, /\btype AP\b/);
		assert.match(info, /\bchannel 6\b/);
		const client = crypto.randomUUID();
		created.push(client);
		const added = parseNmConnAddUuid(
			await run("nmcli", [
				"connection",
				"add",
				"type",
				"wifi",
				"ifname",
				c,
				"connection.id",
				"CeraB7-client",
				"connection.uuid",
				client,
				"connection.autoconnect",
				"no",
				"802-11-wireless.ssid",
				identity.name,
				"802-11-wireless-security.key-mgmt",
				"wpa-psk",
				"ipv6.method",
				"ignore",
			]),
		);
		assert(added.ok && added.value === client, "Client profile add failed");
		if (!(await nmConnSetFields(client, { "802-11-wireless-security.psk": identity.password })))
			throw new Error("Client secret persistence failed");
		assert(await nmConnect(client, 30), "Client did not associate");
		const clientState = await nmDeviceProp(c, "GENERAL.STATE,GENERAL.CON-UUID");
		assert.equal(Number.parseInt(clientState?.[0] ?? "", 10), 100);
		assert.equal(clientState?.[1], client);
		assert.match(
			await run("iw", ["dev", c, "link"]),
			new RegExp(`SSID: ${identity.name}\\b`),
		);
		console.log("first-ap: A is AP on channel 6; C joined the intended SSID");
		console.log("first-ap: synthetic PSK persisted and associated; nmcli argv/environment guard passed");

		let incompatible = false;
		try {
			await runHotspotProfileOperation({
				uuid, kind: "up",
				run: async () => {
					await run("nmcli", ["-w", "10", "connection", "up", uuid, "ifname", b]);
					return true;
				},
			});
		} catch (error) {
			const stderr =
				error instanceof Error && "stderr" in error && typeof error.stderr === "string"
					? error.stderr
					: undefined;
			const message = stderr ?? (error instanceof Error ? error.message : String(error));
			console.log(
				"first-ap: wrong-radio refusal:",
				logRedact(
					message
						.replaceAll(identity.password, "<redacted>")
						.replace(
							/((?:password|passphrase|psk|secret|token|pin|puk|api[-_]?key)\b["']?\s*(?:[:=]\s*|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
							"$1<redacted>",
						),
				),
			);
			incompatible =
				stderr !== undefined &&
				/\b(?:mismatching (?:interface name|permanent MAC address)|MACs of the device and the connection didn't match)\b/i.test(
					stderr,
				);
		}
		assert(incompatible, "B must refuse A's profile for interface/MAC incompatibility");
		await refreshCreation(macA, uuid);
		console.log(
			"first-ap: wrong-radio activation refused for interface/MAC incompatibility",
		);
		const beforeRestart = await readNmProfileInstance(uuid);
		assert(beforeRestart?.runId, "NM run identity read failed before restart");
		await run("systemctl", ["restart", "NetworkManager"]);
		const afterRestart = await readNmProfileInstance(uuid);
		assert(afterRestart?.runId, "NM run identity read failed after restart");
		console.log("first-ap: NM restart proof", {
			runChanged: beforeRestart.runId !== afterRestart.runId,
			pathChanged: beforeRestart.path !== afterRestart.path,
			settingsMatch: beforeRestart.fingerprint === afterRestart.fingerprint,
			fileMatch: sameNmProfileFile(beforeRestart.file, afterRestart.file),
		});
		assert.notEqual(beforeRestart.runId, afterRestart.runId);
		assert(sameNmProfileFile(beforeRestart.file, afterRestart.file), "Unchanged keyfile identity changed at NM startup");
		assert(sameNmProfileResource(beforeRestart, afterRestart), "NM restart lost settings continuity");
		assert.equal(sameNmProfileInstance(beforeRestart, afterRestart), false);
		const rebound = await observeHotspotProfile(uuid);
		assert(rebound.kind === "read" && rebound.firstStart, "NM restart lost creation authority");
		console.log("first-ap: NM restart changes run identity and retains profile authority");
		await savedProfileBackendCycle({ uuid, ifname: a, owner: macA }, checkpoint, probe);
		await nativeEditRaceCases({ owner: macA, ifname: a, password: identity.password }, probe, checkpoint);
	} finally {
		for (const uuid of created.reverse()) {
			assert(await nmConnDelete(uuid), "Exact profile cleanup failed");
			for (const owner of getHotspotCredentialOwners(uuid))
				clearHotspotProfileCreation(owner, uuid);
		}
		await probe.close();
	}
	console.log("first-ap: PASS");
}

if (!(await runFirstAp(main))) process.exitCode = 1;
