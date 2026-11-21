import assert from "node:assert/strict";
import { readdir, readFile, realpath } from "node:fs/promises";
import { run } from "../../../src/helpers/run.ts";
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
	wifiHotspotPrepare,
	wifiHotspotStart,
} from "../../../src/modules/wifi/wifi-hotspot-activation.ts";
import { hotspotBindingFields } from "../../../src/modules/wifi/wifi-hotspot-types.ts";
import {
	terminateWifiDiscovery,
	wifiUpdateDevices,
} from "../../../src/modules/wifi/wifi-interfaces.ts";
import { wifiRadioIdentity } from "../../../src/modules/wifi/wifi-radio-identity.ts";
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

async function connected(ifname: string, uuid: string, ssid: string) {
	const proof = await nmDeviceProp(ifname, "GENERAL.STATE,GENERAL.CON-UUID");
	assert.equal(Number.parseInt(proof?.[0] ?? "", 10), 100);
	assert.equal(proof?.[1], uuid);
	assert.deepEqual(await nmConnGetFields(uuid, ["802-11-wireless.ssid"] as const), [ssid]);
}

async function managed(ifname: string) {
	await run("nmcli", ["device", "set", ifname, "managed", "yes"]);
	await run("nmcli", ["device", "set", ifname, "autoconnect", "no"]);
}

async function assignGuestPorts(layout: "same" | "distinct", a: string, twin: string) {
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

async function checkSharedPortRefusal(a: string, twin: string) {
	await assignGuestPorts("same", a, twin);
	await wifiUpdateDevices();
	for (const ifname of [a, twin]) {
		const identity = wifiRadioIdentity.state.rows.get(ifname);
		assert(identity);
		assert.equal(identity.classification, "limited");
		const row = identity.row;
		assert(row, `No published limited row for ${ifname}`);
		const token = projectWifiRadioIncarnation(row, identity);
		assert.deepEqual(await resolveWifiBinding(row.id, token, "config"), {
			success: false,
			error: "radio-unverified",
		});
	}
	console.log("B9 equal-address radios on the same port refused config admission");
}

async function main() {
	assert.equal(process.env.HWSIM_REPO, "/repo", "Use the isolated native VM");
	assert.equal(process.getuid?.(), 0);
	const initial = await radios();
	assert.equal(initial.length, 4);
	const a = initial[2];
	const b = initial[3];
	assert(a && b);
	const mac = await address(a);
	assert.notEqual(await address(b), mac);
	await managed(a);
	const control = { name: "Distinct address control", password: crypto.randomUUID() };
	const uuid = await nmApConnAdd(a, control, hotspotBindingFields(mac));
	assert(uuid);
	try {
		assert(await nmConnect(uuid, 20));
		await connected(a, uuid, control.name);
		console.log("B9 distinct-address control connected to its intended AP profile");
	} finally {
		await nmDisconnect(uuid);
		assert(await nmConnDelete(uuid));
	}

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
	await assignGuestPorts("distinct", a, twin);
	const aPath = (await nmDeviceProp(a, "GENERAL.PATH"))?.[0];
	const bPath = (await nmDeviceProp(twin, "GENERAL.PATH"))?.[0];
	await wifiUpdateDevices();
	const keys = [`${mac}@${aPath}`, `${mac}@${bPath}`];
	const registry = getWifiInterfacesByMacAddress();
	if (!aPath || !bPath || aPath === bPath || keys.some((key) => !registry[key])) {
		const classes = [a, twin].map(
			(ifname) => wifiRadioIdentity.state.rows.get(ifname)?.classification,
		);
		console.error("B9 guest refused distinct port identity for equal permanent addresses", {
			aPath,
			bPath,
			classes,
		});
		assert.deepEqual(classes, ["limited", "limited"]);
		throw new Error("Same-address simulated AP activation remains unqualified");
	}
	for (const key of keys) {
		const row = registry[key];
		assert(row);
		const token = projectWifiRadioIncarnation(row, wifiRadioIdentity.state.rows.get(row.ifname));
		assert(token);
		const request = { device: String(row.id), expected: token, kind: "config" } as const;
		const draft = await withWifiRequestBinding(request, () =>
			wifiHotspotPrepare({ device: row.id }),
		);
		assert(draft.success && draft.firstTime);
		assert(
			(await withWifiRequestBinding(request, () => wifiHotspotStart({ device: row.id }))).success,
		);
		const started = getHotspotCredentials(key)?.conn;
		assert(started);
		await connected(row.ifname, started, draft.name);
	}
	assert.notEqual(
		getHotspotCredentials(keys[0] ?? "")?.conn,
		getHotspotCredentials(keys[1] ?? "")?.conn,
	);
	console.log("B9 same-address radios connected to independent port-owned AP profiles");
}

try {
	await main();
} finally {
	terminateWifiDiscovery();
}
