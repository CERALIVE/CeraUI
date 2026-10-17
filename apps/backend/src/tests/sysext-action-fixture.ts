import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddonDescriptor } from "@ceraui/rpc/schemas";
import { setSysextEvidenceForTest } from "../modules/addons/disruptive-sysext-step.ts";
import {
	initAddonManager,
	resetAddonManagerDeps,
	setAddonManagerDeps,
} from "../modules/addons/manager.ts";
import {
	getConfig,
	getConfigFilePath,
	saveConfig,
	setAddonState,
	setConfigFilePath,
} from "../modules/config.ts";
import { updateStreamLifecycleState } from "../modules/streaming/stream-lifecycle-status.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { resetDisruptiveActionReservationForTest } from "../modules/system/disruptive-action-reservation.ts";
import {
	initKiosk,
	resetKioskDeps,
	setKioskDeps,
	stopKioskPolling,
} from "../modules/system/kiosk.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
import { setStreamReconciliationCompletedForTest } from "../modules/system/stream-reconciliation-latch.ts";
import { resetOrchestratorRuntimeForTest } from "../modules/system/update-orchestrator/runtime.ts";
import {
	resetAddonProcedureDeps,
	setAddonProcedureDeps,
} from "../rpc/procedures/addons.procedure.ts";

export const sysextDescriptor: AddonDescriptor = {
	id: "cog-display",
	name: "Display",
	version: "1.2.3",
	category: "display",
	payload: { type: "sysext" },
	sysextLevel: "1",
	versionId: "13",
	artifact: {
		urlTemplate:
			"https://apt.ceralive.tv/addons/cog-display/{os_version}/display.raw",
		gpgSigRef:
			"https://apt.ceralive.tv/addons/cog-display/{os_version}/display.raw.sig",
		sha256: "a".repeat(64),
		sizeDownload: 1024,
		sizeInstalled: 4096,
	},
	provides: ["/usr/bin/cog"],
	units: { unmask: ["kiosk.service"], start: ["kiosk.service"] },
};

export function sysextFixture() {
	const dir = mkdtempSync(join(tmpdir(), "sysext-action-"));
	const previousPath = getConfigFilePath();
	const savedEnv = {
		NODE_ENV: process.env.NODE_ENV,
		MOCK_MODE: process.env.MOCK_MODE,
		CERALIVE_STREAMING_MARKER: process.env.CERALIVE_STREAMING_MARKER,
		CERALIVE_DEVICE_TYPE: process.env.CERALIVE_DEVICE_TYPE,
	};
	process.env.NODE_ENV = "production";
	delete process.env.MOCK_MODE;
	process.env.CERALIVE_DEVICE_TYPE = "real";
	process.env.CERALIVE_STREAMING_MARKER = join(dir, "streaming");
	setConfigFilePath(join(dir, "config.json"));
	resetOrchestratorRuntimeForTest();
	resetBootReadiness();
	resetDisruptiveActionReservationForTest();
	// In-process fakes leave no helper, sysext or unit job behind them.
	setSysextEvidenceForTest({ probe: async () => "completed" });
	updateStatus(false);
	updateStreamLifecycleState("idle");
	setStreamReconciliationCompletedForTest(true);
	Object.assign(getConfig(), {
		addons: {
			"cog-display": {
				enabled: true,
				phase: "active",
				autoDisabled: false,
				versionMaterialized: "1.0.0",
				userConfig: { preserved: "old" },
			},
		},
		kiosk_enabled: false,
		kiosk_last_state: "disabled",
	});
	initAddonManager();
	initKiosk();
	saveConfig();
	const effects: string[] = [];
	setAddonManagerDeps({
		isRealDevice: async () => true,
		getEffectiveHardware: () => "rk3588",
		getDataFreeBytes: async () => 2 ** 32,
		getOsVersion: async () => "13",
		download: async () => {
			effects.push("download");
		},
		verify: async () => {
			effects.push("verify");
		},
		stage: async () => {
			effects.push("stage");
		},
		helperEnable: async () => {
			effects.push("helper-enable");
		},
		helperDisable: async () => {
			effects.push("helper-disable");
		},
		systemctl: async (args) => {
			effects.push(args.join(" "));
			return { stdout: "", stderr: "" };
		},
		removeArtifact: async () => {
			effects.push("remove-artifact");
		},
		broadcast: () => {
			effects.push("addon-broadcast");
		},
	});
	setAddonProcedureDeps({
		isRealDevice: async () => true,
		readDescriptors: async () => [sysextDescriptor],
		getEffectiveHardware: () => "rk3588",
		setAddonState: (id, state) => {
			effects.push("rpc-state-write");
			setAddonState(id, state);
		},
	});
	setKioskDeps({
		loadCogDescriptor: () => sysextDescriptor,
		isFailed: async () => false,
		isActive: async () => false,
		noDisplayMarkerExists: async () => false,
		removeNoDisplayMarker: async () => {
			effects.push("remove-marker");
		},
		broadcast: () => {
			effects.push("kiosk-broadcast");
		},
	});
	return {
		effects,
		path: getConfigFilePath(),
		reset: () => {
			stopKioskPolling();
			resetKioskDeps();
			resetAddonManagerDeps();
			resetAddonProcedureDeps();
			resetOrchestratorRuntimeForTest();
			resetBootReadiness();
			resetDisruptiveActionReservationForTest();
			setSysextEvidenceForTest();
			updateStatus(false);
			updateStreamLifecycleState("idle");
			setStreamReconciliationCompletedForTest(true);
			setConfigFilePath(previousPath);
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
