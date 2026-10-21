import { expect, spyOn, test } from "bun:test";
import fs, * as fsPorts from "node:fs";
import * as fsAsync from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isRuntimeConfigAvailable,
	loadConfig,
	setConfigFilePath,
} from "../modules/config.ts";
import {
	awaitRuntimeConfig,
	bootRuntimeConfig,
	stopRuntimeConfigRecovery,
} from "../modules/config-boot.ts";

for (const preservationRetry of [false, true]) {
	for (const reloadFailures of [1, 4]) {
		test(`reset notice survives ${reloadFailures} post-write EIOs with preservation retry=${preservationRetry}`, async () => {
			// Given real damaged bytes and a writer-triggered fault only on subsequent strict reads.
			const root = fs.mkdtempSync(join(tmpdir(), "reset-notice-"));
			const path = join(root, "config.json");
			fs.writeFileSync(path, "{");
			setConfigFilePath(path);
			const notices: string[] = [];
			const waits: number[] = [];
			let writes = 0;
			let remaining = 0;
			let preservationFailed = false;
			const rename = fs.renameSync;
			const open = fsAsync.open;
			const unlink = fsPorts.unlinkSync;
			const writer = spyOn(fs, "renameSync").mockImplementation((from, to) => {
				rename(from, to);
				if (String(to) === path) {
					writes++;
					remaining = reloadFailures;
				}
			});
			const reader = spyOn(fsAsync, "open").mockImplementation(
				(...args: Parameters<typeof open>) => {
					if (String(args[0]).endsWith("/config.json") && remaining > 0) {
						remaining--;
						return Promise.reject(
							Object.assign(new Error("EIO strict reload"), { code: "EIO" }),
						);
					}
					return open(...args);
				},
			);
			const cleanup = spyOn(fsPorts, "unlinkSync").mockImplementation((p) => {
				if (
					preservationRetry &&
					String(p).endsWith(".tmp") &&
					!preservationFailed
				) {
					preservationFailed = true;
					throw Object.assign(new Error("EIO cleanup"), { code: "EIO" });
				}
				return unlink(p);
			});
			try {
				// When boot retries the failed reload (including the detached owner path).
				const outcome = await bootRuntimeConfig({
					sleep: async (ms) => {
						waits.push(ms);
					},
					onDamagedReset: (copy) => {
						notices.push(copy);
					},
				});
				if (outcome === "unavailable") await awaitRuntimeConfig();
				// Then the same archived identity is announced once, never zero or twice.
				expect(isRuntimeConfigAvailable()).toBe(true);
				expect(writes).toBe(1);
				expect(notices).toHaveLength(1);
				expect(fs.readFileSync(notices[0] ?? "missing", "utf8")).toBe("{");
				expect(fs.readFileSync(path, "utf8")).toBe("{}");
				expect(
					fs.readdirSync(root).filter((n) => n.includes(".damaged-")),
				).toHaveLength(1);
				expect(waits).toEqual(
					reloadFailures === 1
						? preservationRetry
							? [250, 1000]
							: [250]
						: preservationRetry
							? [250, 1000, 1000, 2000]
							: [250, 1000, 1000],
				);
			} finally {
				writer.mockRestore();
				reader.mockRestore();
				cleanup.mockRestore();
				stopRuntimeConfigRecovery();
				fs.writeFileSync(path, "{}");
				await loadConfig();
				setConfigFilePath("config.json");
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	}
}
