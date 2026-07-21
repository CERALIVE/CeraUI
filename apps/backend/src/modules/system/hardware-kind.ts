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
 * Resolved hardware-kind provider (Todo 59 consumer-migration follow-up).
 *
 * This is the SINGLE runtime authority for "what board am I running on". It
 * replaces the four direct `setup.json` `hw` reads (`sensors.ts`, `audio.ts`,
 * `pipelines.ts` → `getEffectiveHardware()`, `addons/reconciler.ts`) that all
 * trusted a single image-baked value packaged verbatim into the `ceralive-device`
 * .deb for EVERY board/arch — so an image built for a non-rk3588 board still
 * shipped `hw:"rk3588"` and every consumer picked the wrong board profile.
 *
 * Resolution order (highest-authority first, each tier fails through to the next):
 *
 *   1. engine      — cerastream's `get-capabilities` `platform.hardware_kind`,
 *                    read via a NARROW RAW IPC PROBE. The published npm client
 *                    (`CerastreamClient.getCapabilities()`) Zod-parses the result
 *                    and STRIPS the nested `platform.hardware_kind`/`platform.source`
 *                    fields (they were added in cerastream's Todo-14 wire bump but
 *                    the binding is not republished), so this module dials the
 *                    control socket DIRECTLY (hello → get-capabilities as raw
 *                    JSON-RPC/NDJSON) and reads ONLY the optional `platform` field
 *                    tolerantly. All failures (socket down, timeout, malformed,
 *                    field absent) fall through — this MUST NEVER block boot.
 *   2. device-tree — `detectHardwareKindFromDeviceTree()` (Todo 14b): the same
 *                    reliable `/proc/device-tree/compatible`→`model`→DMI probes
 *                    `isRealDevice()` uses. `unknown` (unrecognised board) falls
 *                    through rather than guessing.
 *   3. setup.hw    — the static `setup.json` `hw` value (fallback + test seam; NOT
 *                    removed — a dev/CI host with no device-tree and no engine
 *                    still resolves the checked-in default here).
 *   4. generic     — the fail-safe floor when nothing above named a board.
 *
 * The resolved value is CACHED with its source tier and RE-RESOLVED on every
 * engine reconnect/capability refresh (`engine-reconnect.ts` heal path): a
 * boot-time device-tree/setup.hw fallback is superseded by the engine value once
 * cerastream comes up. A re-resolution that changes the kind logs a loud drift
 * warning (the earlier lower-tier resolution was wrong for this board).
 *
 * Two public reads:
 *   - `getHardwareKind()`  async — runs the full resolution, updates the cache.
 *   - `getHardwareKindCached()` sync — the cached value for hot paths after init;
 *     before the first resolution it returns the `setup.hw` fallback, so a
 *     consumer that reads it at boot (e.g. `getEffectiveHardware()` in
 *     `initPipelines`) stays byte-identical to the pre-migration `setup.hw` read.
 */

import { join } from "node:path";

import { logger as defaultLogger } from "../../helpers/logger.ts";
import { setup } from "../setup.ts";
import {
	type DetectedHardwareKind,
	detectHardwareKindFromDeviceTree,
} from "./device-detection.ts";

/**
 * The board family the runtime authorities can name. Mirrors cerastream's
 * `platform.hardware_kind` wire vocabulary and `pipelines.ts` `HardwareType` —
 * the shared token space that also backs `setup.json` `hw` (minus `generic`,
 * which `setup.hw` never carries but the resolver's floor does).
 */
export type HardwareKind = "rk3588" | "jetson" | "n100" | "generic";

/** Which resolution tier produced the cached {@link HardwareKind}. */
export type HardwareKindTier =
	| "engine"
	| "device-tree"
	| "setup.hw"
	| "generic";

/** A resolved kind paired with the tier that produced it. */
export interface ResolvedHardwareKind {
	kind: HardwareKind;
	tier: HardwareKindTier;
}

const VALID_KINDS: ReadonlySet<string> = new Set<HardwareKind>([
	"rk3588",
	"jetson",
	"n100",
	"generic",
]);

/**
 * Bounded overall budget for the raw engine probe. Kept short so a slow/absent
 * engine socket at boot falls through to the device-tree tier fast — the
 * provider MUST NOT block boot on the engine (spec MUST-NOT).
 */
export const HARDWARE_KIND_PROBE_TIMEOUT_MS = 2_000;

/** cerastream control-IPC protocol literal (mirrors `@ceralive/cerastream`). */
const CERASTREAM_PROTOCOL = "cerastream-ipc/1";
/** Default control-socket dir + basename (mirrors the package's path resolver). */
const DEFAULT_IPC_DIR = "/run/cerastream";
const CONTROL_SOCKET_NAME = "control.sock";
const IPC_DIR_ENV = "CERASTREAM_IPC_DIR";

