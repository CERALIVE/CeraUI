/**
 * The WRITER half of ADR-003, and the duplicate-IP policy split it unlocks.
 *
 * The fixture is the bench's real defect: two Huawei HiLink twins that ship ONE
 * factory MAC and both lease the host `192.168.8.100`. Before this change the
 * pair was flagged and dropped from the bond entirely; the operator saw one link
 * where two were plugged in, with no explanation anywhere.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeExclusionReason } from "../modules/network/connectivity-candidates.ts";
import {
	getNetworkInterfaces,
	isBondCandidate,
	NETIF_ERR_DUPIPV4,
	NETIF_ERR_HOTSPOT,
	type NetworkInterface,
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOut,
	setBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	type BondEntry,
	collisionGroups,
	isMappableEntry,
	renderIpsFile,
} from "../modules/streaming/bind-map.ts";
import {
	defaultBindMapWriterDeps,
	defaultSidecarPath,
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import { genSrtlaBondEntries } from "../modules/streaming/srtla.ts";

const TWIN_IP = "192.168.8.100";

function ifconfigStanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.8.255`,
		"        ether 0c:5b:8f:27:9a:64  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

function attachTwins(): void {
	processIfconfigOutput(
		[
			ifconfigStanza("enx0c5b8f279a64", TWIN_IP),
			ifconfigStanza("eth1", TWIN_IP),
			ifconfigStanza("eth0", "192.168.78.132"),
		].join("\n\n"),
	);
}

function iface(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: TWIN_IP,
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
		...over,
	};
}

function writerDeps(): ReturnType<typeof defaultBindMapWriterDeps> {
	const dir = mkdtempSync(join(tmpdir(), "bindmap-"));
	const ips = join(dir, "srtla_ips");
	return defaultBindMapWriterDeps(ips, defaultSidecarPath(ips));
}

const entry = (ip: string, ifname: string, linkId: string): BondEntry => ({
	ip,
	iface: ifname,
	linkId,
});

beforeEach(() => {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of ["enx0c5b8f279a64", "eth1", "eth0"]) {
		setNetifDupIpSuppression(name, false);
	}
	resetBondOptOut();
	resetBindMapWriter();
	setQueueUpdateGwHook(null);
});

describe("duplicate-IP policy split", () => {
	test("the twins stay FLAGGED and stay invalid for a source-IP probe", () => {
		attachTwins();
		netIfBuildMsg();

		const netif = getNetworkInterfaces();
		const twinA = netif["enx0c5b8f279a64"];
		const twinB = netif.eth1;
		expect(twinA?.error).toBe(NETIF_ERR_DUPIPV4);
		expect(twinB?.error).toBe(NETIF_ERR_DUPIPV4);
		expect(probeExclusionReason(twinA)).toBe("duplicate IPv4 addr");
		expect(probeExclusionReason(twinB)).toBe("duplicate IPv4 addr");
	});

	test("...and become BONDING-ELIGIBLE, producing two same-IP lines", () => {
		attachTwins();
		netIfBuildMsg();

		const entries = genSrtlaBondEntries();
		const twins = entries.filter((e) => e.ip === TWIN_IP);
		expect(twins).toHaveLength(2);
		expect(twins.map((e) => e.iface).sort()).toEqual([
			"enx0c5b8f279a64",
			"eth1",
		]);
		expect(new Set(twins.map((e) => e.linkId)).size).toBe(2);
		expect(renderIpsFile(twins)).toBe(`${TWIN_IP}\n${TWIN_IP}`);
	});

	test("the operator's bond toggle still governs membership", () => {
		attachTwins();
		netIfBuildMsg();

		setBondOptOut("eth1", true);
		const entries = genSrtlaBondEntries();
		expect(entries.filter((e) => e.ip === TWIN_IP)).toHaveLength(1);
		expect(entries.some((e) => e.iface === "eth1")).toBe(false);
	});

	test("a NON-dup error still disqualifies outright", () => {
		expect(isBondCandidate("wlan0", iface({ error: NETIF_ERR_HOTSPOT }))).toBe(
			false,
		);
		expect(
			isBondCandidate(
				"wlan0",
				iface({ error: NETIF_ERR_HOTSPOT | NETIF_ERR_DUPIPV4 }),
			),
		).toBe(false);
		expect(isBondCandidate("eth0", iface({ enabled: false }))).toBe(false);
		expect(isBondCandidate("eth0", iface({ ip: undefined }))).toBe(false);
	});

	test("a link that cannot be DESCRIBED is not made eligible by wishing", () => {
		expect(isMappableEntry(entry(TWIN_IP, "eth0", "lnk_a"))).toBe(true);
		expect(
			isMappableEntry(entry(TWIN_IP, "an-interface-name-too-long", "lnk_a")),
		).toBe(false);
		expect(isMappableEntry(entry(TWIN_IP, "a/b", "lnk_a"))).toBe(false);
		expect(isMappableEntry(entry(TWIN_IP, "eth 0", "lnk_a"))).toBe(false);
		expect(isMappableEntry(entry(TWIN_IP, "eth0", "lnk a"))).toBe(false);
		expect(isMappableEntry(entry("", "eth0", "lnk_a"))).toBe(false);
	});
});

describe("collision groups (what legacy mode loses)", () => {
	test("a same-IP group names its representative and its excluded lines", () => {
		const groups = collisionGroups([
			entry("10.0.0.1", "eth0", "lnk_a"),
			entry(TWIN_IP, "enx0c5b8f279a64", "lnk_b"),
			entry(TWIN_IP, "eth1", "lnk_c"),
		]);
		expect(groups).toEqual([
			{ ip: TWIN_IP, effective_index: 1, excluded_indices: [2] },
		]);
	});

	test("unique links produce no group at all", () => {
		expect(
			collisionGroups([
				entry("10.0.0.1", "eth0", "lnk_a"),
				entry("10.0.0.2", "eth1", "lnk_b"),
			]),
		).toEqual([]);
	});
});

describe("ADR-003 publication protocol", () => {
	test("the twins produce a coherent pair the sender would accept", async () => {
		const deps = writerDeps();
		const entries = [
			entry(TWIN_IP, "enx0c5b8f279a64", "lnk_aaaaaaaaaaaaaaaa"),
			entry(TWIN_IP, "eth1", "lnk_bbbbbbbbbbbbbbbb"),
		];

		const published = await publishBondMapping(entries, deps);
		expect(published.ok).toBe(true);

		const ipsBytes = readFileSync(deps.ipsFile);
		expect(ipsBytes.toString()).toBe(`${TWIN_IP}\n${TWIN_IP}`);

		const sidecar = JSON.parse(readFileSync(deps.sidecarFile, "utf8"));
		expect(sidecar.schema_version).toBe(1);
		expect(sidecar.generation).toBe(1);
		expect(sidecar.ips_file_sha256).toBe(
			new Bun.CryptoHasher("sha256").update(ipsBytes).digest("hex"),
		);
		expect(sidecar.links).toEqual([
			{
				link_id: "lnk_aaaaaaaaaaaaaaaa",
				ip: TWIN_IP,
				iface: "enx0c5b8f279a64",
			},
			{ link_id: "lnk_bbbbbbbbbbbbbbbb", ip: TWIN_IP, iface: "eth1" },
		]);
	});

	test("the sidecar is not group- or world-writable (the reader refuses those)", async () => {
		const deps = writerDeps();
		await publishBondMapping([entry("10.0.0.1", "eth0", "lnk_a")], deps);
		expect(statSync(deps.sidecarFile).mode & 0o077).toBe(0);
	});

	test("generation advances on every publication, mapping-only included", async () => {
		const deps = writerDeps();
		const first = await publishBondMapping(
			[entry("10.0.0.1", "eth0", "lnk_a")],
			deps,
		);
		// SAME ip bytes, DIFFERENT interface — the digest cannot see this, so only
		// the generation can, and `changed` must still ask for a SIGHUP.
		const second = await publishBondMapping(
			[entry("10.0.0.1", "eth9", "lnk_a")],
			deps,
		);
		const third = await publishBondMapping(
			[entry("10.0.0.1", "eth9", "lnk_a")],
			deps,
		);

		expect(first.ok && first.generation).toBe(1);
		expect(second.ok && second.generation).toBe(2);
		expect(second.changed).toBe(true);
		expect(third.changed).toBe(false);
	});

	test("an undescribable link publishes the IP list and retires the sidecar", async () => {
		const deps = writerDeps();
		await publishBondMapping([entry("10.0.0.1", "eth0", "lnk_a")], deps);
		expect(statSync(deps.sidecarFile).isFile()).toBe(true);

		const result = await publishBondMapping(
			[entry("10.0.0.1", "eth0", "lnk_a"), entry("10.0.0.2", "a/b", "lnk_b")],
			deps,
		);

		expect(result.ok).toBe(false);
		expect(!result.ok && result.reason).toBe("unmappable");
		expect(readFileSync(deps.ipsFile, "utf8")).toBe("10.0.0.1\n10.0.0.2");
		expect(() => statSync(deps.sidecarFile)).toThrow();
	});

	test("a failed sidecar write leaves NO stale sidecar behind", async () => {
		const deps = writerDeps();
		let removed = false;
		const failing = {
			...deps,
			writeFile: async (path: string, contents: string) => {
				if (path.startsWith(deps.sidecarFile)) throw new Error("ENOSPC");
				await deps.writeFile(path, contents);
			},
			removeFile: async (path: string) => {
				removed = true;
				await deps.removeFile(path);
			},
		};

		const result = await publishBondMapping(
			[entry("10.0.0.1", "eth0", "lnk_a")],
			failing,
		);

		expect(!result.ok && result.reason).toBe("sidecar_write_failed");
		expect(removed).toBe(true);
		expect(readFileSync(deps.ipsFile, "utf8")).toBe("10.0.0.1");
	});

	test("the session fires SIGHUP off `changed`, not off the IP list", () => {
		// `refreshSrtlaIpAddresses` is private to start(), so the wiring is pinned
		// statically — the same technique cellular-boot-order.test.ts uses for a
		// module it cannot import and run. Keying the reload on an IP-list diff
		// instead would silently skip every mapping-only reload.
		const session = readFileSync(
			new URL("../modules/streaming/streamloop/session.ts", import.meta.url)
				.pathname,
			"utf8",
		);
		expect(session).toContain(
			"if (publication.changed && getIsStreaming()) restartSrtla();",
		);
	});
});
