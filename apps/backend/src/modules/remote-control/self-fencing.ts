/**
 * Remote Control Plane v2.0 — device-side self_fencing commit-confirm watchdog
 * (remote-relay-support spec §7).
 *
 * `self_fencing` protects the operator from a remote command that could sever the
 * very channel carrying it (e.g. reconfiguring the network the device dials out
 * on). Two shapes, keyed off whether the op can be rolled back:
 *
 *   - **Revertible** (`network.reconfig`, `modem.reconfig`, `device.remoteKeyChange`):
 *     snapshot → apply → start a 30s watchdog. A `self_fencing.confirm` carrying the
 *     original `cid` commits the change; otherwise the watchdog fires and the snapshot
 *     is restored. The first result frame carries the new state with `self_fencing:true`
 *     to tell the operator a confirm is owed; the terminal frame reports committed
 *     (`reverted:false`) or rolled-back (`reverted:true`).
 *
 *   - **Non-revertible** (`system.reboot`, `device.factoryReset`): there is no rollback,
 *     so the op is gated BEHIND the confirm — it never runs on receipt. The device
 *     emits `ok:false, error:"self_fencing_confirm_required"` and waits; the matching
 *     confirm executes it. If the watchdog fires first the pending op is discarded with
 *     `ok:false, error:"self_fencing_unconfirmed"`.
 *
 * The watchdog default is 30s and is NOT wire-negotiated in v2.0 (spec §7) — hub and
 * device hardcode the same {@link SELF_FENCING_WATCHDOG_MS}.
 *
 * The actual resource mutations are an injected seam ({@link SelfFencingOps}) so the
 * watchdog is unit-testable with a fake clock and fake ops — the same DI posture as
 * `channel.ts` / `command-router.ts`. The default ops persist+restore config (the safe
 * reversible floor) and spawn the real lifecycle command; richer per-resource wiring is
 * injected, not hardcoded here.
 */

import { logger } from "../../helpers/logger.ts";
import { sendFrame } from "./channel.ts";
import {
	type Command,
	PROTOCOL_VERSION,
	type Result,
	type ResultPayload,
	SELF_FENCING_WATCHDOG_MS,
	type SelfFencingType,
} from "./protocol.ts";

type TimerHandle = ReturnType<typeof setTimeout>;
type CommandPayload = Command["payload"];

/**
 * A revertible self_fencing op (spec §7). `snapshot` captures the pre-change state,
 * `apply` performs the change and returns the new state, `revert` restores the snapshot
 * if the watchdog fires before a confirm arrives.
 */
export interface RevertibleOp {
	revertible: true;
	snapshot: (payload: CommandPayload) => Promise<unknown>;
	apply: (payload: CommandPayload) => Promise<unknown>;
	revert: (snapshot: unknown) => Promise<void>;
}

/**
 * A non-revertible self_fencing op (spec §7). It cannot be rolled back, so `execute`
 * only runs once the matching confirm has arrived — never on receipt of the command.
 */
export interface NonRevertibleOp {
	revertible: false;
	execute: (payload: CommandPayload) => Promise<void>;
}

export type SelfFencingOp = RevertibleOp | NonRevertibleOp;

/** Op handlers keyed by the self_fencing command `type` (spec §5 / §7). */
export type SelfFencingOps = Record<SelfFencingType, SelfFencingOp>;

/**
 * Injectable collaborators (same DI posture as `channel.ts`). Defaults wire the live
 * channel `sendFrame`, the real op table, the 30s watchdog, and real timers; tests
 * override `sendResult`/`ops` to capture frames and a fake clock via `setTimer`.
 */
export interface SelfFencingDeps {
	/** Best-effort result-frame sink (spec §6). Defaults to the live channel. */
	sendResult: (frame: Result) => boolean;
	/** Resource-mutation handlers, one per self_fencing op type. */
	ops: SelfFencingOps;
	/** Watchdog window in milliseconds (spec §7 — defaults to 30s, not negotiated). */
	watchdogMs: number;
	setTimer: (fn: () => void, ms: number) => TimerHandle;
	clearTimer: (timer: TimerHandle) => void;
	logger: { info: (message: string) => void; warn: (message: string) => void };
}

/**
 * A self_fencing op that is mid-flight: applied (revertible) or gated (non-revertible)
 * and waiting for its `self_fencing.confirm`. Keyed by the original command `cid`.
 */
interface PendingOp {
	frame: Command;
	deps: SelfFencingDeps;
	op: SelfFencingOp;
	timer: TimerHandle;
	/** Pre-change state to restore on auto-revert (revertible ops only). */
	snapshot: unknown;
	/** Post-apply state echoed on commit (revertible ops only). */
	applied: unknown;
}