/**
 * Resolve the cerastream control-socket path exactly as the npm client would:
 * an explicit `setup.json` override wins, else the `CERASTREAM_IPC_DIR` env dir,
 * else `/run/cerastream`, joined with `control.sock`. Self-contained so this
 * module adds no new import from `@ceralive/cerastream` (the bindings-skew guard
 * stays untouched).
 */
function resolveControlSocketPath(): string {
	if (setup.cerastream_socket) return setup.cerastream_socket;
	const dir = process.env[IPC_DIR_ENV];
	return join(
		dir && dir.length > 0 ? dir : DEFAULT_IPC_DIR,
		CONTROL_SOCKET_NAME,
	);
}

/** Read a tolerant `platform.hardware_kind` off a raw get-capabilities result. */
function readHardwareKind(result: unknown): HardwareKind | undefined {
	if (typeof result !== "object" || result === null) return undefined;
	const platform = (result as { platform?: unknown }).platform;
	if (typeof platform !== "object" || platform === null) return undefined;
	const kind = (platform as { hardware_kind?: unknown }).hardware_kind;
	return typeof kind === "string" && VALID_KINDS.has(kind)
		? (kind as HardwareKind)
		: undefined;
}

/**
 * NARROW RAW IPC PROBE. Dial the control socket directly, run the mandatory
 * `hello` handshake then `get-capabilities` as raw JSON-RPC 2.0 / NDJSON, and
 * read ONLY the optional `platform.hardware_kind` field tolerantly. EVERY failure
 * (connect refused, timeout, non-JSON, RPC error, field absent/invalid) resolves
 * `undefined` so the caller falls through to the next tier — this never throws.
 *
 * Mirrors the `@ceralive/cerastream` transport (`Bun.connect({unix})` + newline
 * framing) rather than routing through the typed client, because the typed client
 * strips the nested `platform.hardware_kind` field before returning.
 */
export async function probeEngineHardwareKind(
	socketPath: string = resolveControlSocketPath(),
	timeoutMs: number = HARDWARE_KIND_PROBE_TIMEOUT_MS,
): Promise<HardwareKind | undefined> {
	type Socket = Awaited<ReturnType<typeof Bun.connect>>;
	let socket: Socket | undefined;
	let buffer = "";
	let settled = false;
	let nextId = 1;
	const pending = new Map<number, (result: unknown) => void>();

	return await new Promise<HardwareKind | undefined>((resolve) => {
		const finish = (kind: HardwareKind | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				socket?.end();
			} catch {
				// best-effort close of a probe connection; never respawns the engine.
			}
			resolve(kind);
		};

		const timer = setTimeout(() => finish(undefined), timeoutMs);

		const request = (method: string, params?: unknown): Promise<unknown> => {
			const id = nextId++;
			const envelope: Record<string, unknown> = { jsonrpc: "2.0", id, method };
			if (params !== undefined) envelope.params = params;
			return new Promise((res) => {
				pending.set(id, res);
				socket?.write(`${JSON.stringify(envelope)}\n`);
				socket?.flush();
			});
		};

		const onLine = (line: string): void => {
			let msg: unknown;
			try {
				msg = JSON.parse(line);
			} catch {
				return; // a non-JSON line is not addressable — drop it.
			}
			if (typeof msg !== "object" || msg === null || !("id" in msg)) return;
			const id = (msg as { id?: unknown }).id;
			if (typeof id !== "number") return;
			const resolver = pending.get(id);
			if (!resolver) return;
			pending.delete(id);
			// An `error` response settles as `undefined` (no `result`); the driver
			// then aborts the sequence.
			resolver((msg as { result?: unknown }).result);
		};

		const onData = (chunk: Buffer): void => {
			buffer += chunk.toString("utf8");
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				const line = buffer.slice(0, nl);
				buffer = buffer.slice(nl + 1);
				if (line.length > 0) onLine(line);
				nl = buffer.indexOf("\n");
			}
		};

		void (async () => {
			try {
				socket = await Bun.connect({
					unix: socketPath,
					socket: {
						data: (_s, chunk) => onData(chunk),
						close: () => finish(undefined),
						end: () => finish(undefined),
						error: () => finish(undefined),
					},
				});
			} catch {
				finish(undefined);
				return;
			}
			if (settled) return;
			try {
				const hello = await request("hello", {
					protocol: CERASTREAM_PROTOCOL,
					client: "@ceraui/hardware-kind",
				});
				// A missing hello result means an RPC error / malformed handshake.
				if (hello === undefined || settled) {
					finish(undefined);
					return;
				}
				const caps = await request("get-capabilities");
				finish(readHardwareKind(caps));
			} catch {
				finish(undefined);
			}
		})();
	});
}

