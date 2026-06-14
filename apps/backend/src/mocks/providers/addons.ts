/*
	CeraUI - Add-on Subsystem Mock Fixtures + Dependency Doubles

	Schema-valid fixtures and injectable dependency doubles for the add-on
	subsystem — the manager state machine (modules/addons/manager.ts) and the
	post-boot reconciler (modules/addons/reconciler.ts).

	- `MockAddonDescriptor` / `MockAddonState`: fixtures pinned with `satisfies`
	  against the REAL `@ceraui/rpc` types and re-validated against the real Zod
	  schemas (`AddonDescriptorSchema` / `AddonStateSchema`) at `initMockService`
	  time via mock-schemas.ts — the descriptor shape is NEVER duplicated here.
	- `createMockAddonManagerDeps()`: a fully-spying `AddonManagerDeps` surface —
	  fake helper, fake systemctl, fake fs/network — so `enableAddon` /
	  `disableAddon` / `pollAddonCrashLoop` run with NO real sudo, systemctl,
	  disk, or network. Mirrors the in-test harness from manager.test.ts.
	- `createMockReconcilerDeps()`: the same for `ReconcilerDeps`.

	Unlike the other provider modules these are NOT gated on `shouldUseMocks()`:
	they are explicit test doubles handed to the manager/reconciler via DI, not
	getters that stand in for a live subsystem in dev mode.
*/

import type {
	AddonConfig,
	AddonDescriptor,
	AddonState,
} from "@ceraui/rpc/schemas";

import type { ExecResult } from "../../helpers/exec.ts";
import type {
	AddonHardware,
	AddonManagerDeps,
} from "../../modules/addons/manager.ts";
import type {
	MaterialiseArgs,
	ReconcilerDeps,
} from "../../modules/addons/reconciler.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The single systemd unit `MockAddonDescriptor` references (test convenience). */
export const MOCK_ADDON_UNIT = "mock-addon.service";

/**
 * A fully-formed, schema-valid add-on descriptor. One sysext payload and a
 * single service across unmask/enable/start plus a trivial validation probe, so
 * the whole enable pipeline has something concrete to drive. Validated against
 * the real `AddonDescriptorSchema` at init (mock-schemas.ts).
 */
export const MockAddonDescriptor = {
	id: "mock-addon",
	name: "Mock Add-on",
	version: "1.2.3",
	category: "debug",
	payload: { type: "sysext" },
	sysextLevel: "1",
	versionId: "12",
	artifact: {
		urlTemplate:
			"https://apt.ceralive.tv/addons/mock-addon/{os_version}/mock-addon.raw",
		sha256: "a".repeat(64),
		gpgSigRef:
			"https://apt.ceralive.tv/addons/mock-addon/{os_version}/mock-addon.raw.sig",
		sizeDownload: 1024,
		sizeInstalled: 4096,
	},
	provides: ["/usr/bin/mock-addon"],
	units: {
		unmask: [MOCK_ADDON_UNIT],
		enable: [MOCK_ADDON_UNIT],
		start: [MOCK_ADDON_UNIT],
	},
	validate: { cmd: "test -x /usr/bin/mock-addon" },
} satisfies AddonDescriptor;

/**
 * A schema-valid, enabled + active runtime state for `MockAddonDescriptor`,
 * materialised for OS VERSION_ID "12". Validated against the real
 * `AddonStateSchema` at init.
 */
export const MockAddonState = {
	enabled: true,
	phase: "active",
	autoDisabled: false,
	versionMaterialized: "1.2.3",
	osVersionMaterialized: "12",
} satisfies AddonState;

// ─── manager dependency double ───────────────────────────────────────────────

/** Controllable inputs the manager reads through its injected deps. */
export type MockAddonManagerSignals = {
	isRealDevice: boolean;
	hardware: AddonHardware;
	freeBytes: number;
	osVersion: string;
	nRestarts: number;
	validateOk: boolean;
};

/** Every effectful call the manager makes, recorded for assertions. */
export type MockAddonManagerRecorder = {
	setState: Array<{ id: string; state: AddonState }>;
	broadcast: Array<{ id: string; state: AddonState }>;
	systemctl: string[][];
	download: Array<{ url: string; dest: string }>;
	verify: string[];
	stage: Array<{ tmp: string; dest: string }>;
	helperEnable: string[];
	helperDisable: string[];
	removeArtifact: string[];
	removeState: string[];
	runValidate: string[];
	/** Chronological op tags for ordering assertions. */
	order: string[];
};

export type MockAddonManagerHarness = {
	deps: AddonManagerDeps;
	signals: MockAddonManagerSignals;
	store: Map<string, AddonState>;
	rec: MockAddonManagerRecorder;
};

/** 100 GiB — far above any fixture's free-space requirement, so E1 never gates. */
const HUGE_FREE_BYTES = 100 * 1024 * 1024 * 1024;

/**
 * Build a fully-spying `AddonManagerDeps`. Defaults: real device, RK3588, ample
 * free space, healthy validation probe, zero restarts — so the enable pipeline
 * succeeds end to end. Override `signalsOver` to drive the negative paths
 * (emulated-mode gate, crash-loop, failed probe) and `over` to inject a throwing
 * primitive. No real fs / systemctl / sudo / network is ever touched.
 */
