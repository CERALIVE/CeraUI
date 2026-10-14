import type { AddonHelperStep } from "../../helpers/addon-helper-step.ts";
import type { ExecResult } from "../../helpers/exec.ts";
import {
	helperGroupRetirement,
	type SignalZero,
} from "../../helpers/helper-group-retirement.ts";

export function helperStepFixture(
	effect: () => Promise<ExecResult>,
	kill: SignalZero = () => {
		throw Object.assign(new Error("retired"), { code: "ESRCH" });
	},
): AddonHelperStep {
	let spawned = false;
	let exitCode: number | undefined;
	return {
		spawned: () => spawned,
		child: () => undefined,
		exitCode: () => exitCode,
		probe: helperGroupRetirement(
			() => (spawned ? { pgid: 42, exitCode } : undefined),
			kill,
		),
		run: async () => {
			spawned = true;
			try {
				return await effect();
			} finally {
				exitCode = 0;
			}
		},
	};
}

export function helperExecFixture(
	exec: (file: string, args: readonly string[]) => Promise<ExecResult>,
): (args: readonly string[]) => AddonHelperStep {
	return (args) =>
		helperStepFixture(() => exec("sudo", ["ceralive-addon-helper", ...args]));
}

export async function prepareHelperScriptGroup(
	dir: string,
	action: string,
	actor: string,
): Promise<void> {
	for (const sub of ["registry", "cache", "stage", "scan", "tools"])
		await mkdir(join(dir, sub));
	const raw = "finite test artifact";
	const sha256 = new Bun.CryptoHasher("sha256").update(raw).digest("hex");
	await writeFile(join(dir, "cache/test-addon.raw"), raw);
	await writeFile(
		join(dir, "cache/test-addon.raw.sig"),
		"test-only signature port",
	);
	await writeFile(
		join(dir, "registry/test-addon.json"),
		JSON.stringify({
			id: "test-addon",
			payload: { type: "sysext" },
			artifact: { sha256 },
			units: {
				unmask: ["kiosk.service"],
				enable: ["kiosk.service"],
				start: ["kiosk.service"],
			},
		}),
	);
	const barrier = `import os, signal, json\nsignal.alarm(30)\nos.mkfifo('${dir}/release')\nwith open('${dir}/worker','w') as f: json.dump({'pid':os.getpid(),'pgid':os.getpgrp(),'sid':os.getsid(0)},f)\nwith open('${dir}/release') as f: f.read()\n`;
	for (const tool of ["systemctl", "install", "rm"]) {
		const blocking =
			tool === actor
				? tool === "systemctl"
					? `if [[ "$1" == "${action === "enable" ? "start" : "stop"}" ]]; then`
					: "if true; then"
				: "if false; then";
		const fallback = tool === "systemctl" ? "exit 0" : `/usr/bin/${tool} "$@"`;
		const file = join(dir, "tools", tool);
		await writeFile(
			file,
			`#!/bin/bash\n${blocking}\nexec /usr/bin/python3 -c '${barrier.split("'").join("'\\''")}'\nfi\n${fallback}\n`,
		);
		await chmod(file, 0o700);
	}
}

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
