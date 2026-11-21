import assert from "node:assert/strict";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { run } from "../../../src/helpers/run.ts";
import { onNetworkInterfacesChange } from "../../../src/modules/network/network-interfaces.ts";
import {
	nmApConnAdd,
	nmConnDelete,
	nmConnect,
	nmConnGetFields,
	nmDeviceProp,
	nmDisconnect,
} from "../../../src/modules/network/network-manager.ts";
import {
	getHotspotCredentials,
	initHotspotCredentials,
} from "../../../src/modules/wifi/hotspot-credentials.ts";
import {
	resolveWifiBinding,
	withWifiRequestBinding,
} from "../../../src/modules/wifi/wifi-binding.ts";
import { getWifiInterfacesByMacAddress } from "../../../src/modules/wifi/wifi-connections.ts";
import {
	wifiDeviceListAdd,
	wifiDeviceListEndUpdate,
	wifiDeviceListStartUpdate,
} from "../../../src/modules/wifi/wifi-device-list.ts";
import {
	wifiHotspotPrepare,
	wifiHotspotStart,
} from "../../../src/modules/wifi/wifi-hotspot-activation.ts";
import { hotspotBindingFields } from "../../../src/modules/wifi/wifi-hotspot-types.ts";
import {
	terminateWifiDiscovery,
	wifiUpdateDevices,
} from "../../../src/modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../../src/modules/wifi/wifi-radio-identity.ts";
import { wifiRadioObservation } from "../../../src/modules/wifi/wifi-radio-observation.ts";
import { projectWifiRadioIncarnation } from "../../../src/modules/wifi/wifi-radio-publication.ts";

const address = async (ifname: string) =>
	(await readFile(`/sys/class/net/${ifname}/phy80211/macaddress`, "utf8")).trim();

async function radios() {
	const result: string[] = [];
	for (const ifname of (await readdir("/sys/class/net")).sort()) {
		const phy = await realpath(`/sys/class/net/${ifname}/phy80211`).catch(() => "");
		if (phy.includes("/mac80211_hwsim/")) result.push(ifname);
	}
	return result;
}

async function addTwin(mac: string) {
	// The HWSIM generic-netlink PERM_ADDR attribute sets the wiphy address.
	// Changing the netdev via ip link would only change its operational MAC.
	const child = Bun.spawn(
		[
			"python3",
			"-c",
			`
import socket, struct, sys
s = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, 16)
s.bind((0, 0))
s.settimeout(5)
def attr(t, data):
    n = 4 + len(data)
    return struct.pack("HH", n, t) + data + b"\\0" * ((-n) % 4)
def request(family, command, attrs, seq):
    data = struct.pack("BBH", command, 1, 0) + attrs
    s.sendto(struct.pack("IHHII", 16 + len(data), family, 5, seq, 0) + data, (0, 0))
def replies(seq):
    while True:
        data = s.recv(65536)
        while len(data) >= 16:
            size, kind, _, serial, _ = struct.unpack_from("IHHII", data)
            payload, data = data[16:size], data[(size + 3) & ~3:]
            if serial != seq:
                continue
            if kind == 2:
                error, = struct.unpack_from("i", payload)
                if error < 0:
                    raise OSError(-error, "hwsim netlink refused the requested radio")
                return
            yield payload
request(16, 3, attr(2, b"MAC80211_HWSIM\\0"), 1)
family = None
for reply in replies(1):
    attrs = reply[4:]
    while len(attrs) >= 4:
        size, kind = struct.unpack_from("HH", attrs)
        if kind == 1:
            family, = struct.unpack_from("H", attrs, 4)
        attrs = attrs[(size + 3) & ~3:]
assert family is not None
request(family, 4, attr(22, bytes.fromhex(sys.argv[1].replace(":", ""))), 2)
list(replies(2))
`,
			mac,
		],
		{ stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env },
	);
	assert.equal(
		await child.exited,
		0,
		"Guest kernel did not create a radio with the requested permanent address",
	);
}

type ExpectedAp = { ifname: string; uuid: string; ssid: string };

async function connected({ ifname, uuid, ssid }: ExpectedAp) {
	const proof = await nmDeviceProp(ifname, "GENERAL.STATE,GENERAL.CON-UUID");
	assert.equal(Number.parseInt(proof?.[0] ?? "", 10), 100, `${ifname} must be connected`);
	assert.equal(proof?.[1], uuid, `${ifname} must own its expected active UUID`);
	assert.deepEqual(
		await nmConnGetFields(uuid, ["802-11-wireless.ssid", "802-11-wireless.mode"] as const),
		[ssid, "ap"],
		`${ifname} must use its expected SSID in AP mode`,
	);
}

export function assertActiveApPair(active: string, pair: readonly [ExpectedAp, ExpectedAp]) {
	const connections = new Set(active.split("\n"));
	assert.notEqual(pair[0].uuid, pair[1].uuid, "The APs must use different profiles");
	for (const { ifname, uuid } of pair) {
		assert(
			connections.has(`${uuid}:${ifname}`),
			`${ifname} is missing its AP from the active NM snapshot`,
		);
	}
}