export function createMockAddonManagerDeps(
	signalsOver: Partial<MockAddonManagerSignals> = {},
	over: Partial<AddonManagerDeps> = {},
): MockAddonManagerHarness {
	const signals: MockAddonManagerSignals = {
		isRealDevice: true,
		hardware: "rk3588",
		freeBytes: HUGE_FREE_BYTES,
		osVersion: "12",
		nRestarts: 0,
		validateOk: true,
		...signalsOver,
	};
	const store = new Map<string, AddonState>();
	const rec: MockAddonManagerRecorder = {
		setState: [],
		broadcast: [],
		systemctl: [],
		download: [],
		verify: [],
		stage: [],
		helperEnable: [],
		helperDisable: [],
		removeArtifact: [],
		removeState: [],
		runValidate: [],
		order: [],
	};

	const deps: AddonManagerDeps = {
		isRealDevice: () => Promise.resolve(signals.isRealDevice),
		getEffectiveHardware: () => signals.hardware,
		getDataFreeBytes: () => Promise.resolve(signals.freeBytes),
		getOsVersion: () => Promise.resolve(signals.osVersion),
		download: (url, dest) => {
			rec.download.push({ url, dest });
			rec.order.push("download");
			return Promise.resolve();
		},
		verify: (_descriptor, tmp) => {
			rec.verify.push(tmp);
			rec.order.push("verify");
			return Promise.resolve();
		},
		stage: (tmp, dest) => {
			rec.stage.push({ tmp, dest });
			rec.order.push("stage");
			return Promise.resolve();
		},
		helperEnable: (id) => {
			rec.helperEnable.push(id);
			rec.order.push("helperEnable");
			return Promise.resolve();
		},
		helperDisable: (id) => {
			rec.helperDisable.push(id);
			rec.order.push("helperDisable");
			return Promise.resolve();
		},
		systemctl: (args) => {
			rec.systemctl.push(args);
			rec.order.push(`systemctl:${args.join(" ")}`);
			return Promise.resolve({ stdout: "", stderr: "" } satisfies ExecResult);
		},
		getNRestarts: () => Promise.resolve(signals.nRestarts),
		runValidate: (cmd) => {
			rec.runValidate.push(cmd);
			rec.order.push("validate");
			return Promise.resolve(signals.validateOk);
		},
		removeArtifact: (path) => {
			rec.removeArtifact.push(path);
			return Promise.resolve();
		},
		getState: (id) => store.get(id),
		setState: (id, state) => {
			store.set(id, state);
			rec.setState.push({ id, state });
		},
		removeState: (id) => {
			store.delete(id);
			rec.removeState.push(id);
		},
		broadcast: (id, state) => {
			rec.broadcast.push({ id, state });
		},
		...over,
	};

	return { deps, signals, store, rec };
}

// ─── reconciler dependency double ────────────────────────────────────────────

/** Controllable inputs the reconciler reads through its injected deps. */
export type MockReconcilerSignals = {
	isRealDevice: boolean;
	isStreaming: boolean;
	osVersion: string;
	board: string;
	rawExists: boolean;
};

/** Every effectful call the reconciler makes, recorded for assertions. */
export type MockReconcilerRecorder = {
	states: Array<{ id: string; state: AddonState }>;
	fetch: MaterialiseArgs[];
	refresh: number;
	logs: string[];
};

export type MockReconcilerHarness = {
	deps: ReconcilerDeps;
	signals: MockReconcilerSignals;
	addons: AddonConfig;
	rec: MockReconcilerRecorder;
};

/**
 * Build a fully-spying `ReconcilerDeps`. Defaults describe a real device with a
 * single enabled + materialised add-on for the live OS — i.e. the idempotent
 * no-op path (no fetch / refresh / write). Override to drive re-materialise
 * (`rawExists: false`), the pending/defer negatives (`isStreaming`, a throwing
 * `fetchAndStage`), or the emulated-mode no-op (`isRealDevice: false`). No real
 * network / sudo / fs is touched.
 */
export function createMockReconcilerDeps(
	signalsOver: Partial<MockReconcilerSignals> = {},
	over: Partial<ReconcilerDeps> = {},
): MockReconcilerHarness {
	const signals: MockReconcilerSignals = {
		isRealDevice: true,
		isStreaming: false,
		osVersion: "12",
		board: "rk3588",
		rawExists: true,
		...signalsOver,
	};
	const addons: AddonConfig = {
		[MockAddonDescriptor.id]: structuredClone(MockAddonState),
	};
	const rec: MockReconcilerRecorder = {
		states: [],
		fetch: [],
		refresh: 0,
		logs: [],
	};

	const deps: ReconcilerDeps = {
		isRealDevice: () => Promise.resolve(signals.isRealDevice),
		getIsStreaming: () => signals.isStreaming,
		getOsVersionId: () => Promise.resolve(signals.osVersion),
		getBoard: () => signals.board,
		getAddons: () => addons,
		readDescriptor: () => Promise.resolve(structuredClone(MockAddonDescriptor)),
		rawExists: () => Promise.resolve(signals.rawExists),
		fetchAndStage: (args) => {
			rec.fetch.push(args);
			return Promise.resolve();
		},
		refresh: () => {
			rec.refresh++;
			return Promise.resolve();
		},
		setState: (id, state) => {
			rec.states.push({ id, state });
		},
		log: (msg) => {
			rec.logs.push(msg);
		},
		...over,
	};

	return { deps, signals, addons, rec };
}
