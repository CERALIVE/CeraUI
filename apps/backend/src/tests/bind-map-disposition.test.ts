/**
 * The TYPED-DISPOSITION PRODUCER BOUNDARY.
 *
 * Two launch paths exist that the sender structurally cannot report — an old
 * binary with no `--bind-map`, and a mapping the writer could not put on disk —
 * and on both of them CeraUI has to speak for it. This suite pins that the
 * writer synthesizes the SAME typed values todo 8 defined, that sender-reported
 * telemetry replaces them, and that EVERY degradation cause reaches an operator.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { mintLinkId } from "../modules/modems/physical-identity.ts";
import type { BondEntry } from "../modules/streaming/bind-map.ts";
import {
	type BindMapDegradedReason,
	clearBindMapReport,
	getNormalizedBindMapReport,
	isOperatorVisibleDegradation,
	noteSenderBindMapReport,
	noteWriterBindMapReport,
	synthesizeWriterReport,
} from "../modules/streaming/bind-map-disposition.ts";
import { bindMapBandMessage } from "../modules/streaming/bind-map-notification.ts";
import {
	classifyCapabilityDocument,
	probeSrtlaSenderCapabilities,
} from "../modules/streaming/srtla-capabilities.ts";

const TWIN_IP = "192.168.8.100";

const entry = (ip: string, iface: string): BondEntry => ({
	ip,
	iface,
	linkId: mintLinkId(`ifname:${iface}`),
});

const TWINS: BondEntry[] = [
	entry("10.0.0.1", "eth0"),
	entry(TWIN_IP, "enx0c5b8f279a64"),
	entry(TWIN_IP, "eth1"),
];

const UNIQUE: BondEntry[] = [
	entry("10.0.0.1", "eth0"),
	entry("10.0.0.2", "wwan0"),
];

const CAPABILITY_DOC = JSON.stringify({
	schema_version: 1,
	binary: "srtla_send",
	version: "3.2.0",
	capabilities: { bind_map: true, bind_map_schema_version: 1 },
});

beforeEach(() => {
	clearBindMapReport();
});

describe("pre-spawn capability probe (ADR-003 §7 caller contract)", () => {
	test("a valid document authorizes --bind-map", () => {
		expect(classifyCapabilityDocument(0, CAPABILITY_DOC)).toEqual({
			bindMap: true,
			bindMapSchemaVersion: 1,
		});
	});

	test("EVERY failure mode is read as NO SUPPORT", () => {
		// The shipped 3.2.0 binary answers `error: unexpected argument` with exit
		// 2 — we match on nothing, so a future build's different refusal lands here
		// identically.
		expect(classifyCapabilityDocument(2, "error: unexpected argument")).toEqual(
			{ bindMap: false, reason: "nonzero-exit" },
		);
		expect(classifyCapabilityDocument(0, "not json").bindMap).toBe(false);
		expect(classifyCapabilityDocument(0, "null").bindMap).toBe(false);
		expect(classifyCapabilityDocument(0, "{}").bindMap).toBe(false);
		expect(
			classifyCapabilityDocument(0, '{"capabilities":{"bind_map":false}}')
				.bindMap,
		).toBe(false);
		expect(
			classifyCapabilityDocument(
				0,
				'{"capabilities":{"bind_map":true,"bind_map_schema_version":2}}',
			),
		).toEqual({ bindMap: false, reason: "schema-unsupported" });
	});

	test("a probe that THROWS never propagates — it degrades", async () => {
		const result = await probeSrtlaSenderCapabilities("/usr/bin/srtla_send", {
			runProbe: () => Promise.reject(new Error("ENOENT")),
		});
		expect(result).toEqual({ bindMap: false, reason: "spawn-failed" });
	});
});

describe("writer-side synthesis (the paths the sender cannot report)", () => {
	test("an OLD sender with twins: startup_collision_excluded, group named", () => {
		const report = synthesizeWriterReport("capability-unsupported", TWINS);
		expect(report.source).toBe("writer");
		expect(report.status).toEqual({ state: "degraded", reason: "unsupported" });
		expect(report.disposition.state).toBe("startup_collision_excluded");
		expect(report.disposition.collisions).toEqual([
			{ ip: TWIN_IP, effective_index: 1, excluded_indices: [2] },
		]);
	});

	test("an OLD sender with unique links only: legacy_unique_only", () => {
		const report = synthesizeWriterReport("capability-unsupported", UNIQUE);
		expect(report.disposition).toEqual({ state: "legacy_unique_only" });
	});

	test("a failed mapping write reports missing_file, not silence", () => {
		const report = synthesizeWriterReport("mapping-write-failed", TWINS);
		expect(report.status).toEqual({
			state: "degraded",
			reason: "missing_file",
		});
		expect(report.disposition.state).toBe("startup_collision_excluded");
	});

	test("the mapped path is active/mapped and raises no band", () => {
		const report = synthesizeWriterReport("bind-map-passed", TWINS);
		expect(report.status).toEqual({ state: "active" });
		expect(report.disposition).toEqual({ state: "mapped" });
		expect(isOperatorVisibleDegradation(report)).toBe(false);
		expect(bindMapBandMessage(report)).toBeUndefined();
	});
});

describe("ONE normalized stream — sender-reported REPLACES synthesized", () => {
	test("the writer's verdict stands until telemetry arrives", () => {
		noteWriterBindMapReport("bind-map-passed", TWINS);
		expect(getNormalizedBindMapReport()?.source).toBe("writer");

		noteSenderBindMapReport({
			status: { state: "degraded", reason: "hash_mismatch" },
			disposition: { state: "retained_last_valid" },
		});
		const report = getNormalizedBindMapReport();
		expect(report?.source).toBe("sender");
		expect(report?.disposition.state).toBe("retained_last_valid");
	});

	test("a new launch retires the previous session's sender claim", () => {
		noteSenderBindMapReport({
			status: { state: "degraded", reason: "malformed" },
			disposition: { state: "retained_last_valid" },
		});
		noteWriterBindMapReport("bind-map-passed", UNIQUE);
		expect(getNormalizedBindMapReport()?.source).toBe("writer");
	});

	test("a stopped session makes no claim at all", () => {
		noteWriterBindMapReport("capability-unsupported", TWINS);
		clearBindMapReport();
		expect(getNormalizedBindMapReport()).toBeUndefined();
		expect(isOperatorVisibleDegradation(undefined)).toBe(false);
	});
});

describe("every degradation cause reaches the operator", () => {
	const SENDER_REASONS: BindMapDegradedReason[] = [
		"hash_mismatch",
		"malformed",
		"unknown_iface",
		"retry_exhausted",
		"missing_file",
		"unreadable",
		"unsupported",
	];

	test("a degraded RELOAD says both twins are still running", () => {
		for (const reason of SENDER_REASONS) {
			noteSenderBindMapReport({
				status: { state: "degraded", reason },
				disposition: { state: "retained_last_valid" },
			});
			const report = getNormalizedBindMapReport();
			expect(isOperatorVisibleDegradation(report)).toBe(true);
			const message = bindMapBandMessage(
				report ?? {
					status: {} as never,
					disposition: {} as never,
					source: "sender",
				},
			);
			expect(message).toContain(reason);
			expect(message).toContain("still running");
		}
	});

	test("a degraded STARTUP names the group and refuses to name the twin", () => {
		noteSenderBindMapReport({
			status: { state: "degraded", reason: "malformed" },
			disposition: {
				state: "startup_collision_excluded",
				collisions: [
					{ ip: TWIN_IP, effective_index: 1, excluded_indices: [2] },
				],
			},
		});
		const message = bindMapBandMessage(
			getNormalizedBindMapReport() as never,
		) as string;
		expect(message).toContain(TWIN_IP);
		expect(message).toContain("line 1");
		expect(message).toContain("line 2");
		expect(message).toContain("cannot tell which physical modem");
	});

	test("an old sender with unique links is honest without alarming", () => {
		noteWriterBindMapReport("capability-unsupported", UNIQUE);
		const report = getNormalizedBindMapReport();
		expect(isOperatorVisibleDegradation(report)).toBe(true);
		const message = bindMapBandMessage(report as never) as string;
		expect(message).toContain("bonded normally");
		expect(message).toContain("unsupported");
	});

	test("NO degraded disposition is ever silent", () => {
		const states = [
			"retained_last_valid",
			"legacy_unique_only",
			"startup_collision_excluded",
		] as const;
		for (const state of states) {
			const message = bindMapBandMessage({
				status: { state: "degraded", reason: "malformed" },
				disposition: { state },
				source: "sender",
			});
			expect(message).toBeDefined();
			expect((message as string).length).toBeGreaterThan(0);
		}
	});
});
