import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import util from "node:util";

import { logger } from "./logger.ts";

export const execP = util.promisify(exec);
export const execFileP = util.promisify(execFile);

// Promise-based exec(), but without rejections
export async function execPNR(cmd: string) {
	try {
		const res = await execP(cmd);
		return { stdout: res.stdout, stderr: res.stderr, code: 0 };
	} catch (_err) {
		return { stdout: "", stderr: "", code: 1 };
	}
}

export function checkExecPathSafe(path: string) {
	try {
		fs.accessSync(path, fs.constants.R_OK);
		return true;
	} catch (_err) {
		logger.error(
			`\n\n${path} not found, double check the settings in setup.json`,
		);
		return false;
	}
}

export function checkExecPath(path: string) {
	if (!checkExecPathSafe(path)) process.exit(1);
}
