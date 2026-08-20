/**
 * A LINK WHOSE DEVICE WE CANNOT NAME SAYS SO — it does not get a made-up name.
 *
 * The bond writer used to answer a failed identity resolution with a
 * `lnk_<ifname>` template: a string with the exact shape of a minted id, keyed
 * on the interface NAME. That is the one property this fleet has already proven is
 * not a device — the bench twins ship ONE factory MAC, so systemd can name only
 * one of them predictably (`enx0c5b8f279a64`) and the other falls back to
 * `eth1`, and a replug can swap which is which. An id keyed on the name follows
 * the name, so the next device in that socket inherits the previous unit's
 * telemetry row: RTT, NAKs and all.
 *
 * This suite drives the REAL path — the netif scan, `genSrtlaBondEntries()`, the
 * ADR-003 writer, the telemetry registry and the `status.linkTelemetry`
 * projection — with identity resolution forced to fail, and pins three things:
 * the entry is KEPT (the link still carries traffic), it carries the explicit
 * `unmappable` state rather than an id, and no `lnk_`-prefixed string reaches
 * the operator's payload for it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry as WatchTelemetryFn,
} from "@ceralive/srtla-send/telemetry";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
	processIfconfigOutput,
	resetBondOptOut,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	type BondEntry,
	isMappableEntry,
	isUnmappableEntry,
} from "../modules/streaming/bind-map.ts";
import {
	clearBindMapReport,
	noteWriterBindMapReport,
	resetBindMapReportListeners,
} from "../modules/streaming/bind-map-disposition.ts";
import {
	defaultBindMapWriterDeps,
	defaultSidecarPath,
	publishBondMapping,
	resetBindMapWriter,
} from "../modules/streaming/bind-map-writer.ts";
import { setLinkIdentityDetailResolverForTest } from "../modules/streaming/link-registry.ts";
import {
	buildLinkTelemetry,
	ingestTelemetryForTest,
	registerSrtlaBond,
	setIfaceResolverForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";
import {
	genSrtlaBondEntries,
	setBondIdentityResolverForTest,
} from "../modules/streaming/srtla.ts";

const HEALTHY_IF = "eth0";
const HEALTHY_IP = "192.168.78.132";
const DEGRADED_IF = "usb0";
const DEGRADED_IP = "192.168.8.100";

const MINTED_ID_RE = /^lnk_[0-9a-f]{16}$/;

function ifconfigStanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.8.255`,
		"        ether 0c:5b:8f:27:9a:64  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		"        TX packets 100  bytes 1000 (1.0 KB)",
	].join("\n");
}

/** Attach one healthy uplink and one whose descriptors cannot be read. */
function attachLinks(): void {
	processIfconfigOutput(
		[
			ifconfigStanza(HEALTHY_IF, HEALTHY_IP),
			ifconfigStanza(DEGRADED_IF, DEGRADED_IP),
		].join("\n\n"),
	);
	netIfBuildMsg();
}

/**
 * The failure this exists for: the sysfs descriptor sweep behind
 * `resolveModemPhysicalIdentity` threw for ONE interface. Every other link
 * resolves through the real resolver, so the healthy half of each assertion is
 * a genuinely minted id rather than another fixture.
 */
function failIdentityFor(ifname: string): void {
	setBondIdentityResolverForTest((name) => {
		if (name === ifname) throw new Error("descriptor read failed");
		return resolveModemPhysicalIdentity(name);
	});
}

function writerDeps(): ReturnType<typeof defaultBindMapWriterDeps> {
	const dir = mkdtempSync(join(tmpdir(), "degraded-bindmap-"));
	const ips = join(dir, "srtla_ips");
	return defaultBindMapWriterDeps(ips, defaultSidecarPath(ips));
}

type SenderConnection = Telemetry["connections"][number] & { iface?: string };

/** A snapshot in the pinned binding's shape: no `iface`/`link_id` echo. */
function snapshot(connections: Array<Partial<SenderConnection>>): Telemetry {
	return {
		last_updated_ms: Date.now(),
		connections: connections.map((conn, index) => ({
			conn_id: String(index),
			rtt_ms: 0,
			nak_count: 0,
			weight_percent: 100,
			window: 1000,
			in_flight: 0,
			bitrate_bps: 0,
			...conn,
		})),
	} as Telemetry;
}

