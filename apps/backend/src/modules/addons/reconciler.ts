/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Post-boot add-on reconciler (T29).
 *
 * After an OTA the device may carry a NEW OS VERSION_ID while /data (and the
 * add-on desired-state under config.json's `addons` key, T23) survives across
 * the A/B switch. A sysext built for the previous os_version will not merge on
 * the new OS, so any enabled add-on whose staged `/data/extensions/<id>.raw` is
 * missing or was fetched for a different VERSION_ID must be re-materialised.
 *
 * HARD CONTRACT — add-ons NEVER gate boot or the OS-update healthcheck/rollback.
 * This runs as a fire-and-forget background task off the CeraUI startup path;
 * every failure is caught and downgraded to a persisted `pending` phase. The
 * reconciler can fail completely and the device still boots and still rolls back
 * a bad OS update on its own schedule.
 *
 * The whole effectful surface (device gate, streaming state, OS version, baked
 * descriptor, fetch/verify/stage, helper refresh, state persistence) is injected
 * via {@link ReconcilerDeps} — mirroring addon-helper.ts / device-detection.ts —
 * so the decision logic is unit-tested without a board, a network, or sudo. The
 * default deps are assembled lazily (dynamic import) so importing this module in
 * a test never pulls the streaming/config graph or requires setup.json.
 */

import fs from "node:fs";

import {
	type AddonConfig,
	type AddonDescriptor,
	AddonDescriptorSchema,
	type AddonPhase,
	type AddonState,
} from "@ceraui/rpc/schemas";

import { addonRefresh } from "../../helpers/addon-helper.ts";
import { execFileP } from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import {
	createMockReconcilerDeps,
	type MockReconcilerHarness,
} from "../../mocks/providers/addons.ts";
import { isRealDevice } from "../system/device-detection.ts";

/** Persisted on `lastError` when no compatible artifact exists for the live OS. */
export const ADDON_NOT_AVAILABLE_FOR_OS_VERSION =
	"addon_not_available_for_os_version";
/** Persisted on `lastError` when a refresh is deferred because a stream is live. */
export const ADDON_REFRESH_DEFERRED_STREAMING =
	"addon_refresh_deferred_streaming";
/** Persisted on `lastError` when the baked descriptor for an id is unreadable. */
export const ADDON_DESCRIPTOR_UNAVAILABLE = "addon_descriptor_unavailable";

// Device-default filesystem locations (mirror ceralive-addon-helper, T27).
const OS_RELEASE_PATH = "/etc/os-release";
const REGISTRY_DIR = "/usr/share/ceralive/addons";
const STAGE_DIR = "/data/extensions";
const CACHE_DIR = "/var/cache/ceralive/addons";
const KEYRING = "/usr/share/ceralive/addon-keyring.gpg";

const FETCH_TIMEOUT_MS = 60_000;
const MAX_SIG_BYTES = 64 * 1024;

/** Fetch + verify + stage one add-on artifact for a given OS version / board. */
export type MaterialiseArgs = {
	descriptor: AddonDescriptor;
	osVersion: string;
	board: string;
};

/**
 * Injectable surface. Defaults talk to the real OS; tests inject deterministic
 * stand-ins and spies.
 */
export type ReconcilerDeps = {
	/** RK3588-board gate (G6); reconciliation is a no-op in dev/emulated mode. */
	isRealDevice: () => Promise<boolean>;
	/** Live-stream guard — a disruptive refresh is deferred while true. */
	getIsStreaming: () => boolean;
	/** The live OS VERSION_ID (from /etc/os-release). */
	getOsVersionId: () => Promise<string>;
	/** Board token substituted into the artifact url's `{board}` placeholder. */
	getBoard: () => string;
	/** Desired add-on state (config.json `addons`, T23). */
	getAddons: () => AddonConfig;
	/** Read + validate the image-baked descriptor for an id. */
	readDescriptor: (id: string) => Promise<AddonDescriptor>;
	/** Whether the staged `/data/extensions/<id>.raw` exists. */
	rawExists: (id: string) => Promise<boolean>;
	/** Fetch, verify (sha256 + GPG), and atomically stage the artifact. */
	fetchAndStage: (args: MaterialiseArgs) => Promise<void>;
	/** Run `systemd-sysext refresh` via the privileged helper. */
	refresh: () => Promise<void>;
	/** Persist an add-on's runtime state. */
	setState: (id: string, state: AddonState) => void;
	log: (msg: string) => void;
};

type StatePatch = {
	phase: AddonPhase;
	// null = clear; undefined = keep prev; string = set.
	lastError?: string | null;
	osVersionMaterialized?: string;
	versionMaterialized?: string;
};

/**
 * Build the next AddonState from the previous one + a patch. Written field-by-
 * field (rather than spread) because `exactOptionalPropertyTypes` forbids
 * assigning `undefined` to clear an optional — an absent key is the only way to
 * clear `lastError`.
 */
function buildState(prev: AddonState, patch: StatePatch): AddonState {
	const next: AddonState = {
		enabled: prev.enabled,
		phase: patch.phase,
		autoDisabled: prev.autoDisabled,
	};
	if (prev.userConfig !== undefined) next.userConfig = prev.userConfig;

	const versionMaterialized =
		patch.versionMaterialized ?? prev.versionMaterialized;
	if (versionMaterialized !== undefined)
		next.versionMaterialized = versionMaterialized;

	const osVersionMaterialized =
		patch.osVersionMaterialized ?? prev.osVersionMaterialized;
	if (osVersionMaterialized !== undefined)
		next.osVersionMaterialized = osVersionMaterialized;

	if (patch.lastError === null) {
		// cleared — omit the key
	} else if (patch.lastError !== undefined) {
		next.lastError = patch.lastError;
	} else if (prev.lastError !== undefined) {
		next.lastError = prev.lastError;
	}
	return next;
}

async function reconcileOne(
	id: string,
	prev: AddonState,
	osVersion: string,
	board: string,
	deps: ReconcilerDeps,
): Promise<void> {
	let descriptor: AddonDescriptor;
	try {
		descriptor = await deps.readDescriptor(id);
	} catch (err) {
		deps.log(`addon reconciler: ${id} descriptor unavailable: ${String(err)}`);
		deps.setState(
			id,
			buildState(prev, {
				phase: "error",
				lastError: ADDON_DESCRIPTOR_UNAVAILABLE,
			}),
		);
		return;
	}

	// G1 — exact OS VERSION_ID match. A descriptor that declares its compatible
	// versions and does not list the live one has no artifact to fetch: pending.
	if (
		descriptor.compatibleOsVersions &&
		!descriptor.compatibleOsVersions.includes(osVersion)
	) {
		deps.setState(
			id,
			buildState(prev, {
				phase: "pending",
				lastError: ADDON_NOT_AVAILABLE_FOR_OS_VERSION,
			}),
		);
		return;
	}

	// Already materialised for the live VERSION_ID (exact match) → nothing to do.
	const rawPresent = await deps.rawExists(id);
	if (rawPresent && prev.osVersionMaterialized === osVersion) {
		if (prev.phase !== "active" || prev.lastError !== undefined) {
			deps.setState(id, buildState(prev, { phase: "active", lastError: null }));
		}
		return;
	}

	// (Re)materialisation is needed and is disruptive (a sysext refresh re-merges
	// /usr). Defer while a stream is live; retry on the next boot.
	if (deps.getIsStreaming()) {
		deps.log(`addon reconciler: ${id} deferred (stream live); retry next boot`);
		deps.setState(
			id,
			buildState(prev, {
				phase: "pending",
				lastError: ADDON_REFRESH_DEFERRED_STREAMING,
			}),
		);
		return;
	}

	try {
		await deps.fetchAndStage({ descriptor, osVersion, board });
		await deps.refresh();
	} catch (err) {
		// 404 / network / verification failure: no usable artifact for this OS.
		// Set pending and move on — never block.
		deps.log(
			`addon reconciler: ${id} not available for os ${osVersion}: ${String(err)}`,
		);
		deps.setState(
			id,
			buildState(prev, {
				phase: "pending",
				lastError: ADDON_NOT_AVAILABLE_FOR_OS_VERSION,
			}),
		);
		return;
	}

	deps.setState(
		id,
		buildState(prev, {
			phase: "active",
			lastError: null,
			osVersionMaterialized: osVersion,
			versionMaterialized: descriptor.version,
		}),
	);
	deps.log(`addon reconciler: ${id} materialised for os ${osVersion}`);
}

let inFlight = false;

/**
 * The dev in-memory harness used for a {@link shouldUseMocks} reconcile pass.
 * Built per run (the reconciler is stateless across passes) and exposed via
 * {@link peekMockReconcilerHarness}; never constructed on a production path.
 */
let mockReconcilerHarness: MockReconcilerHarness | null = null;

/** The dev harness from the last reconcile pass (null until a dev pass runs). */
export function peekMockReconcilerHarness(): MockReconcilerHarness | null {
	return mockReconcilerHarness;
}

/** Drop the dev harness — test-isolation reset (mirrors resetAddonManagerDeps). */
export function resetAddonReconcilerMock(): void {
	mockReconcilerHarness = null;
}

/**
 * Build the deps a no-arg {@link runAddonReconciler} runs against: a dev
 * harness under {@link shouldUseMocks} (so the reconcile flow is exercisable on
 * a dev box as a controlled pass — `rawExists: false` drives a full
 * fetch/stage/refresh against the fakes), else the real device primitives. The
 * real-path branch NEVER constructs a mock double.
 */
async function resolveReconcilerDeps(): Promise<ReconcilerDeps> {
	if (shouldUseMocks()) {
		mockReconcilerHarness = createMockReconcilerDeps({ rawExists: false });
		return mockReconcilerHarness.deps;
	}
	return buildDefaultDeps();
}

/**
 * Reconcile every enabled add-on against the live OS VERSION_ID. Idempotent,
 * never throws, and self-serialises (a second concurrent call is a no-op) so the
 * boot hook and the oneshot SIGUSR1 trigger can both fire harmlessly.
 */
export async function runAddonReconciler(deps?: ReconcilerDeps): Promise<void> {
	if (inFlight) return;
	inFlight = true;
	try {
		const d = deps ?? (await resolveReconcilerDeps());

		if (!(await d.isRealDevice())) {
			d.log("addon reconciler: skipped (emulated / not a real device)");
			return;
		}

		let osVersion: string;
		try {
			osVersion = await d.getOsVersionId();
		} catch (err) {
			d.log(
				`addon reconciler: cannot read OS VERSION_ID, skipping: ${String(err)}`,
			);
			return;
		}

		const board = d.getBoard();
		for (const [id, state] of Object.entries(d.getAddons())) {
			// Only desired (enabled) add-ons; respect a system auto-disable.
			if (!state.enabled || state.autoDisabled) continue;
			try {
				await reconcileOne(id, state, osVersion, board, d);
			} catch (err) {
				// One add-on must never abort the loop or escape to the boot path.
				d.log(`addon reconciler: ${id} unexpected error: ${String(err)}`);
			}
		}
	} catch (err) {
		// Whole-run failure is swallowed: add-ons NEVER gate boot / OTA rollback.
		logger.error(`addon reconciler aborted (non-fatal): ${String(err)}`);
	} finally {
		inFlight = false;
	}
}

// ---------------------------------------------------------------------------
// Default (real-device) dependency implementations.
// ---------------------------------------------------------------------------

async function buildDefaultDeps(): Promise<ReconcilerDeps> {
	// Dynamic import keeps the heavy streaming/config graph (and setup.json's
	// required top-level load) out of the module's static import set, so tests
	// that inject their own deps never trigger it.
	const [streaming, config, setupMod] = await Promise.all([
		import("../streaming/streaming.ts"),
		import("../config.ts"),
		import("../setup.ts"),
	]);

	return {
		isRealDevice: () => isRealDevice(),
		getIsStreaming: () => streaming.getIsStreaming(),
		getOsVersionId: readOsVersionId,
		getBoard: () => setupMod.setup.hw,
		getAddons: () => config.getAddons(),
		readDescriptor: readBakedDescriptor,
		rawExists: (id) => Bun.file(`${STAGE_DIR}/${id}.raw`).exists(),
		fetchAndStage: fetchAndStageArtifact,
		refresh: async () => {
			await addonRefresh();
		},
		setState: (id, state) => config.setAddonState(id, state),
		log: (msg) => logger.info(msg),
	};
}

async function readOsVersionId(): Promise<string> {
	const txt = await Bun.file(OS_RELEASE_PATH).text();
	const m = txt.match(/^VERSION_ID=(.*)$/m);
	if (!m) throw new Error("VERSION_ID missing from /etc/os-release");
	return (m[1] ?? "").trim().replace(/^"(.*)"$/, "$1");
}

async function readBakedDescriptor(id: string): Promise<AddonDescriptor> {
	const raw = await Bun.file(`${REGISTRY_DIR}/${id}.json`).json();
	return AddonDescriptorSchema.parse(raw);
}

// `{os_version}` / `{board}` are bare tokens (OS_VERSION_RE / hw enum), so
// encodeURIComponent is effectively identity here — kept as defence in depth.
function substitutePlaceholders(
	template: string,
	osVersion: string,
	board: string,
): string {
	return template
		.replace(/\{os_version\}/g, encodeURIComponent(osVersion))
		.replace(/\{board\}/g, encodeURIComponent(board));
}

async function fetchCapped(url: string, maxBytes: number): Promise<Uint8Array> {
	const res = await fetch(url, {
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`fetch ${url} failed: HTTP ${res.status}`);
	const buf = new Uint8Array(await res.arrayBuffer());
	if (buf.byteLength > maxBytes) {
		throw new Error(
			`artifact exceeds declared sizeDownload (${buf.byteLength} > ${maxBytes})`,
		);
	}
	return buf;
}

async function fetchAndStageArtifact(args: MaterialiseArgs): Promise<void> {
	const { descriptor, osVersion, board } = args;
	const id = descriptor.id;
	const rawUrl = substitutePlaceholders(
		descriptor.artifact.urlTemplate,
		osVersion,
		board,
	);
	const sigUrl = substitutePlaceholders(
		descriptor.artifact.gpgSigRef,
		osVersion,
		board,
	);

	const rawBytes = await fetchCapped(rawUrl, descriptor.artifact.sizeDownload);
	const digest = new Bun.CryptoHasher("sha256").update(rawBytes).digest("hex");
	if (digest !== descriptor.artifact.sha256) {
		throw new Error(`sha256 mismatch for ${id}`);
	}
	const sigBytes = await fetchCapped(sigUrl, MAX_SIG_BYTES);

	await fs.promises.mkdir(CACHE_DIR, { recursive: true });
	const cacheRaw = `${CACHE_DIR}/${id}.raw`;
	const cacheSig = `${cacheRaw}.sig`;
	await Bun.write(cacheRaw, rawBytes);
	await Bun.write(cacheSig, sigBytes);

	// Detached-signature check against the image-baked add-on keyring (argv-only;
	// rejects on non-zero exit). The privileged helper re-verifies on refresh.
	await execFileP("gpgv", ["--keyring", KEYRING, cacheSig, cacheRaw]);

	// Atomic publish into the persistent sysext store: temp + rename in-dir so a
	// crash never leaves a half-written .raw for systemd-sysext to merge (E3).
	await fs.promises.mkdir(STAGE_DIR, { recursive: true });
	const stageRaw = `${STAGE_DIR}/${id}.raw`;
	const stageTmp = `${STAGE_DIR}/.${id}.raw.${process.pid}.tmp`;
	await Bun.write(stageTmp, rawBytes);
	await fs.promises.rename(stageTmp, stageRaw);
}
