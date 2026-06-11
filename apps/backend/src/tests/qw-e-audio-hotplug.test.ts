import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	asrcProbe,
	clearAsrcProbeReject,
	updateAudioDevices,
} from "../modules/streaming/audio.ts";
import { createAudioDeviceWatcher } from "../modules/streaming/audio-watcher.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeCard(dir: string, card: string, id: string) {
	const cardDir = join(dir, card);
	fs.mkdirSync(cardDir, { recursive: true });
	fs.writeFileSync(join(cardDir, "id"), `${id}\n`);
}

describe("QW-E: audio device hotplug watcher", () => {
	describe("createAudioDeviceWatcher", () => {
		it("emits onChange after a simulated card dir appears under the watched path", async () => {
			const dir = mkdtempSync(join(tmpdir(), "asrc-hotplug-add-"));
			let calls = 0;
			const watcher = createAudioDeviceWatcher({
				dir,
				onChange: () => {
					calls++;
				},
				debounceMs: 50,
			});

			try {
				makeCard(dir, "card1", "usbaudio");
				// debounce window + filesystem-event slack
				await sleep(300);
				expect(calls).toBeGreaterThanOrEqual(1);
			} finally {
				watcher.stop();
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("debounce collapses a burst of events into a single onChange", async () => {
			const dir = mkdtempSync(join(tmpdir(), "asrc-hotplug-burst-"));
			let calls = 0;
			const watcher = createAudioDeviceWatcher({
				dir,
				onChange: () => {
					calls++;
				},
				debounceMs: 120,
			});

			try {
				// A single hotplug fires many inotify events; simulate that burst.
				for (let i = 0; i < 8; i++) {
					fs.writeFileSync(join(dir, `node${i}`), "x");
					await sleep(5);
				}
				await sleep(400);
				expect(calls).toBe(1);
			} finally {
				watcher.stop();
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("falls back to polling while streaming when fs.watch is unavailable", async () => {
			const dir = mkdtempSync(join(tmpdir(), "asrc-hotplug-poll-"));
			let calls = 0;
			let streaming = true;
			const watcher = createAudioDeviceWatcher({
				dir,
				onChange: () => {
					calls++;
				},
				pollIntervalMs: 40,
				isStreaming: () => streaming,
				watch: (() => {
					throw new Error("ENOSYS: inotify unavailable");
				}) as unknown as typeof fs.watch,
			});

			try {
				expect(watcher.isPolling()).toBe(true);
				await sleep(120);
				const whileStreaming = calls;
				expect(whileStreaming).toBeGreaterThanOrEqual(1);

				// Poll is gated on streaming state: it goes quiet once streaming stops.
				streaming = false;
				await sleep(120);
				expect(calls).toBe(whileStreaming);
			} finally {
				watcher.stop();
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("stop() halts the poll fallback", async () => {
			const dir = mkdtempSync(join(tmpdir(), "asrc-hotplug-stop-"));
			let calls = 0;
			const watcher = createAudioDeviceWatcher({
				dir,
				onChange: () => {
					calls++;
				},
				pollIntervalMs: 30,
				watch: (() => {
					throw new Error("no watch");
				}) as unknown as typeof fs.watch,
			});

			await sleep(80);
			watcher.stop();
			const afterStop = calls;
			await sleep(120);
			expect(calls).toBe(afterStop);
			rmSync(dir, { recursive: true, force: true });
		});
	});

	describe("QW-E ↔ QW-J interaction", () => {
		afterEach(() => {
			clearAsrcProbeReject();
		});

		it("device arrival during a pending probe lets stream start proceed (no timeout)", async () => {
			const dir = mkdtempSync(join(tmpdir(), "asrc-hotplug-probe-"));
			try {
				const probe = asrcProbe("hotplugcard");

				// Card was absent at probe start; it arrives mid-wait. The watcher's
				// re-enumeration repopulates the device map and wakes the probe.
				makeCard(dir, "card0", "hotplugcard");
				await updateAudioDevices(dir);

				const resolved = await probe;
				expect(resolved).toBe("hotplugcard");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	});
});
