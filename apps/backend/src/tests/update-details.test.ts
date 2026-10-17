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
import {
	readUpdateDetails,
	type UpdateDetailsDeps,
} from "../modules/system/update-orchestrator/details.ts";
import { osChannelManifestSchema } from "../modules/system/update-orchestrator/os-manifest.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import {
	initialOrchestratorState,
	type OrchestratorState,
} from "../modules/system/update-orchestrator/types.ts";
import { resetLastTransportSelectionForTest } from "../modules/system/update-transport/last-selection.ts";

afterEach(() => {
	resetOrchestratorRuntimeForTest();
	resetLastTransportSelectionForTest();
});

function detailsDeps(
	overrides: Partial<UpdateDetailsDeps> = {},
	state: Partial<OrchestratorState> = {},
): { deps: UpdateDetailsDeps; calls: { slots: number; receipt: number } } {
	const calls = { slots: 0, receipt: 0 };
	const base: OrchestratorState = { ...initialOrchestratorState(0), ...state };
	return {
		calls,
		deps: {
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
			readSlots: async () => {
				calls.slots += 1;
				return [
					{
						name: "rootfs.0",
						bootname: "A",
						state: "booted",
						bootStatus: "good",
						version: "2026.9.0",
						lastSyncedAt: null,
					},
				];
			},
			readBootedVersion: async () => "2026.9.0",
			readStagedReceipt: async () => {
				calls.receipt += 1;
				return { version: "2026.10.0", stagedAt: 77 };
			},
			orchestratorState: () => base,
			osSummary: () => ({ candidate: null, pendingCellular: null }),
			lastTransport: () => undefined,
			...overrides,
		},
	};
}

describe("readUpdateDetails", () => {
	test("a legacy image reports no slots and never runs rauc status", async () => {
		const { deps, calls } = detailsDeps();
		const details = await readUpdateDetails(deps);
		expect(details.slots).toBeNull();
		expect(calls.slots).toBe(0);
		expect(details.os.bootedVersion).toBe("2026.9.0");
		expect(details.transport).toBeNull();
	});

	test("a slot-sync image reports both slots verbatim", async () => {
		const { deps } = detailsDeps({
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["apt-all-packages", "slot-sync"],
			}),
		});
		const details = await readUpdateDetails(deps);
		expect(details.slots).toEqual([
			{
				name: "rootfs.0",
				bootname: "A",
				state: "booted",
				bootStatus: "good",
				version: "2026.9.0",
				lastSyncedAt: null,
			},
		]);
	});

	test("an unreadable source degrades only its own block", async () => {
		const { deps } = detailsDeps({
			loadCapabilities: async () => ({
				mode: "capable",
				features: ["slot-sync"],
			}),
			readSlots: async () => {
				throw new Error("rauc status failed");
			},
			readBootedVersion: async () => {
				throw new Error("unreadable");
			},
		});
		const details = await readUpdateDetails(deps);
		expect(details.slots).toBeNull();
		expect(details.os.bootedVersion).toBeNull();
		expect(details.checks.packages).toEqual({
			lastAttemptAt: null,
			lastSuccessAt: null,
			nextAttemptAt: null,
		});
	});

	test("a staged image is reported only while a staged phase is current", async () => {
		const idle = detailsDeps();
		expect((await readUpdateDetails(idle.deps)).os.staged).toBeNull();
		expect(idle.calls.receipt).toBe(0);

		const armed = detailsDeps({}, { phase: "os-activation-armed" });
		expect((await readUpdateDetails(armed.deps)).os.staged).toEqual({
			version: "2026.10.0",
			stagedAt: 77,
		});
	});

	test("check clocks, candidate and pending approval pass through", async () => {
		const { deps } = detailsDeps(
			{
				osSummary: () => ({
					candidate: { version: "2026.10.0", sizeBytes: 900 },
					pendingCellular: { id: "2026.10.0", sizeBytes: 900 },
				}),
			},
			{
				packageCheck: {
					lastAttemptAt: 10,
					lastSuccessAt: 10,
					consecutiveFailures: 0,
					lastFailureWasRateLimited: false,
					nextAttemptAt: 20,
				},
			},
		);
		const details = await readUpdateDetails(deps);
		expect(details.checks.packages).toEqual({
			lastAttemptAt: 10,
			lastSuccessAt: 10,
			nextAttemptAt: 20,
		});
		expect(details.os.candidate).toEqual({
			version: "2026.10.0",
			sizeBytes: 900,
		});
		expect(details.pendingCellular).toEqual({
			id: "2026.10.0",
			sizeBytes: 900,
		});
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
