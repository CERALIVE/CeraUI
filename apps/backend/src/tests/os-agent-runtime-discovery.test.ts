import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	clearUpdateNotice,
	notifyUpdate,
} from "../modules/system/update-orchestrator/notifications.ts";
import { checkOsChannel } from "../modules/system/update-orchestrator/os-agent.ts";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkOsManifestResult,
	checkUpdatesNow,
	getOrchestratorState,
	getOsUpdateSummary,
	resetOrchestratorRuntimeForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { getPersistentNotifications } from "../modules/ui/notifications.ts";
import * as websocket from "../modules/ui/websocket-server.ts";
import { candidate, setup } from "./helpers/os-agent-runtime-harness.ts";

afterEach(() => resetOrchestratorRuntimeForTest());

describe("trusted OS no-candidate discovery", () => {
	const checkTime = Date.parse("2026-10-01T12:00:00Z");

	const obsolete = [
		"os-check:downgrade_or_same",
		"os-check:serial_replayed",
	] as const;

	const unrelated = [
		"os-check:expired",
		"os:2026.10.0",
		"packages:serial_replayed",
	] as const;

	afterEach(() => {
		for (const id of [...obsolete, ...unrelated])
			clearUpdateNotice("refused", id);
	});

	function signedChannel(bootedVersion: string, serial: number) {
		return {
			data: new TextEncoder().encode(JSON.stringify(candidate)),
			signature: new Uint8Array([1]),
			context: {
				board: candidate.board,
				compatible: candidate.compatible,
				channel: candidate.channel,
				serial,
				bootedVersion,
				installedVersion: "2026.9.3",
				now: checkTime,
			},
			verification: {
				verifyCms: async () => ({
					cn: "CeraLive OTA Manifest Signer",
					eku: ["codeSigning"],
					issuer: "CN=CeraLive RAUC Intermediate CA,O=CeraLive",
				}),
				compare: async (left: string, right: string) =>
					Bun.spawnSync(["dpkg", "--compare-versions", left, "gt", right])
						.exitCode === 0,
				isQuarantined: async () => false,
			},
		};
	}

	test.each([
		["current", "2026.10.0", 2],
		["post-OTA current", "2026.10.0", 3],
		["current below watermark", "2026.10.0", 4],
		["superseded post-OTA", "2026.11.0", 3],
	] as const)(
		"succeeds without staging when the pointer is %s",
		async (_label, bootedVersion, serial) => {
			// Given prior failures and an authenticated current or superseded consumed pointer.
			const signed = signedChannel(bootedVersion, serial);
			const { stages } = setup({
				now: () => checkTime,
				random: () => 0.5,
				runPackageCheck: async () => null,
				getPackageInstallWireState: () => ({ kind: "idle" }),
				checkOsManifest: (channel) =>
					checkOsManifestResult(
						channel ?? "stable",
						(settingsChannel, quarantine) =>
							checkOsChannel(settingsChannel, quarantine, async () => signed),
					),
			});
			const initial = initialOrchestratorState(0);
			setOrchestratorStateForTest({
				...initial,
				failureReason: "serial_replayed",
				osCheck: {
					...initial.osCheck,
					consecutiveFailures: 6,
					lastSuccessAt: 1000,
				},
			});
			const noticesBefore = getPersistentNotifications(true);
			// When the operator checks through the agent and runtime classification path.
			await checkUpdatesNow();
			// Then the normal success schedule replaces failure backoff without an offer or notice.
			const state = getOrchestratorState();
			expect(state.phase).toBe("idle");
			expect(state.failureReason).toBeNull();
			expect(state.osCheck.consecutiveFailures).toBe(0);
			expect(state.osCheck.lastSuccessAt).toBe(checkTime);
			expect(state.osCheck.nextAttemptAt).toBe(checkTime + 12 * 60 * 60_000);
			expect(getOsUpdateSummary().candidate).toBeNull();
			expect(stages()).toBe(0);
			expect(getPersistentNotifications(true)).toEqual(noticesBefore);
		},
	);

	test("clears only stale OS equality and replay notices when discovery proves current", async () => {
		// Given obsolete check notices beside unrelated check, stage and package refusals.
		for (const id of [...obsolete, ...unrelated])
			notifyUpdate({ kind: "refused", id, reason: id });
		const broadcast = spyOn(websocket, "broadcastMsg");
		try {
			const signed = signedChannel(candidate.version, 3);
			// When current discovery maps to no candidate.
			const result = await checkOsChannel(
				"stable",
				new UpdateQuarantine(),
				async () => signed,
			);
			// Then targeted removal frames are published through the existing notification store.
			expect(result).toBeUndefined();
			expect(
				broadcast.mock.calls.map(([type, payload]) => ({ type, payload })),
			).toEqual(
				obsolete.map((id) => ({
					type: "notification",
					payload: {
						remove: [
							{ id: `update:refused:${id}`, revision: expect.any(Number) },
						],
					},
				})),
			);
			const names = getPersistentNotifications(true).show.map(
				(item) => item.name,
			);
			for (const id of obsolete)
				expect(names).not.toContain(`update:refused:${id}`);
			for (const id of unrelated)
				expect(names).toContain(`update:refused:${id}`);
		} finally {
			broadcast.mockRestore();
		}
	});

	test.each(["expired", "unsigned", "newer replay", "superseded"] as const)(
		"keeps stale notices when discovery is %s rather than trusted-current",
		async (condition) => {
			// Given old notices and a pointer that does not prove trusted-current freshness.
			for (const id of obsolete)
				notifyUpdate({ kind: "refused", id, reason: id });
			const signed = signedChannel(
				condition === "newer replay"
					? "2026.9.0"
					: condition === "superseded"
						? "2026.11.0"
						: candidate.version,
				3,
			);
			const input = {
				...signed,
				data:
					condition === "expired"
						? new TextEncoder().encode(
								JSON.stringify({
									...candidate,
									expires_at: "2026-09-24T00:00:00Z",
								}),
							)
						: signed.data,
				verification: {
					...signed.verification,
					verifyCms: async () => {
						if (condition === "unsigned") throw new Error("unsigned");
						return signed.verification.verifyCms();
					},
				},
			};
			const before = getPersistentNotifications(true);
			// When the agent classifies that pointer.
			const result = await checkOsManifestResult(
				"stable",
				(channel, quarantine) =>
					checkOsChannel(channel, quarantine, async () => input),
			);
			// Then no current-only clearance can hide a standing refusal.
			expect(result.failed).toBe(condition !== "superseded");
			expect(result.available).toBe(false);
			expect(getPersistentNotifications(true)).toEqual(before);
		},
	);
});
