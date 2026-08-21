import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type {
	Telemetry,
	TelemetryUpdate,
	watchTelemetry as WatchTelemetryFn,
} from "@ceralive/srtla-send/telemetry";

import type { BondEntry } from "../modules/streaming/bind-map.ts";
import {
	clearBindMapReport,
	getNormalizedBindMapReport,
	noteWriterBindMapReport,
	resetBindMapReportListeners,
} from "../modules/streaming/bind-map-disposition.ts";
import { buildBondMapping } from "../modules/streaming/link-mapping-report.ts";
import {
	portLabelFromIdPath,
	setLinkIdentityDetailResolverForTest,
} from "../modules/streaming/link-registry.ts";
import {
	buildLinkTelemetry,
	ingestTelemetryForTest,
	registerSrtlaBond,
	setIfaceResolverForTest,
	startLinkTelemetry,
	stopLinkTelemetry,
} from "../modules/streaming/link-telemetry.ts";

// The pinned @ceralive/srtla-send build predates todo 8's additive telemetry
// fields and its Zod reader STRIPS unknown keys, so the production reader is
// defensive about them. Fixtures widen the type the same way to model both a
// today's-binding sender (no echo) and a republished one (full echo).
type SenderConnection = Telemetry["connections"][number] & {
	iface?: string;
	link_id?: string;
};
type SenderSnapshot = Omit<Telemetry, "connections"> & {
	connections: Array<SenderConnection>;
	bind_map_status?: unknown;
	disposition?: unknown;
};

function snapshot(
	connections: Array<Partial<SenderConnection>>,
	extra: Partial<Omit<SenderSnapshot, "connections">> = {},
): Telemetry {
	const snap: SenderSnapshot = {
		last_updated_ms: Date.now(),
		connections: connections.map((c, i) => ({
			conn_id: String(i),
			rtt_ms: 0,
			nak_count: 0,
			weight_percent: 100,
			window: 1000,
			in_flight: 0,
			bitrate_bps: 0,
			...c,
		})),
		...extra,
	};
	return snap as Telemetry;
}

function captureWatch() {
	const calls: Array<{ cb: (u: TelemetryUpdate) => void }> = [];
	const watch: typeof WatchTelemetryFn = (_path, cb) => {
		calls.push({ cb });
		return { stop: () => {} };
	};
	return { watch };
}

// The bench twin pair, verbatim in the properties that matter: ONE factory MAC
// (so systemd names one `enx…` and the other falls back to `eth1`), one factory
// LAN subnet (so both lease the host 192.168.8.100), and NO usable USB serial.
const TWIN_A: BondEntry = {
	ip: "192.168.8.100",
	iface: "enx0c5b8f279a64",
	linkId: "lnk_aaaaaaaaaaaaaaaa",
	idPath: "platform-fc880000.usb-usb-0:1.3.1:1.0",
};
const TWIN_B: BondEntry = {
	ip: "192.168.8.100",
	iface: "eth1",
	linkId: "lnk_bbbbbbbbbbbbbbbb",
	idPath: "platform-fc880000.usb-usb-0:1.3.2:1.0",
};

function startWithBond(entries: readonly BondEntry[]): void {
	registerSrtlaBond(entries);
	noteWriterBindMapReport("bind-map-passed", entries);
	startLinkTelemetry(
		"/tmp/unused-stats.json",
		entries.map((e) => e.ip),
		{
			watch: captureWatch().watch,
		},
	);
}

beforeEach(() => {
	// The twins report no serial; a resolver that invented one would be the
	// exact fabrication todo 10's board evidence rules out.
	setLinkIdentityDetailResolverForTest(() => ({}));
	setIfaceResolverForTest(() => undefined);
});

afterEach(() => {
	stopLinkTelemetry();
	clearBindMapReport();
	resetBindMapReportListeners();
	setLinkIdentityDetailResolverForTest(null);
	setIfaceResolverForTest(null);
});

describe("port label", () => {
	test("names the physical USB port, in the kernel's own notation", () => {
		expect(portLabelFromIdPath(TWIN_A.idPath)).toBe("USB 0-1.3.1");
		expect(portLabelFromIdPath(TWIN_B.idPath)).toBe("USB 0-1.3.2");
	});

	test("a path with no USB ancestry yields NO label rather than a raw path", () => {
		expect(portLabelFromIdPath("pci-0000:01:00.0")).toBeUndefined();
		expect(portLabelFromIdPath(undefined)).toBeUndefined();
		expect(portLabelFromIdPath("   ")).toBeUndefined();
	});
});

