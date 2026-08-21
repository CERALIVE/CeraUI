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
 * Cellular-control composition root — the ONE place that decides which modem
 * backend is live, mirroring the `getStreamingBackend()` seam.
 *
 * Three rules make the D-Bus path safe to ship as the fleet default:
 *
 * 1. ABSENCE RESOLVES TO D-BUS. `config.modem_backend` still has no schema
 *    default, so absence resolves through {@link DEFAULT_MODEM_BACKEND} — which
 *    is now `"dbus"`. An UNMODIFIED production config therefore exercises the
 *    cutover, and `modem_backend: "mmcli"` is the operator's explicit rollback
 *    value: it commits synchronously, imports no D-Bus graph, and behaves
 *    byte-identically to every pre-cutover device.
 * 2. COMMIT ON THE FIRST AUTHORITATIVE SNAPSHOT. A `dbus` selection is NOT
 *    committed when `start()` is dispatched, only when it resolves an
 *    authoritative list. Until then the stack is not ready and every modem
 *    procedure answers the typed {@link CELLULAR_STACK_INITIALIZING} — never a
 *    hang, never a throw the operator sees as a crash.
 * 3. FAILURE FALLS BACK, VISIBLY. A rejection, a non-authoritative snapshot, or
 *    a start that outlives {@link DEFAULT_INIT_TIMEOUT_MS} stops the backend,
 *    flags `cellular-stack` on the boot-readiness surface, and commits mmcli in
 *    a ready-BUT-degraded state. Boot is never blocked and the degradation is
 *    readable at `/api/health` rather than inferred from a log line.
 */

import { ORPCError } from "@orpc/server";

import type { ModemBackend } from "../../helpers/config-schemas.ts";
import { logger } from "../../helpers/logger.ts";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getConfig } from "../config.ts";
import { markBootDegraded } from "../system/readiness.ts";

export type ModemBackendKind = ModemBackend;

/**
 * The fleet default. Flipped to `"dbus"` by the observer-adoption cutover; an
 * explicit `modem_backend: "mmcli"` is the operator rollback value and is
 * deliberately still a legal schema value. See
 * `docs/DBUS-OBSERVATION-CONTRACT.md` → "The cutover".
 */
export const DEFAULT_MODEM_BACKEND: ModemBackendKind = "dbus";

export const CELLULAR_STACK_INITIALIZING = "CELLULAR_STACK_INITIALIZING";

export const CELLULAR_SUBSYSTEM = "cellular-stack";

export const DBUS_FALLBACK_REASON = "cellular_dbus_init_failed";

export const DEFAULT_INIT_TIMEOUT_MS = 15_000;

export interface CellularStartResult {
	readonly ok: boolean;
}

export interface CellularBackend {
	start(): Promise<CellularStartResult>;
	stop(): Promise<void>;
}

export type CellularBackendFactory = () => CellularBackend;

export interface CellularStack {
	readonly backend: ModemBackendKind;
	readonly ready: boolean;
	readonly degraded: boolean;
	readonly degradedReason?: string;
}

export interface InitCellularStackDeps {
	readonly backend?: ModemBackendKind;
	readonly createDbusBackend?: CellularBackendFactory;
	readonly initTimeoutMs?: number;
}

const READY_MMCLI: CellularStack = {
	backend: "mmcli",
	ready: true,
	degraded: false,
};

const DEGRADED_MMCLI: CellularStack = {
	backend: "mmcli",
	ready: true,
	degraded: true,
	degradedReason: DBUS_FALLBACK_REASON,
};

let stack: CellularStack = READY_MMCLI;
let activeBackend: CellularBackend | undefined;

export function getCellularStack(): CellularStack {
	return stack;
}

export function assertCellularStackReady(): void {
	if (!stack.ready) {
		throw new ORPCError(CELLULAR_STACK_INITIALIZING, {
			message: "Cellular stack is still initializing",
		});
	}
}

export function resolveModemBackend(
	deps: InitCellularStackDeps = {},
): ModemBackendKind {
	return deps.backend ?? getConfig().modem_backend ?? DEFAULT_MODEM_BACKEND;
}

export async function initCellularStack(
	deps: InitCellularStackDeps = {},
): Promise<void> {
	if (resolveModemBackend(deps) === "mmcli") {
		stack = READY_MMCLI;
		return;
	}

	stack = { backend: "dbus", ready: false, degraded: false };

	let backend: CellularBackend | undefined;
	try {
		const factory = deps.createDbusBackend ?? (await loadDbusBackendFactory());
		backend = factory();
		activeBackend = backend;

		const result = await withDeadline(
			backend.start(),
			deps.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
		);
		if (!result.ok) {
			throw new Error("dbus backend resolved no authoritative snapshot");
		}
		stack = { backend: "dbus", ready: true, degraded: false };
	} catch (err) {
		logger.warn(
			`cellular stack: dbus init failed, falling back to mmcli (${describe(err)})`,
		);
		activeBackend = undefined;
		if (backend !== undefined) {
			await stopQuietly(backend);
		}
		markBootDegraded(CELLULAR_SUBSYSTEM);
		stack = DEGRADED_MMCLI;
	}
}

export async function stopCellularStack(): Promise<void> {
	const backend = activeBackend;
	activeBackend = undefined;
	stack = READY_MMCLI;
	if (backend !== undefined) {
		await stopQuietly(backend);
	}
}

export function resetCellularStack(): void {
	stack = READY_MMCLI;
	activeBackend = undefined;
}

/**
 * A dev host has no system bus, so the real factory can only ever fall back —
 * which would leave `modem_backend: "dbus"` unreachable in dev and make the
 * whole D-Bus surface untestable without hardware.
 *
 * The mock factory is a BACKEND, not a bypass: it enters the same try, the same
 * `withDeadline` race and the same `result.ok` commit test, so every fallback
 * path above stays exercised and the `{ok:false}`-is-not-success rule is
 * unaffected. Only the bus is absent.
 */
async function loadDbusBackendFactory(): Promise<CellularBackendFactory> {
	if (shouldUseMocks()) {
		return () => ({
			start: async () => ({ ok: true }),
			stop: async (): Promise<void> => undefined,
		});
	}
	const { createDbusCellularBackend } = await import("./dbus-backend.ts");
	return createDbusCellularBackend;
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(
			() => reject(new Error(`cellular init exceeded ${ms}ms`)),
			ms,
		);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

async function stopQuietly(backend: CellularBackend): Promise<void> {
	try {
		await backend.stop();
	} catch (err) {
		logger.debug(`cellular stack: backend stop failed: ${describe(err)}`);
	}
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