async function managed(ifname: string) {
	await run("nmcli", ["device", "set", ifname, "managed", "yes"]);
	await run("nmcli", ["device", "set", ifname, "autoconnect", "no"]);
}

async function assignGuestPorts(layout: "same" | "distinct", a: string, twin: string) {
	// Retire the previous layout's scheduled samples before restarting NetworkManager.
	wifiRadioObservation.stop();
	await wifiRadioObservation.settled;
	const setup = Bun.spawn(
		[
			"timeout",
			"-k",
			"2",
			"75",
			"bash",
			`${import.meta.dir}/../vm/duplicate-address-ports.sh`,
			layout,
			a,
			twin,
		],
		{ stdin: "ignore", stdout: "inherit", stderr: "inherit" },
	);
	assert.equal(await setup.exited, 0, `Guest port preflight failed for ${layout} paths`);
	await managed(a);
	await managed(twin);
}

async function feedGuestDiscovery() {
	// This standalone check has no backend interface monitor to supply the live snapshot.
	const observations = await Promise.all(
		(await radios()).map(async (ifname) => {
			const [mac, inet] = (await nmDeviceProp(ifname, "GENERAL.HWADDR,IP4.ADDRESS")) ?? [];
			assert(mac, `Native operational address is unreadable for ${ifname}`);
			return { ifname, mac, inet: inet?.split("/")[0] || null };
		}),
	);
	wifiDeviceListStartUpdate();
	for (const { ifname, mac, inet } of observations) {
		wifiDeviceListAdd(ifname, mac.toLowerCase(), inet);
	}
	wifiDeviceListEndUpdate();
}

export async function waitForSettledPublication(
	refresh: () => Promise<unknown>,
	subscribe: (listener: () => void) => () => void,
	settled: () => Promise<void> | undefined,
	ready: () => boolean,
	timeoutDetails: () => string,
) {
	let changed = Promise.withResolvers<void>();
	const unsubscribe = subscribe(() => changed.resolve());
	const deadline = Promise.withResolvers<false>();
	const timer = setTimeout(() => deadline.resolve(false), 20_000);
	const withinDeadline = async (pending: Promise<unknown>) => {
		if (!(await Promise.race([pending.then(() => true), deadline.promise]))) {
			throw new Error(`Timed out waiting for published guest Wi-Fi rows: ${timeoutDetails()}`);
		}
	};
	try {
		await withinDeadline(refresh());
		for (;;) {
			const pending = settled();
			if (pending) {
				await withinDeadline(pending);
				continue;
			}
			// Publication can fire before the sample settles; only the current state counts.
			if (ready()) return;
			await withinDeadline(changed.promise);
			changed = Promise.withResolvers<void>();
		}
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}

type ExpectedRadio = { ifname: string; path?: string };

async function discoverGuestRadios(expected: readonly [ExpectedRadio, ExpectedRadio]) {
	await feedGuestDiscovery();
	const previous = wifiRadioIdentity.publishedObservation;
	await waitForSettledPublication(
		wifiUpdateDevices,
		onNetworkInterfacesChange,
		() => wifiRadioObservation.settled,
		() =>
			wifiRadioIdentity.publishedObservation > previous &&
			expected.every(({ ifname, path }) => {
				const identity = wifiRadioIdentity.state.rows.get(ifname);
				return (
					identity?.row !== undefined &&
					(path === undefined ||
						(identity.classification === "verified" &&
							identity.degradedReason === undefined &&
							identity.devicePath === path)) &&
					getWifiInterfacesByMacAddress()[identity.key] === identity.row &&
					projectWifiRadioIncarnation(identity.row, identity) !== undefined
				);
			}),
		() =>
			expected
				.map(({ ifname }) => {
					const identity = wifiRadioIdentity.state.rows.get(ifname);
					return `${ifname}=${identity?.classification ?? "missing"} (row=${identity?.row?.id ?? "missing"}, path=${identity?.devicePath ?? "missing"}, token=${identity?.row && projectWifiRadioIncarnation(identity.row, identity) ? "ready" : "missing"})`;
				})
				.join(", "),
	);
}

async function checkSharedPortRefusal(a: string, twin: string) {
	await assignGuestPorts("same", a, twin);
	await discoverGuestRadios([{ ifname: a }, { ifname: twin }]);
	for (const ifname of [a, twin]) {
		const identity = wifiRadioIdentity.state.rows.get(ifname);
		assert(identity);
		assert.equal(identity.classification, "limited");
		const row = identity.row;
		assert(row, `No published limited row for ${ifname}`);
		const token = projectWifiRadioIncarnation(row, identity);
		assert(token, `No published incarnation for ${ifname}`);
		assert.deepEqual(await resolveWifiBinding(row.id, token, "config"), {
			success: false,
			error: "radio-unverified",
		});
	}
	console.log("B9 equal-address radios on the same port refused config admission");
}

async function requireNativeGuest() {
	const message = "Use the disposable native hwsim VM started by vm/run-vm.sh";
	assert.equal(process.env.HWSIM_REPO, "/repo", message);
	assert.equal(process.getuid?.(), 0, message);
	assert((await stat("/run/hwsim-client").catch(() => undefined))?.isFile(), message);
	const vm = Bun.spawn(["systemd-detect-virt", "--vm", "--quiet"], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
		timeout: 5_000,
	});
	assert.equal(await vm.exited, 0, message);
}