function captureWatch(): typeof WatchTelemetryFn {
	const watch: typeof WatchTelemetryFn = (
		_path,
		_cb: (u: TelemetryUpdate) => void,
	) => ({
		stop: () => {},
	});
	return watch;
}

/** Publish a degraded bond exactly as `resolveBindMapArgs` would report it. */
function startDegradedBond(entries: readonly BondEntry[]): void {
	registerSrtlaBond(entries);
	noteWriterBindMapReport("mapping-write-failed", entries);
	startLinkTelemetry(
		"/tmp/unused-degraded-stats.json",
		entries.map((entry) => entry.ip),
		{ watch: captureWatch() },
	);
}

function entryFor(entries: readonly BondEntry[], iface: string): BondEntry {
	const found = entries.find((entry) => entry.iface === iface);
	if (found === undefined) throw new Error(`no bond entry for ${iface}`);
	return found;
}

beforeEach(() => {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of [HEALTHY_IF, DEGRADED_IF]) {
		setNetifDupIpSuppression(name, false);
	}
	resetBondOptOut();
	resetBindMapWriter();
	setQueueUpdateGwHook(null);
	clearBindMapReport();
	// The links report no serial; inventing one here would be the same class of
	// fabrication this suite exists to forbid.
	setLinkIdentityDetailResolverForTest(() => ({}));
});

afterEach(() => {
	stopLinkTelemetry();
	clearBindMapReport();
	resetBindMapReportListeners();
	setBondIdentityResolverForTest(null);
	setLinkIdentityDetailResolverForTest(null);
	setIfaceResolverForTest(null);
});

describe("a failed identity resolution produces a DEGRADED entry", () => {
	test("the entry is kept, carries the explicit state, and carries NO id", () => {
		attachLinks();
		failIdentityFor(DEGRADED_IF);

		const entries = genSrtlaBondEntries();
		const degraded = entryFor(entries, DEGRADED_IF);
		const healthy = entryFor(entries, HEALTHY_IF);

		// KEPT: the link still carries traffic and still names its own interface.
		expect(entries).toHaveLength(2);
		expect(degraded.ip).toBe(DEGRADED_IP);
		expect(isUnmappableEntry(degraded)).toBe(true);
		expect(degraded.linkId).toBeUndefined();
		expect(degraded.identityState).toBe("unmappable");

		// The failure is scoped to the link that failed.
		expect(healthy.identityState).toBeUndefined();
		expect(healthy.linkId).toMatch(MINTED_ID_RE);
	});

	test("no `lnk_`-prefixed string is fabricated for it, in any form", () => {
		attachLinks();
		failIdentityFor(DEGRADED_IF);

		const degraded = entryFor(genSrtlaBondEntries(), DEGRADED_IF);

		expect(JSON.stringify(degraded)).not.toContain("lnk_");
	});

	test("...and it cannot become a sidecar row (ADR-003 §1.1)", () => {
		attachLinks();
		failIdentityFor(DEGRADED_IF);

		const entries = genSrtlaBondEntries();
		expect(isMappableEntry(entryFor(entries, DEGRADED_IF))).toBe(false);
		expect(isMappableEntry(entryFor(entries, HEALTHY_IF))).toBe(true);
	});

	test("the writer still publishes the IP list, and retires the sidecar", async () => {
		attachLinks();
		failIdentityFor(DEGRADED_IF);
		const deps = writerDeps();

		const entries = genSrtlaBondEntries();
		const published = await publishBondMapping(entries, deps);

		expect(published.ok).toBe(false);
		expect(!published.ok && published.reason).toBe("unmappable");
		// Both links are still in the list the sender reads — an undescribable
		// link keeps carrying traffic; it just cannot be told from a twin.
		expect(readFileSync(deps.ipsFile, "utf8").split("\n").sort()).toEqual(
			[DEGRADED_IP, HEALTHY_IP].sort(),
		);
		expect(() => statSync(deps.sidecarFile)).toThrow();
	});

	test("a healthy bond is byte-unchanged — no entry gains the marker", () => {
		attachLinks();

		for (const entry of genSrtlaBondEntries()) {
			expect(entry.identityState).toBeUndefined();
			expect(entry.linkId).toMatch(MINTED_ID_RE);
		}
	});
});

