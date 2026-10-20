import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { addonEnable } from "../helpers/addon-helper.ts";
import { publishPreparedArtifact } from "../modules/addons/artifact-publication.ts";
import {
	disableAddon,
	enableAddon,
	getAddonPhase,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import { getAddons, removeAddonState } from "../modules/config.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { sysextDescriptor } from "./sysext-action-fixture.ts";
import { sysextTailFixture } from "./sysext-tail-fixture.ts";

let f: ReturnType<typeof sysextTailFixture>;
beforeEach(() => {
	f = sysextTailFixture();
});
afterEach(() => f.reset());

for (const action of ["enable", "disable"] as const) {
	test(`late refusal publishes a terminal add-on frame (${action})`, async () => {
		// Given active prior intent and streaming beginning in an awaited boundary.
		const bytes = await Bun.file(f.path).bytes();
		setAddonManagerDeps({
			isRealDevice: async () => true,
			getDataFreeBytes: async () => 2 ** 32,
			getOsVersion: async () => "13",
			download: async () => {},
			verify: async () => {
				updateStatus(true);
			},
			systemctl: async () => {
				updateStatus(true);
				return { stdout: "", stderr: "" };
			},
			removeArtifact: async () => {},
			broadcast: (_id, state) => {
				f.frames.push(structuredClone(state));
			},
		});
		// When the real manager settles its refused transition.
		const result = await (action === "enable" ? enableAddon : disableAddon)(
			sysextDescriptor,
		);
		// Then projection, live state and persisted bytes agree on the prior terminal state.
		expect(result).toEqual({ success: false, error: "streaming" });
		expect(f.frames.map((state) => state.phase)).toEqual([
			action === "enable" ? "installing" : "disabling",
			"active",
		]);
		expect(getAddonPhase("cog-display")).toBe("enabled");
		expect(await Bun.file(f.path).bytes()).toEqual(bytes);
	});
}

for (const replacement of [false, true]) {
	test(
		replacement
			? "refused reinstall leaves the prior payload byte-identical"
			: "refused new install leaves no discoverable raw",
		async () => {
			// Given physical private scan files, not a stage spy hiding rename semantics.
			await mkdir(f.scan, { recursive: true });
			if (replacement) await Bun.write(f.raw, "prior-payload");
			else removeAddonState("cog-display");
			const before = await Bun.file(f.path).bytes();
			setAddonManagerDeps({
				isRealDevice: async () => true,
				getDataFreeBytes: async () => 2 ** 32,
				getOsVersion: async () => "13",
				download: async () => {
					await Bun.write(f.prepared, "replacement-payload");
				},
				verify: async () => {},
				stage: async (_tmp, dest) => {
					const target = dest.startsWith("/data/extensions/")
						? f.raw
						: f.cached;
					const previous = (await Bun.file(target).exists())
						? await readFile(target)
						: undefined;
					await rename(f.prepared, target);
					updateStatus(true);
					return {
						commit: async () => {},
						rollback: async () => {
							if (previous) await Bun.write(target, previous);
							else await rm(target, { force: true });
						},
					};
				},
				helperEnable: async () => {
					f.refreshes.push("enable");
				},
				removeArtifact: async () => {
					await rm(f.prepared, { force: true });
				},
				broadcast: (_id, state) => {
					f.frames.push(structuredClone(state));
				},
			});
			// When admission is lost before helper submission.
			expect(await enableAddon(sysextDescriptor)).toEqual({
				success: false,
				error: "streaming",
			});
			// Then refused prepared bytes cannot be discovered by a later global refresh.
			expect(f.refreshes).toEqual([]);
			if (replacement) expect(await f.readRaw()).toBe("prior-payload");
			else expect(await Bun.file(f.raw).exists()).toBe(false);
			expect(await Bun.file(f.path).bytes()).toEqual(before);
			expect(f.frames.at(-1)?.phase).toBe(replacement ? "active" : "idle");
			expect(getAddons()["cog-display"]?.phase).toBe(
				replacement ? "active" : undefined,
			);
		},
	);
}

test("a refused helper after device detection restores the scan payload", async () => {
	// Given a real helper wrapper whose detection await loses idle.
	await mkdir(f.scan, { recursive: true });
	await Bun.write(f.raw, "prior-payload");
	setAddonManagerDeps({
		isRealDevice: async () => true,
		getDataFreeBytes: async () => 2 ** 32,
		getOsVersion: async () => "13",
		download: async () => {
			await Bun.write(f.prepared, "replacement-payload");
		},
		verify: async () => {},
		stage: async (_tmp, dest) => {
			const target = dest.startsWith("/data/extensions/") ? f.raw : f.cached;
			await rename(f.prepared, target);
			return {
				commit: async () => {},
				rollback: async () => {
					await rm(target, { force: true });
				},
			};
		},
		helperEnable: async (id) => {
			await addonEnable(id, {
				readDescriptor: async () => sysextDescriptor,
				isRealDevice: async () => {
					updateStatus(true);
					return true;
				},
				exec: async () => {
					f.refreshes.push("enable");
					return { stdout: "{}", stderr: "" };
				},
			});
		},
		removeArtifact: async () => {},
		broadcast: (_id, state) => {
			f.frames.push(structuredClone(state));
		},
	});
	// When final privileged admission refuses.
	expect(await enableAddon(sysextDescriptor)).toEqual({
		success: false,
		error: "streaming",
	});
	// Then no refresh and no replacement bytes remain.
	expect(f.refreshes).toEqual([]);
	expect(await f.readRaw()).toBe("prior-payload");
	expect(f.frames.at(-1)?.phase).toBe("active");
});

test("prepared bytes are not scan-visible during final helper admission", async () => {
	// Given a new add-on and physical stage semantics redirected into private paths.
	removeAddonState("cog-display");
	let scanVisible: boolean | undefined;
	setAddonManagerDeps({
		isRealDevice: async () => true,
		getDataFreeBytes: async () => 2 ** 32,
		getOsVersion: async () => "13",
		download: async () => {
			await Bun.write(f.prepared, "replacement-payload");
		},
		verify: async () => undefined,
		stage: (_tmp, dest) =>
			publishPreparedArtifact(
				f.prepared,
				dest.startsWith("/data/extensions/") ? f.raw : f.cached,
			),
		helperEnable: async (id) => {
			await addonEnable(id, {
				readDescriptor: async () => sysextDescriptor,
				isRealDevice: async () => {
					scanVisible = await Bun.file(f.raw).exists();
					updateStatus(true);
					return true;
				},
				exec: async () => ({ stdout: "{}", stderr: "" }),
			});
		},
		removeArtifact: async () => {
			await rm(f.prepared, { force: true });
		},
		broadcast: (_id, state) => {
			f.frames.push(structuredClone(state));
		},
	});
	// When the real helper is still waiting for final device/admission evidence.
	expect(await enableAddon(sysextDescriptor)).toEqual({
		success: false,
		error: "streaming",
	});
	// Then even before rollback no prepared raw was discoverable.
	expect(scanVisible).toBe(false);
	expect(await Bun.file(f.raw).exists()).toBe(false);
});