async function checkDistinctAddressControl(a: string, mac: string) {
	await managed(a);
	const control = { name: "Distinct address control", password: crypto.randomUUID() };
	const uuid = await nmApConnAdd(a, control, hotspotBindingFields(mac));
	assert(uuid);
	try {
		assert(await nmConnect(uuid, 20));
		await connected({ ifname: a, uuid, ssid: control.name });
		console.log("B9 distinct-address control connected to its intended AP profile");
	} finally {
		await nmDisconnect(uuid);
		assert(await nmConnDelete(uuid));
	}
}

async function checkDistinctPortActivation(a: string, twin: string, mac: string) {
	await assignGuestPorts("distinct", a, twin);
	const aPath = (await nmDeviceProp(a, "GENERAL.PATH"))?.[0];
	const bPath = (await nmDeviceProp(twin, "GENERAL.PATH"))?.[0];
	assert(aPath && bPath && aPath !== bPath, "Guest must report two distinct NM port paths");
	const expected = [
		{ ifname: a, path: aPath },
		{ ifname: twin, path: bPath },
	] as const;
	const startAp = async ({ ifname, path }: (typeof expected)[number]): Promise<ExpectedAp> => {
		// Start can schedule another discovery; the next request needs the current publication.
		await discoverGuestRadios(expected);
		const key = `${mac}@${path}`;
		const row = getWifiInterfacesByMacAddress()[key];
		assert(row, `No published port-qualified registry row for ${ifname} (${key})`);
		assert.equal(row.ifname, ifname, `Registry key ${key} must resolve to its expected radio`);
		const token = projectWifiRadioIncarnation(row, wifiRadioIdentity.state.rows.get(ifname));
		assert(token, `No current incarnation for ${ifname} (${key}) before Prepare`);
		const request = { device: String(row.id), expected: token, kind: "config" } as const;
		const draft = await withWifiRequestBinding(request, () =>
			wifiHotspotPrepare({ device: row.id }),
		);
		assert(draft.success && draft.firstTime);
		await discoverGuestRadios(expected);
		assert.equal(
			projectWifiRadioIncarnation(row, wifiRadioIdentity.state.rows.get(ifname)),
			token,
			`Incarnation for ${ifname} (${key}) changed between Prepare and Start`,
		);
		assert(
			(await withWifiRequestBinding(request, () => wifiHotspotStart({ device: row.id }))).success,
		);
		const started = getHotspotCredentials(key)?.conn;
		assert(started);
		const ap = { ifname, uuid: started, ssid: draft.name };
		await connected(ap);
		console.log(`B9 distinct-path AP active ifname=${ifname} key=${key} profile=${started}`);
		return ap;
	};
	const pair = [await startAp(expected[0]), await startAp(expected[1])] as const;
	for (const [index, { path }] of expected.entries()) {
		assert.equal(getHotspotCredentials(`${mac}@${path}`)?.conn, pair[index]?.uuid);
	}
	await Promise.all(pair.map(connected));
	const active = await run("nmcli", [
		"--terse",
		"--escape",
		"no",
		"--fields",
		"UUID,DEVICE",
		"connection",
		"show",
		"--active",
	]);
	assertActiveApPair(active, pair);
	console.log(`B9 same-address APs concurrently active ${JSON.stringify(pair)}`);
}

async function main() {
	await requireNativeGuest();
	const initial = await radios();
	assert.equal(initial.length, 4);
	const a = initial[2];
	const b = initial[3];
	assert(a && b);
	const mac = await address(a);
	assert.notEqual(await address(b), mac);
	await checkDistinctAddressControl(a, mac);

	await addTwin(mac);
	assert.equal(
		await Bun.spawn(["udevadm", "settle", "--timeout=20"], {
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			env: process.env,
		}).exited,
		0,
		"The guest did not settle its new hwsim netdev",
	);
	const twin = (await radios()).find((ifname) => !initial.includes(ifname));
	assert(twin, "No additional hwsim netdev");
	assert.equal(await address(twin), mac, "Both wiphys must report the same permanent address");
	await initHotspotCredentials();
	await checkSharedPortRefusal(a, twin);
	await checkDistinctPortActivation(a, twin, mac);
}

if (import.meta.main) {
	try {
		await main();
	} finally {
		terminateWifiDiscovery();
	}
}
