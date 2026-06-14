/*
	CeraUI - Kiosk Mock Doubles (DC-2 state machine — T14)

	Emulated-mode stand-ins for the kiosk subsystem so the kiosk RPC handlers and
	the DC-2 failure-observation poll loop can be exercised in tests/dev WITHOUT
	hardware and WITHOUT ever touching the real `systemctl` / `systemd-sysext`.

	The real kiosk module (`modules/system/kiosk.ts`) already injects every
	OS-touching primitive through `KioskDeps`; this provider builds a fully
	in-memory `KioskDeps` double:

	  - fake `systemctl`        — records argv and interprets start/stop/mask on
	                              `kiosk.service` so the unit's live state tracks;
	  - fake `systemd-sysext`   — the cog-display add-on's sysext merge/unmerge,
	                              modelled by the enableAddon/disableAddon doubles
	                              (the real manager drives `systemd-sysext refresh`
	                              behind those calls), exposed as `sysextOps`;
	  - kiosk token generation  — `generateMockKioskToken()` mints a contract-shaped
	                              64-hex token WITHOUT writing the tmpfs file;
	  - DC-2 state-machine deps  — `loadCogDescriptor`, `enableAddon`, `disableAddon`,
	                              the four failure-observation probes, marker I/O,
	                              `oskSignal`, and the `broadcast` spy.

	The token / status / cog-descriptor fixtures are validated at init by
	`validateMockFixtures()` (mock-schemas.ts, T3); `resetMockKioskState()` is wired
	into `resetMockState()` (mock-service.ts, T4) so the active harness is scrubbed
	on a mock-state reset.
*/

import type { AddonDescriptor, KioskStatus } from "@ceraui/rpc/schemas";

import type { KioskDeps, OskSignal } from "../../modules/system/kiosk.ts";

// ─── Fixtures (validated by validateMockFixtures — T3) ───────────────────────

/** Token entropy, in bytes → 64 hex characters (mirrors `kiosk-token.ts`). */
const KIOSK_TOKEN_BYTES = 32;

/**
 * A static, contract-shaped kiosk loopback token (64 lowercase hex chars). Used
 * to validate {@link mockKioskTokenSchema} and as a deterministic stand-in where
 * a fresh `generateMockKioskToken()` value would defeat an assertion.
 */
export const MOCK_KIOSK_TOKEN = "ab".repeat(KIOSK_TOKEN_BYTES);

/**
 * Pristine kiosk wire status fixture — the inert, freshly-flashed default the
 * settings UI renders before the toggle is ever flipped (DC-2 `disabled`).
 */
export const MOCK_KIOSK_STATUS: KioskStatus = {
	enabled: false,
	state: "disabled",
	display: "lcd",
	touch: true,
	motion: true,
	performance: "balanced",
};

/**
 * Schema-valid stand-in for the image-baked cog-display descriptor (T37) the
 * kiosk module loads at toggle time and hands to the add-on manager. Mirrors the
 * real `/usr/share/ceralive/addons/cog-display.json` shape so the mock exercises
 * the same enable/disable path a real device would.
 */
export const MOCK_COG_DISPLAY_DESCRIPTOR: AddonDescriptor = {
	id: "cog-display",
	name: "Cog Display Engine",
	version: "0.16.1",
	category: "display",
	payload: { type: "sysext" },
	sysextLevel: "1",
	versionId: "12",
	compatibleOsVersions: ["12"],
	artifact: {
		urlTemplate:
			"https://apt.ceralive.tv/addons/cog-display/{os_version}/cog-display.raw",
		sha256: "a".repeat(64),
		gpgSigRef:
			"https://apt.ceralive.tv/addons/cog-display/{os_version}/cog-display.raw.sig",
		sizeDownload: 57671680,
		sizeInstalled: 125829120,
	},
	provides: ["/usr/bin/cog", "/usr/bin/cage"],
	units: {
		unmask: ["kiosk.service"],
		enable: ["kiosk.service"],
		start: ["kiosk.service"],
	},
	validate: { cmd: "/usr/bin/cog --version", timeout: 10 },
};

// ─── Token generation double ─────────────────────────────────────────────────

/**
 * Mint a fresh contract-shaped kiosk token (32 bytes, hex-encoded → 64 chars),
 * mirroring `mintKioskToken()` in `modules/ui/kiosk-token.ts` — but WITHOUT the
 * tmpfs write/chmod. Pure entropy; safe to call on any host, no root, no /run.
 */
export function generateMockKioskToken(): string {
	const buf = new Uint8Array(KIOSK_TOKEN_BYTES);
	crypto.getRandomValues(buf);
	return Buffer.from(buf).toString("hex");
}

// ─── DC-2 deps double ────────────────────────────────────────────────────────

/** The three failure-observation signals + the no-display marker the poll reads. */
export type MockKioskSignals = {
	isFailed: boolean;
	isActive: boolean;
	nRestarts: number;
	marker: boolean;
};

const DEFAULT_SIGNALS: MockKioskSignals = {
	isFailed: false,
	isActive: false,
	nRestarts: 0,
	marker: false,
};

/**
 * An injectable `KioskDeps` double plus the recorders/inspectors a test asserts
 * against. The `signals` object is mutable so a test can drive the poll loop
 * (e.g. flip `isActive` to resolve `enabled-running`).
 */