describe("the degraded state reaches the WIRE PROJECTION", () => {
	test("the row says `unmappable` instead of carrying a fabricated id", () => {
		attachLinks();
		failIdentityFor(DEGRADED_IF);
		const entries = genSrtlaBondEntries();
		setIfaceResolverForTest((ip) =>
			ip === DEGRADED_IP
				? DEGRADED_IF
				: ip === HEALTHY_IP
					? HEALTHY_IF
					: undefined,
		);
		startDegradedBond(entries);

		// Today's pinned binding echoes neither `iface` nor `link_id`, so both
		// rows arrive on the legacy `conn_id` rung. `conn_id` is a LINE position,
		// so the expected numbers are derived from publication order rather than
		// assumed — the marker must not disturb which row carries what.
		const rttFor = new Map(entries.map((entry, i) => [entry.iface, 40 + i]));
		ingestTelemetryForTest(
			snapshot(entries.map((_, i) => ({ conn_id: String(i), rtt_ms: 40 + i }))),
		);

		const links = buildLinkTelemetry()?.links ?? [];
		const degradedRow = links.find((link) => link.iface === DEGRADED_IF);
		const healthyRow = links.find((link) => link.iface === HEALTHY_IF);

		expect(degradedRow?.identity_state).toBe("unmappable");
		expect(degradedRow?.link_id).toBeUndefined();
		expect(degradedRow?.rtt_ms).toBe(rttFor.get(DEGRADED_IF));
		expect(healthyRow?.rtt_ms).toBe(rttFor.get(HEALTHY_IF));

		// The legacy rung is untouched for a link that simply resolved there: it
		// makes NO claim about identity, in either direction.
		expect(healthyRow?.identity_state).toBeUndefined();
	});

	test("a sender that ECHOES its interface reaches the same verdict", () => {
		attachLinks();
		failIdentityFor(DEGRADED_IF);
		const entries = genSrtlaBondEntries();
		startDegradedBond(entries);

		ingestTelemetryForTest(
			snapshot([
				{ iface: DEGRADED_IF, rtt_ms: 41 },
				{ conn_id: "1", iface: HEALTHY_IF, rtt_ms: 87 },
			]),
		);

		const links = buildLinkTelemetry()?.links ?? [];
		const degradedRow = links.find((link) => link.iface === DEGRADED_IF);
		const healthyRow = links.find((link) => link.iface === HEALTHY_IF);

		expect(degradedRow?.identity_state).toBe("unmappable");
		expect(degradedRow?.link_id).toBeUndefined();
		// The healthy twin resolves its OWN minted id off the same echo.
		expect(healthyRow?.link_id).toBe(entryFor(entries, HEALTHY_IF).linkId);
		expect(healthyRow?.identity_state).toBeUndefined();
	});

	test("a wholly unresolvable bond projects ZERO `lnk_` ids", () => {
		attachLinks();
		setBondIdentityResolverForTest(() => {
			throw new Error("descriptor read failed");
		});
		const entries = genSrtlaBondEntries();
		setIfaceResolverForTest((ip) =>
			ip === DEGRADED_IP
				? DEGRADED_IF
				: ip === HEALTHY_IP
					? HEALTHY_IF
					: undefined,
		);
		startDegradedBond(entries);
		ingestTelemetryForTest(
			snapshot([{ rtt_ms: 41 }, { conn_id: "1", rtt_ms: 87 }]),
		);

		const payload = buildLinkTelemetry();

		expect(payload?.links).toHaveLength(2);
		for (const link of payload?.links ?? []) {
			expect(link.identity_state).toBe("unmappable");
			expect(link.link_id).toBeUndefined();
		}
		expect(JSON.stringify(payload)).not.toContain("lnk_");
	});

	test("a fully resolved bond emits no marker at all (byte-compat)", () => {
		attachLinks();
		const entries = genSrtlaBondEntries();
		registerSrtlaBond(entries);
		noteWriterBindMapReport("bind-map-passed", entries);
		startLinkTelemetry(
			"/tmp/unused-degraded-stats.json",
			entries.map((entry) => entry.ip),
			{ watch: captureWatch() },
		);
		ingestTelemetryForTest(
			snapshot([{ rtt_ms: 41 }, { conn_id: "1", rtt_ms: 87 }]),
		);

		for (const link of buildLinkTelemetry()?.links ?? []) {
			expect(link.identity_state).toBeUndefined();
			expect(link.link_id).toMatch(MINTED_ID_RE);
		}
	});
});
