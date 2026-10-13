import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DisruptiveActionRefusedError } from "../system/disruptive-action-error.ts";
import type { DisruptiveActionDecision } from "../system/disruptive-action-gate.ts";
import { DisruptiveActionRefusal } from "../system/disruptive-action-reservation.ts";
import type {
	ServiceCompletion,
	ServiceCompletionProbe,
} from "../system/disruptive-service-reservation.ts";
import { observationAbsent } from "../system/update-orchestrator/os-stage-read-errors.ts";

export type SysextOperation = {
	readonly id: symbol;
	readonly name: string;
};

/** A unit step names the unit whose job and lifecycle settle it. */
export type SysextStepEvidence = { readonly unit: string };

const operations = new AsyncLocalStorage<SysextOperation>();
const activeOperations = new Set<symbol>();
const SYSEXT_ACTORS = new Set(["ceralive-addon-helper", "systemd-sysext"]);
type ProcIo = {
	readonly read: (file: string) => Promise<string>;
	readonly list: (dir: string) => Promise<readonly string[]>;
};
const hostProcIo: ProcIo = {
	read: (file) => readFile(file, "utf8"),
	list: (dir) => readdir(dir),
};
let procRoot = "/proc";
let procIo = hostProcIo;
let probeOverride: ServiceCompletionProbe | undefined;

export function currentSysextOperation(): SysextOperation | undefined {
	const operation = operations.getStore();
	return operation && activeOperations.has(operation.id)
		? operation
		: undefined;
}

export function outsideSysextOperation<T>(callback: () => T): T {
	return operations.exit(callback);
}

export async function getSysextActionDecision(): Promise<DisruptiveActionDecision> {
	const { getDisruptiveActionDecision } = await import(
		"../system/disruptive-action-runtime.ts"
	);
	const current = currentSysextOperation();
	return getDisruptiveActionDecision(
		current ? { heldBy: current.id } : undefined,
	);
}

// sudo options that consume the following argument (sudo(8)).
const SUDO_VALUE_OPTIONS = new Set([
	"-C",
	"-D",
	"-R",
	"-T",
	"-U",
	"-g",
	"-h",
	"-p",
	"-r",
	"-t",
	"-u",
	"--chdir",
	"--chroot",
	"--close-from",
	"--command-timeout",
	"--group",
	"--host",
	"--other-user",
	"--prompt",
	"--role",
	"--type",
	"--user",
]);
const SCRIPT_INTERPRETERS = new Set(["bash", "dash", "sh"]);

/**
 * The command a process row runs: argv[0], the target of `sudo`/`env`, or the
 * script an interpreter was handed (`#!/usr/bin/env bash` leaves
 * `bash /usr/sbin/ceralive-addon-helper ...`). Argument text is never identity,
 * so `journalctl -u systemd-sysext` is an observer, not an actor.
 */
export function executableIdentity(argv: readonly string[]): string {
	let index = 0;
	for (;;) {
		const name = path.basename(argv[index] ?? "");
		if (name === "sudo" || name === "env") {
			index++;
			for (let arg = argv[index]; arg !== undefined; arg = argv[index]) {
				if (arg === "--") {
					index++;
					break;
				}
				if (!arg.startsWith("-") && !(name === "env" && arg.includes("=")))
					break;
				index += name === "sudo" && SUDO_VALUE_OPTIONS.has(arg) ? 2 : 1;
			}
			continue;
		}
		const script = argv[index + 1];
		return SCRIPT_INTERPRETERS.has(name) &&
			script !== undefined &&
			!script.startsWith("-")
			? path.basename(script)
			: name;
	}
}

/**
 * Helper and refresh steps are direct sudo processes, not units, and a killed
 * helper can leave a systemd-sysext descendant running. They complete only when
 * a process table that visibly includes PID 1 holds no helper or sysext process.
 * A row that vanished (ENOENT/ESRCH) is absent; any other unreadable row, an
 * empty or unreadable PID 1, or an unlistable table proves nothing.
 */
export async function probeSysextActors(
	_scope: unknown,
	signal: AbortSignal,
): Promise<ServiceCompletion> {
	let entries: readonly string[];
	try {
		if ((await procIo.read(path.join(procRoot, "1", "cmdline"))).length === 0)
			return "unknown";
		entries = await procIo.list(procRoot);
	} catch {
		return "unknown";
	}
	for (const entry of entries) {
		if (signal.aborted) return "unknown";
		if (!/^\d+$/.test(entry)) continue;
		let argv: string[];
		try {
			argv = (await procIo.read(path.join(procRoot, entry, "cmdline"))).split(
				"\0",
			);
		} catch (error) {
			if (observationAbsent(error, "process")) continue;
			return "unknown";
		}
		if (SYSEXT_ACTORS.has(executableIdentity(argv))) return "in-flight";
	}
	return signal.aborted ? "unknown" : "completed";
}

export function setSysextEvidenceForTest(options?: {
	readonly procRoot?: string;
	readonly procIo?: ProcIo;
	readonly probe?: ServiceCompletionProbe;
}): void {
	procRoot = options?.procRoot ?? "/proc";
	procIo = options?.procIo ?? hostProcIo;
	probeOverride = options?.probe;
}

const isRefusal = (error: unknown): boolean =>
	error instanceof DisruptiveActionRefusedError ||
	error instanceof DisruptiveActionRefusal;

// The still-active operation owns one service-lifetime reservation. Nested
// steps re-enter it by depth; only the outermost release reopens admission.
// A descendant of a released operation never mints a fresh owner.
export async function runDisruptiveSysextStep<T>(
	name: string,
	effect: () => Promise<T>,
	evidence?: SysextStepEvidence,
): Promise<T> {
	const [
		{ getDisruptiveActionDecision },
		{ probeServiceCompletion, withServiceReservation },
	] = await Promise.all([
		import("../system/disruptive-action-runtime.ts"),
		import("../system/disruptive-service-reservation.ts"),
	]);
	const inherited = currentSysextOperation();
	if (!inherited && operations.getStore() !== undefined)
		throw new DisruptiveActionRefusedError("update_in_progress");
	const operation = inherited ?? { id: Symbol(name), name };
	if (!inherited) activeOperations.add(operation.id);
	let entered = false;
	try {
		return await operations.run(operation, () =>
			withServiceReservation(
				() => {
					entered = true;
					return effect();
				},
				{
					unit: evidence?.unit ?? `sysext:${name}`,
					owner: operation.id,
					decision: () =>
						getDisruptiveActionDecision(
							inherited ? { heldBy: operation.id } : undefined,
						),
					positiveFailure: isRefusal,
				},
				probeOverride ??
					(evidence ? probeServiceCompletion : probeSysextActors),
			),
		);
	} catch (error) {
		if (!entered && error instanceof DisruptiveActionRefusal)
			throw new DisruptiveActionRefusedError(error.reason);
		throw error;
	} finally {
		if (!inherited) activeOperations.delete(operation.id);
	}
}