/** Injectable collaborators; defaults wire the real probe / DT / setup.hw / logger. */
export interface HardwareKindResolveDeps {
	/** Raw engine probe (tier 1). Resolves `undefined` on any failure. */
	probeEngine: () => Promise<HardwareKind | undefined>;
	/** Device-tree / DMI detection (tier 2). `unknown` falls through. */
	detectFromDeviceTree: () => Promise<DetectedHardwareKind>;
	/** The static `setup.json` `hw` value (tier 3 fallback). */
	getConfiguredHw: () => string;
	/** Loud, journal-visible warning sink (drift). */
	warn: (message: string) => void;
	/** Diagnostic sink (per-resolution tier line). */
	debug: (message: string, meta?: unknown) => void;
}

function defaultDeps(): HardwareKindResolveDeps {
	return {
		probeEngine: () => probeEngineHardwareKind(),
		detectFromDeviceTree: () => detectHardwareKindFromDeviceTree(),
		getConfiguredHw: () => setup.hw,
		warn: (message) => defaultLogger.warn(message),
		debug: (message, meta) => defaultLogger.debug(message, meta),
	};
}

/** The `setup.hw` fallback coerced into a valid {@link HardwareKind}. */
function setupFallbackKind(getConfiguredHw: () => string): HardwareKind {
	const hw = getConfiguredHw();
	return VALID_KINDS.has(hw) ? (hw as HardwareKind) : "generic";
}

// Process-wide cached resolution (mirrors the capability-service last-known-good
// posture). `undefined` until the first `getHardwareKind()` completes.
let cached: ResolvedHardwareKind | undefined;

/**
 * Sync read for hot paths after init: the cached resolved kind, or — before the
 * first async resolution — the `setup.hw` fallback. NEVER dials the socket and
 * never throws, so a boot-time caller (`getEffectiveHardware()` inside
 * `initPipelines`) stays byte-identical to the pre-migration `setup.hw` read.
 */
export function getHardwareKindCached(): HardwareKind {
	return cached?.kind ?? setupFallbackKind(() => setup.hw);
}

/** The tier that produced the cached kind, or `undefined` before first resolve. */
export function getHardwareKindTier(): HardwareKindTier | undefined {
	return cached?.tier;
}

/**
 * Run the full resolution ladder (engine → device-tree → setup.hw → generic),
 * update the cache, and return the resolved {@link HardwareKind}.
 *
 * - Logs a debug line naming the source tier on EVERY resolution (the live-QA
 *   signal: on a healthy engine the first boot resolution reads `engine`).
 * - Fires a loud drift warning when a re-resolution CHANGES the cached kind — a
 *   boot-time device-tree/setup.hw fallback superseded by a differing engine value
 *   means the earlier lower-tier guess was wrong for this board.
 *
 * Never throws: each tier is fail-through; the floor (`generic`) always resolves.
 */
export async function getHardwareKind(
	overrides: Partial<HardwareKindResolveDeps> = {},
): Promise<HardwareKind> {
	const deps: HardwareKindResolveDeps = { ...defaultDeps(), ...overrides };

	const resolved = await resolveHardwareKind(deps);

	const previous = cached;
	if (
		previous !== undefined &&
		previous.kind !== resolved.kind &&
		previous.tier !== "generic"
	) {
		deps.warn(
			`hardware kind drift: was "${previous.kind}" (tier ${previous.tier}) but ` +
				`re-resolved to "${resolved.kind}" (tier ${resolved.tier}). The ` +
				"higher-authority tier now wins; earlier consumers ran the wrong " +
				"board profile until this refresh.",
		);
	}

	cached = resolved;
	deps.debug("hardware kind resolved", {
		kind: resolved.kind,
		tier: resolved.tier,
	});
	return resolved.kind;
}

/** The pure resolution ladder — no caching, no logging (unit-testable). */
async function resolveHardwareKind(
	deps: HardwareKindResolveDeps,
): Promise<ResolvedHardwareKind> {
	const fromEngine = await deps.probeEngine();
	if (fromEngine !== undefined) return { kind: fromEngine, tier: "engine" };

	const fromDeviceTree = await deps.detectFromDeviceTree();
	if (fromDeviceTree !== "unknown") {
		return { kind: fromDeviceTree, tier: "device-tree" };
	}

	const hw = deps.getConfiguredHw();
	if (VALID_KINDS.has(hw))
		return { kind: hw as HardwareKind, tier: "setup.hw" };

	return { kind: "generic", tier: "generic" };
}

/** Test seam: drop the cached resolution so each test starts clean. */
export function resetHardwareKindCache(): void {
	cached = undefined;
}
