import { expect, spyOn, test } from "bun:test";
import {
	mkdtemp,
	readFile,
	readlink,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as updates from "../modules/system/software-updates.ts";
import {
	readUpdateCapabilities,
	setUpdateCapabilityPathForTest,
} from "../modules/system/update-capabilities.ts";
import * as storage from "../modules/system/update-orchestrator/stored-state-file.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import {
	validCapabilities as valid,
	capabilityVariants as variants,
} from "./helpers/capability-authority-inputs.ts";
import { updateHarness } from "./software-updates-preflight-harness.ts";

useSessionOwnerForFile();

for (const action of ["discovery", "install", "refresh"] as const) {
	test.each(variants)(
		`${action} refuses %s authority with zero package effects`,
		async (kind, bytes) => {
			// Given a previously discovered nonempty legacy install set, then ambiguous image authority.
			const root = await mkdtemp(join(tmpdir(), "capability-ambiguity-"));
			const path = join(root, "capabilities.json");
			setUpdateCapabilityPathForTest(path);
			try {
				await using h = await updateHarness();
				await writeFile(path, bytes);
				if (kind === "ELOOP") {
					await rm(path);
					await symlink("capabilities.json", path);
				}
				const original = storage.readStoredStateJson;
				using reader = spyOn(storage, "readStoredStateJson").mockImplementation(
					async (file, limit) => {
						if (file === path && (kind === "EIO" || kind === "EACCES"))
							throw Object.assign(new Error("fixture read failure"), {
								code: kind,
							});
						return original(file, limit);
					},
				);
				let discoveryEffects = 0;
				let networkEffects = 0;
				updates.setAptReachabilityProbeForTest(async () => {
					networkEffects++;
					return {
						ipv4: "ok",
						ipv6: "ok",
						used: "any",
						verdict: "any",
						detail: [],
					};
				});
				const settled = Promise.withResolvers<void>();
				h.onFrame = (frame) => {
					if (frame.update_state?.kind === "check_failed") settled.resolve();
				};
				updates.setAptCommandRunnerForTest(async () => {
					discoveryEffects++;
					return {
						exitCode: 1,
						stdout:
							"The following packages will be upgraded:\n  cerastream\n1 upgraded, 0 newly installed, 0 to remove.\nNeed to get 4 kB of archives.\n",
						stderr: "",
					};
				});
				try {
					// When the real discovery or admitted manual-install continuation runs.
					if (action === "discovery")
						await updates.runUpdateDiscoveryAndReport();
					else if (action === "install") {
						expect(updates.startSoftwareUpdate()).toEqual({ started: true });
						await h.check();
					} else {
						updates.resetSoftwareUpdateCheckRunner();
						updates.setSoftwareUpdateSizeRunner(async () => {
							settled.resolve();
							return null;
						});
						expect(updates.triggerManualUpdateCheck()).toBe(true);
						await settled.promise;
					}
					// Then unknown is not legacy permission, success, pre-clean or planned shutdown.
					expect(discoveryEffects).toBe(0);
					expect(networkEffects).toBe(0);
					expect(h.commands).toHaveLength(0);
					expect(h.launches).toHaveLength(0);
					expect(updates.getUpdateState()).toMatchObject({
						kind: action === "install" ? "failed" : "check_failed",
						reason: "discovery_failed",
					});
					expect(await h.marker()).toBe(h.markerBefore);
					if (kind !== "ELOOP")
						expect(await readFile(path)).toEqual(Buffer.from(bytes));
					else expect(await readlink(path)).toBe("capabilities.json");
				} finally {
					updates.setAptCommandRunnerForTest(null);
					updates.resetSoftwareUpdateSizeRunner();
					reader.mockRestore();
					await rm(path);
				}
			} finally {
				setUpdateCapabilityPathForTest(null);
				await rm(root, { recursive: true, force: true });
			}
		},
	);
}

test.each(["absent", "valid"])(
	"%s capability control still discovers and submits a legacy install",
	async (kind) => {
		// Given positive legacy authority (or genuine old-image absence).
		const root = await mkdtemp(join(tmpdir(), "capability-control-"));
		const path = join(root, "capabilities.json");
		setUpdateCapabilityPathForTest(path);
		try {
			if (kind === "valid") await writeFile(path, valid);
			await using h = await updateHarness();
			// When the admitted installer completes its preflight.
			expect(await readUpdateCapabilities(path)).toEqual({
				mode: "legacy",
				features: [],
			});
			expect(updates.startSoftwareUpdate()).toEqual({ started: true });
			await h.check();
			// Then legacy behavior was not removed by the unknown-evidence fence.
			expect(h.launches).toHaveLength(1);
		} finally {
			setUpdateCapabilityPathForTest(null);
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("a valid later capability read recovers without rewriting ambiguous evidence", async () => {
	// Given an invalid read, followed by an independent repair of the same authority.
	const root = await mkdtemp(join(tmpdir(), "capability-repair-"));
	const path = join(root, "capabilities.json");
	try {
		await writeFile(path, "{");
		await expect(readUpdateCapabilities(path)).rejects.toMatchObject({
			reason: "discovery_failed",
		});
		expect(await readFile(path, "utf8")).toBe("{");
		await writeFile(path, valid);
		// When retried, then the repaired bytes are authoritative, not a cached default/refusal.
		expect(await readUpdateCapabilities(path)).toEqual({
			mode: "legacy",
			features: [],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.each(["discovery", "install"])(
	"%s re-reads regime after awaited network preparation",
	async (action) => {
		// Given a nonempty legacy offer and capability authority that changes during the network await.
		const root = await mkdtemp(join(tmpdir(), "capability-late-read-"));
		const path = join(root, "capabilities.json");
		setUpdateCapabilityPathForTest(path);
		try {
			await using h = await updateHarness();
			updates.setAptReachabilityProbeForTest(async () => {
				await writeFile(path, "{");
				return {
					ipv4: "ok",
					ipv6: "ok",
					used: "any",
					verdict: "any",
					detail: [],
				};
			});
			let effects = 0;
			updates.setAptCommandRunnerForTest(async () => {
				effects++;
				return {
					exitCode: 1,
					stdout:
						"The following packages will be upgraded:\n  cerastream\n1 upgraded, 0 newly installed, 0 to remove.\nNeed to get 4 kB of archives.\n",
					stderr: "",
				};
			});
			try {
				// When the real continuation resumes after that awaited boundary.
				if (action === "discovery") await updates.runUpdateDiscoveryAndReport();
				else {
					expect(updates.startSoftwareUpdate()).toEqual({ started: true });
					await h.check();
				}
				// Then earlier valid evidence cannot grant work through a later failed read.
				expect(effects).toBe(0);
				expect(h.commands).toHaveLength(0);
				expect(h.launches).toHaveLength(0);
				expect(await readFile(path, "utf8")).toBe("{");
			} finally {
				updates.setAptCommandRunnerForTest(null);
				await rm(path);
			}
		} finally {
			setUpdateCapabilityPathForTest(null);
			await rm(root, { recursive: true, force: true });
		}
	},
);
