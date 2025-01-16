import { exec, execFile } from "node:child_process";
import fs from "node:fs";
import util from "node:util";

export const execP = util.promisify(exec);
export const execFileP = util.promisify(execFile);

// Promise-based exec(), but without rejections
export async function execPNR(cmd: string) {
	try {
		const res = await execP(cmd);
		return { stdout: res.stdout, stderr: res.stderr, code: 0 };
	} catch (err) {
		return { stdout: "", stderr: "", code: 1 };
	}
}

export function checkExecPath(path: string) {
	try {
		fs.accessSync(path, fs.constants.R_OK);
	} catch (err) {
		console.log(
			`\n\n${path} not found, double check the settings in setup.json`,
		);
		process.exit(1);
	}
}
