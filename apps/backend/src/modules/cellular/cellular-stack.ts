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

/**
 * Cellular-control composition root (Phase B seam).
 *
 * Mirrors the `getStreamingBackend()` seam precedent: one selection point so the
 * modem RPC layer never hard-codes which control backend is live. `mmcli` (the
 * default) is the legacy one-shot-CLI path and is synchronously ready — it has no
 * init window, so the default backend behaves exactly as it did before this seam
 * existed. `dbus` selects the `@ceralive/modem-control` ModemManager backend.
 *
 * Two invariants make the dbus path safe:
 *   1. COMMIT-AFTER-FIRST-SNAPSHOT — a dbus backend is only committed once it
 *      confirms its first authoritative snapshot. Until then the stack is
 *      "initializing" and every modem procedure returns the typed
 *      {@link CELLULAR_STACK_INITIALIZING} error (never a raw throw, never a hang).
 *   2. FALLBACK-ON-FAILURE — an init failure, a non-authoritative snapshot, or a
 *      hang past the bounded init window falls back to mmcli and flips an
 *      OBSERVABLE degraded-readiness flag (both on this stack and on the boot
 *      readiness surface at `/api/health`).
 *
 * Phase B foundation only: the modem procedures still drive the existing mmcli
 * code directly. Later Phase-B todos consume the committed dbus backend (shadow
 * mode, wire projection). The reusable {@link assertCellularStackReady} gate is
 * exported for those todos (e.g. the `modem.reconfig` control-channel command,
 * which is not yet an oRPC procedure).
 */

import { ORPCError } from "@orpc/server";
import type { ModemBackend } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { getConfig } from "../config.ts";
import { markBootDegraded } from "../system/readiness.ts";

export type ModemBackendKind = ModemBackend;

export const DEFAULT_MODEM_BACKEND: ModemBackendKind = "mmcli";

/** oRPC error code returned by every modem procedure while dbus init is in flight. */
export const CELLULAR_STACK_INITIALIZING = "CELLULAR_STACK_INITIALIZING";

/** Subsystem name recorded on the boot-readiness surface on a dbus fallback. */
const CELLULAR_SUBSYSTEM = "cellular-stack";

/** Reason surfaced on the stack when a dbus init falls back to mmcli. */
const DBUS_FALLBACK_REASON = "cellular_dbus_init_failed";

/** Bounded init window; a dbus backend that does not snapshot within it falls back. */
const DEFAULT_INIT_TIMEOUT_MS = 15_000;

/** The outcome of a backend's awaited init — `ok` only on an authoritative snapshot. */
export interface CellularStartResult {
	readonly ok: boolean;
}

/**
 * A cellular-control backend. `start()` performs the awaited init and resolves
 * the first snapshot; `stop()` releases the source and is idempotent.
 */
export interface CellularBackend {
	start(): Promise<CellularStartResult>;
	stop(): Promise<void>;
}

export type CellularBackendFactory = () => CellularBackend;

/** Observable readiness snapshot of the committed cellular-control backend. */
export interface CellularStack {
	readonly backend: ModemBackendKind;
	readonly ready: boolean;
	readonly degraded: boolean;
	readonly degradedReason?: string;
}

export interface InitCellularStackDeps {
	/** Force the backend (tests). Default: `config.modem_backend ?? "mmcli"`. */
	backend?: ModemBackendKind;
	/** Inject the dbus backend factory (tests). Default: lazy production factory. */
	createDbusBackend?: CellularBackendFactory;
	/** Bounded init window before falling back to mmcli (default 15s). */
	initTimeoutMs?: number;
}

const READY_MMCLI: CellularStack = {
	backend: "mmcli",
	ready: true,
	degraded: false,
};

// Process-wide singleton (same posture as the identity / readiness singletons).
// DEFAULT is mmcli-ready with no init window, so the default backend — and every
// existing modem test that never calls init — sees a ready stack byte-identically.
let stack: CellularStack = READY_MMCLI;
let activeBackend: CellularBackend | null = null;

/** The committed cellular-control backend readiness snapshot. */
export function getCellularStack(): CellularStack {
	return stack;
}

/**
 * Throw the typed {@link CELLULAR_STACK_INITIALIZING} error while a dbus backend
 * is still initializing. A no-op on the ready mmcli default, so it never fires on
 * the default path. Shared by every modem procedure and (later) `modem.reconfig`.
 */
export function assertCellularStackReady(): void {
	if (!stack.ready) {
		throw new ORPCError(CELLULAR_STACK_INITIALIZING, {
			message: "Cellular stack is initializing",
		});
	}
}

/**
 * Select and initialize the cellular-control backend. Awaited at boot. mmcli is
 * ready immediately; dbus is gated until its first snapshot commits or it falls
 * back to mmcli + degraded. Never throws — a failure resolves as a degraded
 * fallback, so boot continues.
 */
export async function initCellularStack(
	deps: InitCellularStackDeps = {},
): Promise<void> {
	const selected =
		deps.backend ?? getConfig().modem_backend ?? DEFAULT_MODEM_BACKEND;

	if (selected === "mmcli") {
		stack = READY_MMCLI;
		return;
	}

	// dbus: gate every modem procedure until the first authoritative snapshot.
	stack = { backend: "dbus", ready: false, degraded: false };
	const factory = deps.createDbusBackend ?? (await loadProductionDbusFactory());
	const backend = factory();
	activeBackend = backend;

	try {
		const result = await withTimeout(
			backend.start(),
			deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
		);
		if (!result.ok) {
			throw new Error("dbus backend produced no authoritative snapshot");
		}
		stack = { backend: "dbus", ready: true, degraded: false };
	} catch (err) {
		logger.warn(
			`cellular stack: dbus backend init failed — falling back to mmcli (${errorMessage(
				err,
			)})`,
		);
		await safeStop(backend);
		activeBackend = null;
		markBootDegraded(CELLULAR_SUBSYSTEM);
		stack = {
			backend: "mmcli",
			ready: true,
			degraded: true,
			degradedReason: DBUS_FALLBACK_REASON,
		};
	}
}

/**
 * Stop the committed dbus backend and release its transport, then reset to the
 * mmcli default. Idempotent — a no-op on the mmcli path (no active backend).
 */
export async function stopCellularStack(): Promise<void> {
	const backend = activeBackend;
	activeBackend = null;
	stack = READY_MMCLI;
	if (backend) {
		await safeStop(backend);
	}
}

/** Test seam: synchronously reset to the ready mmcli default. */
export function resetCellularStack(): void {
	stack = READY_MMCLI;
	activeBackend = null;
}

async function loadProductionDbusFactory(): Promise<CellularBackendFactory> {
	const { createDbusCellularBackend } = await import("./dbus-backend.ts");
	return createDbusCellularBackend;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`cellular init exceeded ${ms}ms`)),
			ms,
		);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

async function safeStop(backend: CellularBackend): Promise<void> {
	try {
		await backend.stop();
	} catch (err) {
		logger.debug(`cellular stack: stop() after fallback failed: ${err}`);
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