export type MockKioskHarness = {
	/** The injectable surface — pass to `setKioskDeps()` or a module fn directly. */
	deps: KioskDeps;
	/** Every `systemctl <args>` the machine issued (argv arrays, in order). */
	systemctlCalls: string[][];
	/** Every client-facing status broadcast (the state-event oracle). */
	broadcasts: KioskStatus[];
	/** OSK signals sent to the (faked) wvkbd process. */
	oskSignals: OskSignal[];
	/** Descriptors handed to the cog-display add-on enable (sysext merge) path. */
	enableAddonCalls: AddonDescriptor[];
	/** Descriptors handed to the cog-display add-on disable (sysext unmerge) path. */
	disableAddonCalls: AddonDescriptor[];
	/** The fake `systemd-sysext` merge/unmerge ledger, in order. */
	sysextOps: Array<"merge" | "unmerge">;
	/** The live, test-mutable failure-observation signals. */
	signals: MockKioskSignals;
	/** Times the display-failure marker was deleted. */
	markerRemovedCount: () => number;
	/** Whether the cog-display sysext is currently merged. */
	isSysextMerged: () => boolean;
	/** Scrub all recorders + restore the initial signals/sysext state. */
	reset: () => void;
};

// The harness most recently created by createMockKioskDeps(). resetMockKioskState
// (wired into resetMockState, T4) scrubs it so a mock-state reset also clears the
// kiosk double — null until a harness is created, so it is a safe no-op in suites
// that never touch the kiosk subsystem.
let activeHarness: MockKioskHarness | null = null;

/**
 * Build a kiosk `KioskDeps` double seeded with the given failure-observation
 * signals. The fake `systemctl` interprets the unit verbs the DC-2 machine
 * issues (`start`/`stop`/`mask` on `kiosk.service`) so the live state tracks;
 * the enable/disable doubles model the cog-display sysext merge/unmerge and snap
 * `isActive` accordingly, so a subsequent poll resolves a realistic state.
 *
 * Registers the returned harness as the active one (for {@link resetMockKioskState}).
 */
export function createMockKioskDeps(
	initial: Partial<MockKioskSignals> = {},
): MockKioskHarness {
	const initialSignals: MockKioskSignals = { ...DEFAULT_SIGNALS, ...initial };
	const signals: MockKioskSignals = { ...initialSignals };

	const systemctlCalls: string[][] = [];
	const broadcasts: KioskStatus[] = [];
	const oskSignals: OskSignal[] = [];
	const enableAddonCalls: AddonDescriptor[] = [];
	const disableAddonCalls: AddonDescriptor[] = [];
	const sysextOps: Array<"merge" | "unmerge"> = [];
	let markerRemovedCount = 0;
	let sysextMerged = false;

	const deps: KioskDeps = {
		systemctl: async (args) => {
			systemctlCalls.push([...args]);
			// Interpret the unit lifecycle so the faked unit state tracks the verb.
			if (args[1] === "kiosk.service") {
				if (args[0] === "start") {
					signals.isActive = true;
					signals.isFailed = false;
				} else if (args[0] === "stop" || args[0] === "mask") {
					signals.isActive = false;
				}
			}
			return { stdout: "", stderr: "" };
		},
		isFailed: async () => signals.isFailed,
		isActive: async () => signals.isActive,
		getNRestarts: async () => signals.nRestarts,
		noDisplayMarkerExists: async () => signals.marker,
		removeNoDisplayMarker: async () => {
			markerRemovedCount++;
			signals.marker = false;
		},
		oskSignal: async (signal) => {
			oskSignals.push(signal);
		},
		broadcast: (status) => {
			broadcasts.push(status);
		},
		loadCogDescriptor: () => MOCK_COG_DISPLAY_DESCRIPTOR,
		enableAddon: async (descriptor) => {
			enableAddonCalls.push(descriptor);
			// The real manager drives `systemd-sysext refresh` + unit start here.
			sysextOps.push("merge");
			sysextMerged = true;
			signals.isActive = true;
			return { success: true, phase: "enabled" };
		},
		disableAddon: async (descriptor) => {
			disableAddonCalls.push(descriptor);
			sysextOps.push("unmerge");
			sysextMerged = false;
			signals.isActive = false;
			return { success: true, phase: "disabled" };
		},
	};

	const harness: MockKioskHarness = {
		deps,
		systemctlCalls,
		broadcasts,
		oskSignals,
		enableAddonCalls,
		disableAddonCalls,
		sysextOps,
		signals,
		markerRemovedCount: () => markerRemovedCount,
		isSysextMerged: () => sysextMerged,
		reset: () => {
			systemctlCalls.length = 0;
			broadcasts.length = 0;
			oskSignals.length = 0;
			enableAddonCalls.length = 0;
			disableAddonCalls.length = 0;
			sysextOps.length = 0;
			markerRemovedCount = 0;
			sysextMerged = false;
			Object.assign(signals, initialSignals);
		},
	};

	activeHarness = harness;
	return harness;
}

/** The active kiosk harness, or null if none has been created this session. */
export function getActiveMockKioskHarness(): MockKioskHarness | null {
	return activeHarness;
}

/** A defensive copy of the pristine kiosk status fixture. */
export function getMockKioskStatus(): KioskStatus {
	return { ...MOCK_KIOSK_STATUS };
}

/**
 * Scrub the active kiosk harness (recorders + signals + sysext state). Wired into
 * `resetMockState()` (mock-service.ts, T4); a no-op when no harness is registered.
 */
export function resetMockKioskState(): void {
	activeHarness?.reset();
}