// Process-wide pending table (mirrors the module-state posture of channel.ts). A
// confirm or a watchdog timeout resolves and removes its entry by `cid`.
const pending = new Map<string, PendingOp>();

/**
 * Build the default op table. Each handler defers its heavy module import to call time
 * (dynamic `import`) so this module never pulls the config/remote/network graph — or
 * triggers a `setup.json` read — at load time (the same fail-soft posture the rest of
 * the control plane relies on for standalone test loads).
 */
function defaultSelfFencingOps(): SelfFencingOps {
	return {
		"network.reconfig": configSnapshotOp(),
		"modem.reconfig": configSnapshotOp(),
		"device.remoteKeyChange": configSnapshotOp(),
		"system.reboot": spawnOp(["reboot"]),
		"device.factoryReset": spawnOp(["ceralive-factory-reset"]),
	};
}

/**
 * The safe reversible floor for a connectivity/lifecycle reconfig: snapshot the full
 * runtime config, persist the requested fields, and restore the snapshot verbatim on
 * timeout. Persisted config is the device's source of truth, so a config restore is a
 * correct, conservative revert — the low-level interface bring-up is layered by
 * injecting a richer op rather than guessing driver semantics here.
 */
function configSnapshotOp(): RevertibleOp {
	return {
		revertible: true,
		snapshot: async () => {
			const { getConfig } = await import("../config.ts");
			return structuredClone(getConfig());
		},
		apply: async (payload) => {
			const { getConfig, saveConfig } = await import("../config.ts");
			const config = getConfig() as Record<string, unknown>;
			Object.assign(config, payload ?? {});
			saveConfig();
			return structuredClone(config);
		},
		revert: async (snapshot) => {
			const { getConfig, saveConfig } = await import("../config.ts");
			const config = getConfig() as Record<string, unknown>;
			for (const key of Object.keys(config)) {
				delete config[key];
			}
			Object.assign(config, snapshot as Record<string, unknown>);
			saveConfig();
		},
	};
}

/** A non-revertible op whose execution is a single privileged spawn (e.g. reboot). */
function spawnOp(argv: string[]): NonRevertibleOp {
	return {
		revertible: false,
		execute: async () => {
			Bun.spawnSync(argv);
		},
	};
}

function defaultDeps(): SelfFencingDeps {
	return {
		sendResult: sendFrame,
		ops: defaultSelfFencingOps(),
		watchdogMs: SELF_FENCING_WATCHDOG_MS,
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (timer) => clearTimeout(timer),
		logger,
	};
}

/**
 * Build a `kind:result` frame echoing the command's `cid` (spec §6). `role` is echoed
 * only when present and `self_fencing` only when flagged (exactOptionalPropertyTypes:
 * never assign `undefined`).
 */
