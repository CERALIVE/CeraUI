import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettingsSchema } from "@ceraui/rpc/schemas";
import * as storedState from "../modules/system/update-orchestrator/stored-state-file.ts";
import {
	loadUpdateSettings,
	saveUpdateSettings,
} from "../modules/system/update-settings.ts";

describe("update settings migration concurrency", () => {
	test.each([1, 2])(
		"keeps an explicit save after %s first-time loaders observe no sidecar",
		async (readers) => {
			const dir = mkdtempSync(join(tmpdir(), "ceraui-settings-race-"));
			const file = join(dir, "update-settings.json");
			const sidecar = join(dir, "update-image-channel.json");
			writeFileSync(
				file,
				JSON.stringify(updateSettingsSchema.parse({ channel: "stable" })),
			);
			const firstObserved = Promise.withResolvers<void>();
			const observed = Promise.withResolvers<void>();
			const first = Promise.withResolvers<void>();
			const second = Promise.withResolvers<void>();
			const read = storedState.readStoredStateFile;
			let absentReads = 0;
			const pausedRead = spyOn(
				storedState,
				"readStoredStateFile",
			).mockImplementation(async (path, limit) => {
				const raw = await read(path, limit);
				if (path === sidecar && raw === null) {
					absentReads++;
					if (absentReads === 1) firstObserved.resolve();
					if (absentReads === readers) observed.resolve();
					await (absentReads === 1 ? first : second).promise;
				}
				return raw;
			});
			const loading = [loadUpdateSettings(file)];
			try {
				await firstObserved.promise;
				if (readers === 2) loading.push(loadUpdateSettings(file));
				await observed.promise;
				if (readers === 2) {
					// One migration finishes while the other still holds its stale read.
					first.resolve();
					await loading[0];
				}
				const selected = updateSettingsSchema.parse({
					packagesAuto: false,
					systemAuto: false,
					channel: "stable",
					allowSystemOverCellular: false,
				});
				expect(saveUpdateSettings(selected, file)).toEqual(selected);
				first.resolve();
				second.resolve();
				expect(await loading[readers - 1]).toEqual(selected);
				expect(await loadUpdateSettings(file)).toEqual(selected);
				expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(selected);
				expect(JSON.parse(readFileSync(sidecar, "utf8")).channel).toBe(
					"stable",
				);
			} finally {
				first.resolve();
				second.resolve();
				await Promise.all(loading);
				pausedRead.mockRestore();
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
