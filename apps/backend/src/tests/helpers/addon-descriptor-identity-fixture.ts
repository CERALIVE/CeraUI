import { spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddonDescriptor } from "@ceraui/rpc/schemas";
import { logger } from "../../helpers/logger.ts";
import { publishPreparedArtifact } from "../../modules/addons/artifact-publication.ts";
import { readAddonDescriptor } from "../../modules/addons/descriptor-authority.ts";
import { setSysextEvidenceForTest } from "../../modules/addons/disruptive-sysext-step.ts";
import {
	initAddonManager,
	resetAddonManagerDeps,
	setAddonManagerDeps,
} from "../../modules/addons/manager.ts";
import type { ReconcilerDeps } from "../../modules/addons/reconciler.ts";
import {
	getAddons,
	getConfig,
	getConfigFilePath,
	saveConfig,
	setAddonState,
	setConfigFilePath,
} from "../../modules/config.ts";
import { updateStreamLifecycleState } from "../../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../../modules/streaming/streaming.ts";
import { resetDisruptiveActionReservationForTest } from "../../modules/system/disruptive-action-reservation.ts";
import { setStreamReconciliationCompletedForTest } from "../../modules/system/stream-reconciliation-latch.ts";
import { resetOrchestratorRuntimeForTest } from "../../modules/system/update-orchestrator/runtime.ts";
import {
	resetAddonProcedureDeps,
	setAddonProcedureDeps,
} from "../../rpc/procedures/addons.procedure.ts";

export function identityDescriptor(id: string): AddonDescriptor {
	return {
		id,
		name: id,
		version: "1.2.3",
		category: "debug",
		payload: { type: "sysext" },
		sysextLevel: "1",
		versionId: "13",
		artifact: {
			urlTemplate: `https://apt.ceralive.tv/addons/${id}/{os_version}/payload.raw`,
			gpgSigRef: `https://apt.ceralive.tv/addons/${id}/{os_version}/payload.raw.sig`,
			sha256: "a".repeat(64),
			sizeDownload: 1024,
			sizeInstalled: 4096,
		},
		provides: [`/usr/bin/${id}`],
	};
}

export function addonDescriptorIdentityFixture() {
	const root = fs.mkdtempSync(join(tmpdir(), "addon-identity-"));
	const registry = join(root, "usr/share/ceralive/addons");
	fs.mkdirSync(registry, { recursive: true });
	const previousPath = getConfigFilePath();
	const previousAddons = getConfig().addons;
	const previousMarker = process.env.CERALIVE_STREAMING_MARKER;
	process.env.CERALIVE_STREAMING_MARKER = join(root, "streaming");
	setConfigFilePath(join(root, "config.json"));
	getConfig().addons = {};
	saveConfig();
	resetOrchestratorRuntimeForTest();
	resetDisruptiveActionReservationForTest();
	setSysextEvidenceForTest({ probe: async () => "completed" });
	updateStatus(false);
	updateStreamLifecycleState("idle");
	setStreamReconciliationCompletedForTest(true);
	initAddonManager();
	const effects: string[] = [];
	const logs: string[] = [];
	const restores: (() => void)[] = [];
	setAddonManagerDeps({
		isRealDevice: async () => true,
		getEffectiveHardware: () => "rk3588",
		getDataFreeBytes: async () => 2 ** 32,
		getOsVersion: async () => "13",
		download: async (_url, path) => {
			effects.push(`download:${path}`);
		},
		verify: async () => {
			effects.push("verify");
		},
		stage: async (_tmp, dest) => {
			effects.push(`stage:${dest}`);
		},
		helperEnable: async (id) => {
			effects.push(`enable:${id}`);
		},
		helperDisable: async (id) => {
			effects.push(`disable:${id}`);
		},
		systemctl: async (args) => {
			effects.push(args.join(" "));
			return { stdout: "", stderr: "" };
		},
		removeArtifact: async (path) => {
			effects.push(`remove:${path}`);
		},
		broadcast: () => undefined,
	});
	setAddonProcedureDeps({
		isRealDevice: async () => true,
		getEffectiveHardware: () => "rk3588",
	});
	const deps: ReconcilerDeps = {
		isRealDevice: async () => true,
		getIsStreaming: () => false,
		getOsVersionId: async () => "13",
		getBoard: () => "rk3588",
		getAddons,
		readDescriptor: (id) => readAddonDescriptor(join(registry, `${id}.json`)),
		rawExists: (id) => Bun.file(join(root, `${id}.raw`)).exists(),
		fetchAndStage: async ({ descriptor }) => {
			effects.push(`fetch:${descriptor.id}`);
			await Bun.write(join(root, `${descriptor.id}.prepared`), "payload");
		},
		publishPrepared: async ({ descriptor }) => {
			effects.push(`publish:${descriptor.id}`);
			return publishPreparedArtifact(
				join(root, `${descriptor.id}.prepared`),
				join(root, `${descriptor.id}.raw`),
			);
		},
		refresh: async () => {
			effects.push("refresh");
		},
		setState: setAddonState,
		log: (message) => {
			logs.push(message);
		},
	};
	return {
		root,
		registry,
		effects,
		logs,
		deps,
		writeDescriptor: (slot: string, descriptor: AddonDescriptor) =>
			Bun.write(join(registry, `${slot}.json`), JSON.stringify(descriptor)),
		// Redirect only the default scanner's filesystem ports, keeping its real
		// enumeration, anchored strict reads, parsing and invalid-slot handling.
		bindDefaultScan: () => {
			const open = fs.openSync;
			const list = fsp.readdir;
			const anchored = spyOn(fs, "openSync").mockImplementation(
				(path, flags, mode) => open(path === "/" ? root : path, flags, mode),
			);
			const directory = spyOn(fsp, "readdir").mockImplementation(
				new Proxy(list, {
					apply(target, receiver, args) {
						return Reflect.apply(
							target,
							receiver,
							args[0] === "/usr/share/ceralive/addons"
								? [registry, ...args.slice(1)]
								: args,
						);
					},
				}),
			);
			const errors = spyOn(logger, "error").mockImplementation((message) => {
				logs.push(String(message));
				return logger;
			});
			restores.push(
				() => anchored.mockRestore(),
				() => directory.mockRestore(),
				() => errors.mockRestore(),
			);
		},
		reset: () => {
			for (const restore of restores) restore();
			resetAddonProcedureDeps();
			resetAddonManagerDeps();
			resetOrchestratorRuntimeForTest();
			resetDisruptiveActionReservationForTest();
			setSysextEvidenceForTest();
			getConfig().addons = previousAddons;
			setConfigFilePath(previousPath);
			if (previousMarker === undefined)
				delete process.env.CERALIVE_STREAMING_MARKER;
			else process.env.CERALIVE_STREAMING_MARKER = previousMarker;
			fs.rmSync(root, { recursive: true, force: true });
		},
	};
}