describe("twin rows carry their own identity", () => {
	test("two same-IP links resolve to DIFFERENT interfaces and ports", () => {
		startWithBond([TWIN_A, TWIN_B]);
		ingestTelemetryForTest(
			snapshot([{ rtt_ms: 41 }, { conn_id: "1", rtt_ms: 87 }]),
		);

		const links = buildLinkTelemetry()?.links ?? [];
		expect(links).toHaveLength(2);
		expect(links[0]).toMatchObject({
			link_id: TWIN_A.linkId,
			iface: "enx0c5b8f279a64",
			port_label: "USB 0-1.3.1",
			rtt_ms: 41,
		});
		expect(links[1]).toMatchObject({
			link_id: TWIN_B.linkId,
			iface: "eth1",
			port_label: "USB 0-1.3.2",
			rtt_ms: 87,
		});
	});

	test("no serial is invented for a device that reports none", () => {
		startWithBond([TWIN_A, TWIN_B]);
		ingestTelemetryForTest(snapshot([{}, { conn_id: "1" }]));

		for (const link of buildLinkTelemetry()?.links ?? []) {
			expect(link.serial).toBeUndefined();
		}
	});

	test("a device that DOES report a serial carries it", () => {
		setLinkIdentityDetailResolverForTest((iface) =>
			iface === "usb0" ? { serial: "2b16081" } : {},
		);
		const stick: BondEntry = {
			ip: "192.168.1.20",
			iface: "usb0",
			linkId: "lnk_cccccccccccccccc",
			idPath: "platform-fc880000.usb-usb-0:1.4.1:1.0",
		};
		startWithBond([stick]);
		ingestTelemetryForTest(snapshot([{}]));

		expect(buildLinkTelemetry()?.links[0]?.serial).toBe("2b16081");
	});
});

describe("row identity survives a reload that swaps file order", () => {
	// THE defect this whole plan exists to end: `conn_id` is a POSITION in
	// BIND_IPS_FILE, so a SIGHUP that republishes the bond in the other order
	// hands the same modem a different one. A row keyed on the position follows
	// the position; a row keyed on `link_id` follows the modem.
	test("each twin's stats stay attached to the twin that produced them", () => {
		startWithBond([TWIN_A, TWIN_B]);
		ingestTelemetryForTest(
			snapshot([
				{ rtt_ms: 41, nak_count: 3 },
				{ conn_id: "1", rtt_ms: 87, nak_count: 11 },
			]),
		);

		const before = new Map(
			(buildLinkTelemetry()?.links ?? []).map((l) => [l.link_id, l]),
		);
		expect(before.get(TWIN_A.linkId)).toMatchObject({
			iface: "enx0c5b8f279a64",
			rtt_ms: 41,
			nak_count: 3,
		});

		// The reload: same two links, opposite file order. Line 0 is now TWIN_B,
		// so the sender's conn_id 0 carries B's numbers.
		registerSrtlaBond([TWIN_B, TWIN_A]);
		noteWriterBindMapReport("bind-map-passed", [TWIN_B, TWIN_A]);
		ingestTelemetryForTest(
			snapshot([
				{ rtt_ms: 92, nak_count: 12 },
				{ conn_id: "1", rtt_ms: 38, nak_count: 4 },
			]),
		);

		const after = new Map(
			(buildLinkTelemetry()?.links ?? []).map((l) => [l.link_id, l]),
		);
		// A is still A: its own interface, its own port, and the numbers from the
		// slot it actually occupies after the swap — never B's.
		expect(after.get(TWIN_A.linkId)).toMatchObject({
			iface: "enx0c5b8f279a64",
			port_label: "USB 0-1.3.1",
			rtt_ms: 38,
			nak_count: 4,
		});
		expect(after.get(TWIN_B.linkId)).toMatchObject({
			iface: "eth1",
			port_label: "USB 0-1.3.2",
			rtt_ms: 92,
			nak_count: 12,
		});
	});

	test("a sender that ECHOES link_id is authoritative over file order", () => {
		startWithBond([TWIN_A, TWIN_B]);
		// Deliberately contradictory: position 0 claims to be TWIN_B. A republished
		// binding's echo must win, because it names the row the sender really bound.
		ingestTelemetryForTest(
			snapshot([
				{ link_id: TWIN_B.linkId, rtt_ms: 92 },
				{ conn_id: "1", link_id: TWIN_A.linkId, rtt_ms: 38 },
			]),
		);

		const links = buildLinkTelemetry()?.links ?? [];
		expect(links[0]).toMatchObject({
			link_id: TWIN_B.linkId,
			iface: "eth1",
			rtt_ms: 92,
		});
		expect(links[1]).toMatchObject({
			link_id: TWIN_A.linkId,
			iface: "enx0c5b8f279a64",
			rtt_ms: 38,
		});
	});
});

