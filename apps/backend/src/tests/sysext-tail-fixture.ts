import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AddonState } from "@ceraui/rpc/schemas";
import { setAddonManagerDeps } from "../modules/addons/manager.ts";
import type { ReconcilerDeps } from "../modules/addons/reconciler.ts";
import { getAddons, setAddonState } from "../modules/config.ts";
import { sysextDescriptor, sysextFixture } from "./sysext-action-fixture.ts";

export function heldBoundary() {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		entered: entered.promise,
		release: () => released.resolve(),
		wait: async () => {
			entered.resolve();
			await released.promise;
		},
	};
}

export function sysextTailFixture() {
	const fixture = sysextFixture();
	const root = dirname(fixture.path);
	const scan = join(root, "scan");
	const raw = join(scan, "cog-display.raw");
	const prepared = join(root, "prepared.raw");
	const cached = join(root, "cached.raw");
	const frames: AddonState[] = [];
	const refreshes: string[] = [];
	const filePath = (path: string) =>
		path.startsWith("/data/extensions/")
			? raw
			: path.startsWith("/var/cache/")
				? cached
				: prepared;
	setAddonManagerDeps({
		isRealDevice: async () => true,
		getEffectiveHardware: () => "rk3588",
		getDataFreeBytes: async () => 2 ** 32,
		getOsVersion: async () => "13",
		download: async () => {
			await Bun.write(prepared, "replacement-payload");
		},
		verify: async () => undefined,
		stage: async (tmp, dest) => {
			await mkdir(scan, { recursive: true });
			await rename(filePath(tmp), filePath(dest));
		},
		helperEnable: async () => undefined,
		helperDisable: async () => undefined,
		systemctl: async () => ({ stdout: "", stderr: "" }),
		removeArtifact: async (path) => rm(filePath(path), { force: true }),
		broadcast: (_id, state) => frames.push(structuredClone(state)),
	});
	const reconciler: ReconcilerDeps = {
		isRealDevice: async () => true,
		getIsStreaming: () => false,
		getOsVersionId: async () => "13",
		getBoard: () => "rk3588",
		getAddons,
		readDescriptor: async () => sysextDescriptor,
		rawExists: async () => Bun.file(raw).exists(),
		fetchAndStage: async () => {
			await mkdir(scan, { recursive: true });
			await Bun.write(raw, "reconciler-payload");
		},
		refresh: async () => {
			refreshes.push("refresh");
		},
		setState: (id, state) => {
			setAddonState(id, state);
			frames.push(structuredClone(state));
		},
		log: () => undefined,
	};
	return {
		...fixture,
		root,
		scan,
		raw,
		prepared,
		cached,
		frames,
		refreshes,
		reconciler,
		readRaw: () => readFile(raw, "utf8"),
	};
}
