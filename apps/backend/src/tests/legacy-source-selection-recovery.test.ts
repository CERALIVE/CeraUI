import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type ListDevicesResult,
	listDevicesResultSchema,
} from "@ceralive/cerastream";
import { CONFIG_CHANGE_REASON_REJECTED } from "@ceraui/rpc/schemas";
import { reconcileInflightConfigChange } from "../modules/streaming/config-change-persistence.ts";
import {
	defaultStagingDeps,
	readInflightMarker,
	releaseStagedConfigChange,
} from "../modules/streaming/config-change-staging.ts";
import {
	configuredSelectionAnchor,
	getSourceSelectionTokens,
	reconcileConfiguredSourceIdentity,
	resolveSourceRouting,
	tryRefreshEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import type { EngineConfigChangeOutcome } from "../modules/streaming/stream-session-orchestrator.ts";
import {
	SECOND_CAMERA,
	SECOND_STABLE,
	sourceSelectionFixture,
} from "./helpers/applied-source-selection.ts";
import { OSMO_STABLE, osmo } from "./helpers/dual-mode-camera.ts";

async function pendingSelection(sameId: boolean, legacy: boolean) {
	const f = await sourceSelectionFixture();
	// Keep mode unchanged so missing identity is the only unmeasured selection axis.
	await f.write({ input_mode: "uvc_h264" });
	if (sameId)
		f.devices.splice(0, 2, osmo("video3"), {
			...SECOND_CAMERA,
			input_id: "video1",
			device_path: "/dev/video1",
		});
	// Distinguishable geometry still cannot identify a reused node's intended camera.
	if (sameId) await f.write({ resolution: "1080p" });
	await f.start();
	const asked = Promise.withResolvers<void>();
	const answer = Promise.withResolvers<EngineConfigChangeOutcome>();
	f.setChange(() => {
		asked.resolve();
		return answer.promise;
	});
	const destination = sameId ? "video1" : "video2";
	const request = f.write({
		source: destination,
		input_mode: "uvc_h264",
		...(sameId ? { resolution: "720p" as const } : {}),
		apply_now: true,
	});
	await asked.promise;
	const marker = readInflightMarker();
	if (marker === undefined)
		throw new Error("RPC did not stage a source marker");
	if (legacy) {
		// The previous production shape retained routing, but captured no anchor.
		delete marker.candidate.source_stable_id;
		delete marker.previous.source_stable_id;
		await writeFile(defaultStagingDeps.markerPath, JSON.stringify(marker));
	}
	releaseStagedConfigChange();
	return {
		...f,
		destination,
		finish: async () => {
			answer.resolve({
				phase: "reverted",
				reason: CONFIG_CHANGE_REASON_REJECTED,
			});
			await request;
		},
	};
}

for (const sameId of [false, true]) {
	for (const streaming of [true, false]) {
		test(`legacy source recovery with ${sameId ? "the same label on new hardware" : "a different label"} and ${streaming ? "live" : "stopped"} engine preserves the accepted selection`, async () => {
			const f = await pendingSelection(sameId, true);
			const bytesBefore = await readFile(join(f.dir, "config.json"), "utf8");
			const markerBefore = await f.marker();
			const tokenBefore = getSourceSelectionTokens().selection;
			const probe = Promise.withResolvers<ListDevicesResult>();
			const refresh = tryRefreshEngineDeviceCache({
				fetchEngineDevices: () => probe.promise,
			});
			try {
				const verdict = reconcileInflightConfigChange({
					streaming,
					activeInput: f.destination,
					...(sameId ? { resolution: "720p" } : {}),
					pipelinePlaying: true,
					framesEmitted: 50,
				});
				const saved = await f.read();
				const bytesAfterRecovery = await readFile(
					join(f.dir, "config.json"),
					"utf8",
				);
				const routed = resolveSourceRouting(
					saved.source ?? "",
					f.sources(),
					saved.last_seen_devices,
					configuredSelectionAnchor(saved.source ?? ""),
				);
				probe.resolve(listDevicesResultSchema.parse({ devices: f.devices }));
				await refresh;

				// Read every consequence before asserting, including the real saved-config route.
				expect({
					verdict,
					source: saved.source,
					selected: saved.selected_video_input,
					anchor: saved.source_stable_id,
					tokens: getSourceSelectionTokens(),
					routed,
					marker: readInflightMarker() !== undefined,
					bytes: bytesAfterRecovery,
				}).toEqual({
					verdict: streaming ? "deferred" : "retained_previous",
					source: "video1",
					selected: "video1",
					anchor: OSMO_STABLE,
					tokens: { selection: tokenBefore, engineView: tokenBefore },
					routed: {
						ok: true,
						pipeline: "libuvch264",
						selected_video_input: sameId ? "video3" : "video1",
					},
					marker: streaming,
					bytes: bytesBefore,
				});
				if (streaming) expect(await f.marker()).toBe(markerBefore);
			} finally {
				probe.resolve(listDevicesResultSchema.parse({ devices: f.devices }));
				await refresh;
				await f.finish();
			}
		});
	}
}

test("current-format recovered source selection advances its token and fences an older probe", async () => {
	const f = await pendingSelection(false, false);
	const tokenBefore = getSourceSelectionTokens().selection;
	const probe = Promise.withResolvers<ListDevicesResult>();
	const refresh = tryRefreshEngineDeviceCache({
		fetchEngineDevices: () => probe.promise,
	});
	try {
		const verdict = reconcileInflightConfigChange({
			streaming: true,
			activeInput: "video2",
			pipelinePlaying: true,
			framesEmitted: 50,
		});
		probe.resolve(listDevicesResultSchema.parse({ devices: f.devices }));
		await refresh;
		const saved = await f.read();

		expect(verdict).toBe("persisted_candidate");
		expect(saved).toMatchObject({
			source: "video2",
			selected_video_input: "video2",
			source_stable_id: SECOND_STABLE,
		});
		expect(getSourceSelectionTokens()).toEqual({
			selection: tokenBefore + 1,
			engineView: tokenBefore,
		});
		expect(reconcileConfiguredSourceIdentity(f.sources())).toBe(false);
		expect(
			resolveSourceRouting(
				"video2",
				f.sources(),
				saved.last_seen_devices,
				configuredSelectionAnchor("video2"),
			),
		).toEqual({
			ok: true,
			pipeline: "libuvch264",
			selected_video_input: "video2",
		});
		expect(readInflightMarker()).toBeUndefined();
	} finally {
		probe.resolve(listDevicesResultSchema.parse({ devices: f.devices }));
		await refresh;
		await f.finish();
	}
});