describe("the legacy rung is untouched", () => {
	test("with no mapping in force a conn_id still resolves through the IP list", () => {
		setIfaceResolverForTest((ip) => (ip === "10.0.0.5" ? "wlan0" : undefined));
		startLinkTelemetry("/tmp/unused-stats.json", ["10.0.0.5"], {
			watch: captureWatch().watch,
		});
		ingestTelemetryForTest(snapshot([{ rtt_ms: 7 }]));

		const link = buildLinkTelemetry()?.links[0];
		expect(link).toMatchObject({ iface: "wlan0", rtt_ms: 7 });
		expect(link?.link_id).toBeUndefined();
		expect(link?.port_label).toBeUndefined();
	});

	test("a DEGRADED mapping never indexes by line — the sender collapsed the twins", () => {
		registerSrtlaBond([TWIN_A, TWIN_B]);
		noteWriterBindMapReport("capability-unsupported", [TWIN_A, TWIN_B]);
		setIfaceResolverForTest((ip) =>
			ip === "192.168.8.100" ? "enx0c5b8f279a64" : undefined,
		);
		startLinkTelemetry("/tmp/unused-stats.json", ["192.168.8.100"], {
			watch: captureWatch().watch,
		});
		ingestTelemetryForTest(snapshot([{ rtt_ms: 41 }]));

		const link = buildLinkTelemetry()?.links[0];
		expect(link?.link_id).toBeUndefined();
		expect(link?.iface).toBe("enx0c5b8f279a64");
	});
});

describe("the normalized disposition reaches the wire", () => {
	test("a degraded startup names the collision group and its reason", () => {
		registerSrtlaBond([TWIN_A, TWIN_B]);
		noteWriterBindMapReport("capability-unsupported", [TWIN_A, TWIN_B]);

		expect(buildBondMapping()).toEqual({
			state: "degraded",
			reason: "unsupported",
			disposition: "startup_collision_excluded",
			collisions: [
				{
					ip: "192.168.8.100",
					effective_index: 0,
					excluded_indices: [1],
				},
			],
			source: "writer",
		});
	});

	test("a mapped bond is silent, and no bond at all is null", () => {
		registerSrtlaBond([TWIN_A, TWIN_B]);
		noteWriterBindMapReport("bind-map-passed", [TWIN_A, TWIN_B]);
		expect(buildBondMapping()).toMatchObject({
			state: "active",
			disposition: "mapped",
		});

		clearBindMapReport();
		expect(buildBondMapping()).toBeNull();
	});

	test("the sender's own verdict REPLACES the writer's synthesized one", () => {
		startWithBond([TWIN_A, TWIN_B]);
		expect(getNormalizedBindMapReport()?.source).toBe("writer");

		ingestTelemetryForTest(
			snapshot([{}, { conn_id: "1" }], {
				bind_map_status: { state: "degraded", reason: "hash_mismatch" },
				disposition: { state: "retained_last_valid" },
			}),
		);

		expect(buildBondMapping()).toEqual({
			state: "degraded",
			reason: "hash_mismatch",
			disposition: "retained_last_valid",
			source: "sender",
		});
	});

	test("a sender that reports NOTHING leaves the writer's verdict standing", () => {
		startWithBond([TWIN_A, TWIN_B]);
		noteWriterBindMapReport("mapping-write-failed", [TWIN_A, TWIN_B]);

		ingestTelemetryForTest(snapshot([{}, { conn_id: "1" }]));

		expect(buildBondMapping()).toMatchObject({
			reason: "missing_file",
			source: "writer",
		});
	});

	test("a garbage disposition is not adopted as a verdict", () => {
		startWithBond([TWIN_A, TWIN_B]);
		ingestTelemetryForTest(
			snapshot([{}, { conn_id: "1" }], {
				bind_map_status: { state: "not-a-state" },
				disposition: { state: 7 },
			}),
		);

		expect(buildBondMapping()?.source).toBe("writer");
	});
});