function resultFrame(
	frame: Command,
	payload: ResultPayload,
	options: { selfFencing?: boolean } = {},
): Result {
	return {
		v: PROTOCOL_VERSION,
		kind: "result",
		type: frame.type,
		cid: frame.cid,
		...(frame.role !== undefined ? { role: frame.role } : {}),
		...(options.selfFencing === true ? { self_fencing: true } : {}),
		payload,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Restore the snapshot for a revertible op whose watchdog fired with no confirm, then
 * emit the rolled-back result (`ok:true, applied:<old-state>, reverted:true`, spec §7).
 * A no-op if the entry was already resolved (confirm raced the timer).
 */
async function autoRevert(cid: string): Promise<void> {
	const entry = pending.get(cid);
	if (entry === undefined || !entry.op.revertible) return;
	pending.delete(cid);

	const { frame, deps, op, snapshot } = entry;
	try {
		await op.revert(snapshot);
		deps.logger.warn(
			`self_fencing: ${frame.type} (${cid}) unconfirmed within watchdog, auto-reverted`,
		);
		deps.sendResult(
			resultFrame(frame, { ok: true, applied: snapshot, reverted: true }),
		);
	} catch (err) {
		const message = errorMessage(err);
		deps.logger.warn(
			`self_fencing: ${frame.type} (${cid}) revert failed: ${message}`,
		);
		deps.sendResult(
			resultFrame(frame, { ok: false, applied: null, error: message }),
		);
	}
}

/**
 * Discard a non-revertible op whose pre-confirm watchdog fired (spec §7): the operator
 * never confirmed, so the brick-risk op is dropped with `self_fencing_unconfirmed`.
 */
function discardUnconfirmed(cid: string): void {
	const entry = pending.get(cid);
	if (entry === undefined || entry.op.revertible) return;
	pending.delete(cid);

	const { frame, deps } = entry;
	deps.logger.warn(
		`self_fencing: ${frame.type} (${cid}) unconfirmed within watchdog, discarded`,
	);
	deps.sendResult(
		resultFrame(frame, {
			ok: false,
			applied: null,
			error: "self_fencing_unconfirmed",
		}),
	);
}

/**
 * Handle an inbound self_fencing op command (spec §7). Revertible ops apply behind a
 * watchdog; non-revertible ops are gated behind a pre-confirm and never run on receipt.
 * Never throws — a failing op becomes an `ok:false` result, not an exception.
 */
export async function handleSelfFencingOp(
	frame: Command,
	overrides: Partial<SelfFencingDeps> = {},
): Promise<void> {
	const deps: SelfFencingDeps = { ...defaultDeps(), ...overrides };
	const op = deps.ops[frame.type as SelfFencingType];

	if (op === undefined) {
		deps.sendResult(
			resultFrame(frame, {
				ok: false,
				applied: null,
				error: "self_fencing_unsupported",
			}),
		);
		return;
	}

	if (op.revertible) {
		// Snapshot → apply → arm the watchdog. On any failure before the timer is armed
		// the op simply did not take effect, so report the error and arm nothing.
		try {
			const snapshot = await op.snapshot(frame.payload);
			const applied = await op.apply(frame.payload);
			const timer = deps.setTimer(() => {
				void autoRevert(frame.cid);
			}, deps.watchdogMs);
			pending.set(frame.cid, { frame, deps, op, timer, snapshot, applied });
			deps.logger.info(
				`self_fencing: ${frame.type} (${frame.cid}) applied, awaiting confirm`,
			);
			deps.sendResult(
				resultFrame(frame, { ok: true, applied }, { selfFencing: true }),
			);
		} catch (err) {
			const message = errorMessage(err);
			deps.logger.warn(
				`self_fencing: ${frame.type} (${frame.cid}) apply failed: ${message}`,
			);
			deps.sendResult(
				resultFrame(frame, { ok: false, applied: null, error: message }),
			);
		}
		return;
	}

	// Non-revertible: gate behind the confirm. Arm the watchdog, register the pending
	// op, and tell the operator a confirm is required — the op does NOT run yet.
	const timer = deps.setTimer(() => {
		discardUnconfirmed(frame.cid);
	}, deps.watchdogMs);
	pending.set(frame.cid, {
		frame,
		deps,
		op,
		timer,
		snapshot: undefined,
		applied: undefined,
	});
	deps.logger.info(
		`self_fencing: ${frame.type} (${frame.cid}) pre-confirm required, not executing`,
	);
	deps.sendResult(
		resultFrame(frame, {
			ok: false,
			applied: null,
			error: "self_fencing_confirm_required",
		}),
	);
}

/**
 * Handle a `self_fencing.confirm` carrying the original op's `cid` (spec §7). Cancels
 * the watchdog and either commits a revertible op (`reverted:false`) or executes a
 * gated non-revertible op. A confirm for an unknown/already-resolved `cid` is ignored
 * (best-effort — a late confirm racing the watchdog must not double-fire).
 */
export async function handleSelfFencingConfirm(cid: string): Promise<void> {
	const entry = pending.get(cid);
	if (entry === undefined) return;
	pending.delete(cid);

	const { frame, deps, op } = entry;
	deps.clearTimer(entry.timer);

	if (op.revertible) {
		deps.logger.info(
			`self_fencing: ${frame.type} (${cid}) confirmed, committed`,
		);
		deps.sendResult(
			resultFrame(frame, { ok: true, applied: entry.applied, reverted: false }),
		);
		return;
	}

	// Non-revertible: the confirm authorizes execution. There is no rollback once run.
	try {
		await op.execute(frame.payload);
		deps.logger.info(
			`self_fencing: ${frame.type} (${cid}) confirmed, executed`,
		);
		deps.sendResult(resultFrame(frame, { ok: true, applied: null }));
	} catch (err) {
		const message = errorMessage(err);
		deps.logger.warn(
			`self_fencing: ${frame.type} (${cid}) execute failed: ${message}`,
		);
		deps.sendResult(
			resultFrame(frame, { ok: false, applied: null, error: message }),
		);
	}
}

/**
 * Cancel every in-flight watchdog and clear the pending table. Test-only isolation
 * (mirrors `resetMockState`); never call this from production code.
 */
export function resetSelfFencingState(): void {
	for (const entry of pending.values()) {
		entry.deps.clearTimer(entry.timer);
	}
	pending.clear();
}
