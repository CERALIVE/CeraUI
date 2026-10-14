import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile, readlink } from "node:fs/promises";
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
export type SysextStepEvidence =
	| { readonly unit: string }
	| { readonly units: readonly string[] };

const operations = new AsyncLocalStorage<SysextOperation>();
const activeOperations = new Set<symbol>();
const SYSEXT_ACTORS = new Set(["ceralive-addon-helper", "systemd-sysext"]);
type ProcIo = {
	readonly read: (file: string) => Promise<string>;
	readonly list: (dir: string) => Promise<readonly string[]>;
	readonly link: (file: string) => Promise<string>;
};
const hostProcIo: ProcIo = {
	read: (file) => readFile(file, "utf8"),
	list: (dir) => readdir(dir),
	link: (file) => readlink(file),
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
 * a consistent visible census proves actor retirement. Vanished reads require
 * re-enumeration; renamed sysext workers retain their kernel executable identity.
 * Permission/I/O failures are unknown, never absence.
 */
export async function probeSysextActors(
	_scope: unknown,
	signal: AbortSignal,
): Promise<ServiceCompletion> {
	try {
		if ((await procIo.read(path.join(procRoot, "1", "cmdline"))).length === 0)
			return "unknown";
		let entries = (await procIo.list(procRoot)).filter((pid) =>
			/^\d+$/.test(pid),
		);
		for (let pass = 0; pass < 4; pass++) {
			if (!entries.includes("1")) return "unknown";
			let vanished = false;
			const read = new Set<string>();
			for (const entry of entries) {
				if (signal.aborted) return "unknown";
				try {
					const cmdline = await procIo.read(
						path.join(procRoot, entry, "cmdline"),
					);
					if (entry === "1" && cmdline.length === 0) return "unknown";
					let exe: string;
					try {
						exe = await procIo.link(path.join(procRoot, entry, "exe"));
					} catch (error) {
						if (!observationAbsent(error, "process")) return "unknown";
						if (cmdline.length !== 0) throw error;
						const stat = await procIo.read(path.join(procRoot, entry, "stat"));
						const fields = /^\d+ \(.*\) ([A-Z]) (.*)$/.exec(stat);
						const flags = fields?.[2]?.split(" ")[5];
						if (!fields || !flags || !/^\d+$/.test(flags)) return "unknown";
						if (fields[1] !== "Z" && (Number(flags) & 0x00200000) === 0)
							return "unknown";
						exe = "";
					}
					if (
						path.basename(exe.replace(/ \(deleted\)$/, "")) ===
							"systemd-sysext" ||
						SYSEXT_ACTORS.has(executableIdentity(cmdline.split("\0")))
					)
						return "in-flight";
					read.add(entry);
				} catch (error) {
					if (!observationAbsent(error, "process")) return "unknown";
					vanished = true;
				}
			}
			const next = (await procIo.list(procRoot)).filter((pid) =>
				/^\d+$/.test(pid),
			);
			if (
				!signal.aborted &&
				!vanished &&
				next.includes("1") &&
				next.every((pid) => read.has(pid))
			)
				return "completed";
			entries = next;
		}
	} catch {
		return "unknown";
	}
	return "unknown";
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
					unit:
						evidence && "unit" in evidence ? evidence.unit : `sysext:${name}`,
					owner: operation.id,
					decision: () =>
						getDisruptiveActionDecision(
							inherited ? { heldBy: operation.id } : undefined,
						),
					positiveFailure: isRefusal,
				},
				probeOverride ??
					(evidence && "unit" in evidence
						? probeServiceCompletion
						: async (scope, signal) => {
								const actors = await probeSysextActors(scope, signal);
								if (actors !== "completed") return actors;
								for (const unit of evidence?.units ?? []) {
									const result = await probeServiceCompletion(
										{ ...scope, unit },
										signal,
									);
									if (result !== "completed") return result;
								}
								return "completed";
							}),
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
