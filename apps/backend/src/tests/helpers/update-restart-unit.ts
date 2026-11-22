import { spawn } from "node:child_process";
import {
	appendFile,
	open,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import {
	prepareSoftwareUpdateOutput,
	readSoftwareUpdateAttempt,
	SOFTWARE_UPDATE_OUTPUT_READ_BYTES,
	softwareUpdateOutputPaths,
	updateSoftwareUpdateAttempt,
} from "../../modules/system/software-update-output.ts";
import type { DetachedAptServiceDeps } from "../../modules/system/software-update-service.ts";
import { SOFTWARE_UPDATE_UNIT } from "../../modules/system/software-update-service-contract.ts";

/** Exit status of a session ended by the finished update's own restart. */
export const RESTART_EXIT_CODE = 75;

// The detached unit as PID 1 runs it: started in its own session, outside
// every backend's process tree, so it keeps running when a backend dies; each
// backend sees it only through files they all share. Its real command runs
// with apt-get pointed at the scratch directory.
export function restartTestUnit(
	scratch: string,
	o: {
		readonly failFirstStdoutRead?: boolean;
		/** A FIFO the second stdout read waits on: the test's attached-but-unread window. */
		readonly holdSecondStdoutRead?: string;
		/** Retirement always fails, as a broken `systemctl stop` would. */
		readonly failCleanup?: boolean;
		/** Retiring the first unit ever started here always fails; later ones retire. */
		readonly failCleanupOfFirst?: boolean;
	} = {},
): DetachedAptServiceDeps {
	const fixed = softwareUpdateOutputPaths();
	// One transcript for every unit, as the fixed /run files are; each unit's
	// own state by its name (the fixed name keeps the original `unit.*` files).
	const unit = `${scratch}/unit`;
	const stateOf = (name: string = SOFTWARE_UPDATE_UNIT) =>
		name === SOFTWARE_UPDATE_UNIT ? unit : `${scratch}/${name}`;
	const local = {
		stdout: `${unit}.stdout`,
		stderr: `${unit}.stderr`,
	};
	const uid = process.getuid?.() ?? 0;
	const text = (file: string) => readFile(file, "utf8").catch(() => undefined);
	let stdoutReads = 0;
	return {
		outputPaths: fixed,
		readAttempt: () => readSoftwareUpdateAttempt(local, uid),
		updateAttempt: (change) => updateSoftwareUpdateAttempt(local, change, uid),
		prepareOutput: () => prepareSoftwareUpdateOutput(local, uid),
		// The production fingerprint: which stdout file this is.
		transcript: async () => {
			const file = await stat(local.stdout, { bigint: true }).catch(
				() => undefined,
			);
			return file && `${file.ino}:${file.size}:${file.mtimeNs}`;
		},
		start: async (command) => {
			const name =
				command
					.find((arg) => arg.startsWith("--unit="))
					?.slice("--unit=".length) ?? SOFTWARE_UPDATE_UNIT;
			const state = stateOf(name);
			if ((await text(`${scratch}/first-unit`)) === undefined)
				await writeFile(`${scratch}/first-unit`, name);
			const argv = command
				.slice(command.indexOf("--") + 1)
				.map((arg) => arg.replaceAll("/usr/bin/apt-get", `${scratch}/apt-get`));
			const child = spawn(
				"/bin/bash",
				[
					"-c",
					's="$1"; shift; "$@" >>"$0.stdout" 2>>"$0.stderr"; echo "$?" >"$s.exit.part" && mv "$s.exit.part" "$s.exit"',
					unit,
					state,
					...argv,
				],
				{
					detached: true,
					stdio: "ignore",
					// systemd puts the unit's --setenv assignments over its own environment.
					env: {
						...process.env,
						...Object.fromEntries(
							command
								.slice(0, command.indexOf("--"))
								.filter((arg) => arg.startsWith("--setenv="))
								.map((arg) => arg.slice("--setenv=".length).split("=", 2)),
						),
					},
				},
			);
			child.unref();
			await writeFile(`${state}.pid`, String(child.pid));
		},
		listUnits: async () => {
			const names = (await readdir(scratch))
				.filter(
					(file) =>
						file.startsWith("ceralive-software-update-") &&
						(file.endsWith(".service.pid") || file.endsWith(".service.exit")),
				)
				.map((file) => file.slice(0, file.lastIndexOf(".")));
			const fixedLoaded =
				(await text(`${unit}.pid`)) !== undefined ||
				(await text(`${unit}.exit`)) !== undefined;
			return [
				...new Set([...(fixedLoaded ? [SOFTWARE_UPDATE_UNIT] : []), ...names]),
			];
		},
		inspect: async (name) => {
			const state = stateOf(name);
			// systemd's InvocationID: one per started unit (a fixed one for a seeded unit).
			const pid = await text(`${state}.pid`);
			const invocation = (pid ? Number(pid.trim()).toString(16) : "f").padStart(
				32,
				"0",
			);
			const exit = await text(`${state}.exit`);
			if (exit !== undefined) {
				const exitCode = Number(exit.trim());
				return {
					kind: "finished",
					exitCode,
					cleanup: exitCode === 0 ? "stop" : "reset-failed",
					invocation,
				};
			}
			return pid === undefined
				? { kind: "absent" }
				: { kind: "running", invocation };
		},
		cleanup: async (_state, name = SOFTWARE_UPDATE_UNIT) => {
			// Every retirement names its target: the test reads whom each one reached.
			await appendFile(`${scratch}/cleanups.log`, `${name}\n`);
			if (o.failCleanup) throw new Error("systemctl stop failed");
			if (
				o.failCleanupOfFirst &&
				(await text(`${scratch}/first-unit`)) === name
			)
				throw new Error("systemctl stop failed");
			await rm(`${stateOf(name)}.exit`, { force: true });
			await rm(`${stateOf(name)}.pid`, { force: true });
		},
		readOutput: async (file, offset) => {
			if (file === fixed.stdout && o.failFirstStdoutRead) {
				stdoutReads++;
				if (stdoutReads === 1)
					throw new Error("EIO: injected first read failure");
				if (stdoutReads === 2 && o.holdSecondStdoutRead)
					await readFile(o.holdSecondStdoutRead, "utf8");
			}
			const path = file === fixed.stdout ? local.stdout : local.stderr;
			const handle = await open(path, "r");
			try {
				const bytes = new Uint8Array(SOFTWARE_UPDATE_OUTPUT_READ_BYTES);
				const { bytesRead } = await handle.read(
					bytes,
					0,
					bytes.byteLength,
					offset,
				);
				return {
					bytes: bytes.subarray(0, bytesRead),
					nextOffset: offset + bytesRead,
				};
			} finally {
				await handle.close();
			}
		},
		sleep: (milliseconds) => Bun.sleep(milliseconds),
	};
}
