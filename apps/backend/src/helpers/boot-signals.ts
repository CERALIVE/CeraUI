/**
 * Boot-time reservation of the two signals CeraUI uses as IPC pokes.
 *
 * THE DEFECT THIS EXISTS FOR
 *
 * `SIGUSR1` and `SIGUSR2` have a POSIX default disposition of TERMINATE. A
 * process only survives one by installing a handler first, and `main.ts` is a
 * top-level-`await` boot ladder: its `process.on("SIGUSR1", …)` sat at the very
 * END, after config load, the WS bind, the engine probe, the network scan and
 * the audio scan. Every second of that ladder was a window in which an arriving
 * SIGUSR1 killed `ceralive.service` outright.
 *
 * The sender is real and fires at exactly that moment:
 * `ceralive-addon-reconciler.service` is a boot-ordered oneshot whose only job
 * is `systemctl kill --signal=SIGUSR1 ceralive.service`. Whether the backend
 * lives is then a race between systemd's oneshot and the backend's own boot —
 * which is precisely the "SIGUSR1 boot-race kill" report.
 *
 * THE FIX IS TO RESERVE THE SIGNAL, NOT TO HANDLE IT EARLY
 *
 * A handler installed early cannot do the WORK early: `runAddonReconciler` and
 * the audio/Cam Link rescan both read modules the ladder has not initialised
 * yet. So the guard installed here is deliberately inert — it RECORDS that the
 * poke arrived and returns. Once the owning subsystem is up it calls
 * `armBootSignalHandler`, which installs the real handler AND replays a pending
 * poke exactly once. The signal is therefore never fatal and never lost.
 *
 * The guard is installed as a module-scope side effect so that merely importing
 * this file reserves both signals; `installBootSignalGuards()` is exported as
 * an idempotent, explicit call for the one site that must not depend on import
 * ordering (`main.ts`) and for tests.
 *
 * NOTE ON THE RESIDUAL WINDOW: ESM evaluates the import graph before any module
 * body, and part of that graph awaits (e.g. the auth procedure's token-file
 * load). A signal arriving inside those few milliseconds still finds no
 * handler. Closing that would need a wrapper process; what is closed here is
 * the multi-second ladder, which is the window the race actually lands in.
 */

/** The two signals CeraUI drives as IPC pokes. Both default to terminate. */
export const BOOT_GUARDED_SIGNALS = ["SIGUSR1", "SIGUSR2"] as const;

export type BootGuardedSignal = (typeof BOOT_GUARDED_SIGNALS)[number];

export type BootSignalHandler = () => void;

/** The process surface this module needs; injectable so tests never signal the runner. */
export interface BootSignalTarget {
	on(signal: BootGuardedSignal, listener: () => void): unknown;
}

interface GuardState {
	installed: boolean;
	readonly pending: Set<BootGuardedSignal>;
	readonly armed: Map<BootGuardedSignal, BootSignalHandler>;
}

const state: GuardState = {
	installed: false,
	pending: new Set<BootGuardedSignal>(),
	armed: new Map<BootGuardedSignal, BootSignalHandler>(),
};

function dispatch(signal: BootGuardedSignal): void {
	const handler = state.armed.get(signal);
	if (handler === undefined) {
		// The owning subsystem is still booting. Remember the poke; the arm
		// call replays it. A Set, so a signal storm costs exactly one replay.
		state.pending.add(signal);
		return;
	}
	handler();
}

/**
 * Reserve every guarded signal so its default terminate disposition can never
 * apply. Idempotent: repeat calls do nothing, so import-order and the explicit
 * `main.ts` call cannot double-register listeners.
 */
export function installBootSignalGuards(
	target: BootSignalTarget = process,
): void {
	if (state.installed) return;
	state.installed = true;
	for (const signal of BOOT_GUARDED_SIGNALS) {
		target.on(signal, () => dispatch(signal));
	}
}

/**
 * Install the real handler for `signal` and replay a poke that arrived while
 * the subsystem was still booting.
 *
 * The replay is deliberately synchronous and happens exactly once: the pending
 * flag is cleared BEFORE the handler runs, so a handler that itself signals (or
 * throws) cannot re-enter or strand the flag.
 */
export function armBootSignalHandler(
	signal: BootGuardedSignal,
	handler: BootSignalHandler,
): void {
	state.armed.set(signal, handler);
	if (!state.pending.delete(signal)) return;
	handler();
}

/** True once `installBootSignalGuards` has reserved the signals. */
export function bootSignalGuardsInstalled(): boolean {
	return state.installed;
}

/** True while `signal` has been poked but its owner has not armed yet. */
export function bootSignalPending(signal: BootGuardedSignal): boolean {
	return state.pending.has(signal);
}

/** Test seam — drops all guard state so a suite can re-drive the boot sequence. */
export function resetBootSignalGuardsForTest(): void {
	state.installed = false;
	state.pending.clear();
	state.armed.clear();
}

// Module-scope reservation: importing this file is enough to make the signals
// survivable, so a future refactor that drops the explicit call in `main.ts`
// degrades to "reserved a little later" rather than back to "fatal".
installBootSignalGuards();
