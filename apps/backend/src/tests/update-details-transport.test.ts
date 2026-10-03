/**
 * Todo 41 — the Updates dialog's backend reads.
 *
 *   1. `summarizeTransportSelection` projects a ranked selection onto the wire
 *      summary without inventing a verdict (captive is derived from the probe
 *      states, never assumed).
 *   2. `readUpdateDetails` degrades each block to `null` independently and never
 *      claims a slot mirror on a legacy image or a "staged" image after the
 *      orchestrator has left the staged phases.
 *   3. The runtime's pending cellular approval exists ONLY while the D12 gate is
 *      actually holding that candidate, and every real state transition pushes
 *      the `update_orchestrator` wire projection.
 */
/**
 * Todo 41 — the Updates dialog's backend reads.
 *
 *   1. `summarizeTransportSelection` projects a ranked selection onto the wire
 *      summary without inventing a verdict (captive is derived from the probe
 *      states, never assumed).
 *   2. `readUpdateDetails` degrades each block to `null` independently and never
 *      claims a slot mirror on a legacy image or a "staged" image after the
 *      orchestrator has left the staged phases.
 *   3. The runtime's pending cellular approval exists ONLY while the D12 gate is
 *      actually holding that candidate, and every real state transition pushes
 *      the `update_orchestrator` wire projection.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import type { RankedTransport } from "../modules/system/update-transport/core.ts";
import {
	getLastTransportSelection,
	recordTransportSelection,
	resetLastTransportSelectionForTest,
	summarizeTransportSelection,
} from "../modules/system/update-transport/last-selection.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	resetLastTransportSelectionForTest();
});

function row(
	ifname: string,
	family: 4 | 6,
	healthy: boolean,
	states: RankedTransport["hosts"][number]["state"][],
	kind: RankedTransport["candidate"]["kind"] = "ethernet",
	metered = false,
): RankedTransport {
	return {
		candidate: { ifname, kind, metered },
		family,
		hosts: states.map((state, index) => ({
			host: `h${index}`,
			state,
			latencyMs: 10,
		})),
		healthy,
		latencyMs: 10,
		reason: "fixture",
	};
}

describe("summarizeTransportSelection", () => {
	test("names the selected uplink and flags the captive candidate it passed over", () => {
		const selected = row("eth0", 4, true, ["clear", "clear"]);
		const captive = row("wlan0", 4, false, ["captive-http", "clear"], "wifi");
		const summary = summarizeTransportSelection(
			"os",
			{ status: "selected", selected, ranked: [selected, captive] },
			1234,
		);
		expect(summary).toEqual({
			profile: "os",
			checkedAt: 1234,
			status: "selected",
			selected: { ifname: "eth0", kind: "ethernet", family: 4, metered: false },
			findings: [
				{
					ifname: "eth0",
					kind: "ethernet",
					family: 4,
					metered: false,
					healthy: true,
					captive: false,
					states: [],
				},
				{
					ifname: "wlan0",
					kind: "wifi",
					family: 4,
					metered: false,
					healthy: false,
					captive: true,
					states: ["captive-http"],
				},
			],
		});
	});

	test("no healthy transport selects nothing and de-duplicates verdicts", () => {
		const blocked = row("eth0", 6, false, [
			"no-route",
			"no-route",
			"dns-failed",
		]);
		const summary = summarizeTransportSelection(
			"apt",
			{ status: "none", reason: "no-healthy-transport", ranked: [blocked] },
			5,
		);
		expect(summary.status).toBe("none");
		expect(summary.selected).toBeNull();
		expect(summary.findings[0]?.states).toEqual(["no-route", "dns-failed"]);
		expect(summary.findings[0]?.captive).toBe(false);
	});

	test("the record is empty until a selection runs, then reads it back", () => {
		expect(getLastTransportSelection()).toBeUndefined();
		recordTransportSelection(
			"os",
			{ status: "none", reason: "no-healthy-transport", ranked: [] },
			9,
		);
		expect(getLastTransportSelection()?.checkedAt).toBe(9);
	});
});

const candidate = osChannelManifestSchema.parse({
	schema: 1,
	board: "rock-5b-plus",
	compatible: "ceralive-rock-5b-plus",
	channel: "stable",
	version: "2026.10.0",
	serial: 3,
	published_at: "2026-09-24T12:00:00Z",
	expires_at: "2026-12-30T12:00:00Z",
	os_version_id: "13",
	min_ceraui_version: "2026.9.3",
	bundle: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/bundle.raucb",
		size: 734_003_200,
		sha256: "a".repeat(64),
	},
	flash: {
		url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/flash.raw.xz",
		size: 100,
		sha256: "b".repeat(64),
		raw_sha256: "c".repeat(64),
	},
	lock_url:
		"https://images.ceralive.tv/releases/rock-5b-plus/2026.10.0/packages.lock.json",
});
