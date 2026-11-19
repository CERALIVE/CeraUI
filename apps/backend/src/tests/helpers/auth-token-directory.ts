import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The production token store resolves its relative file path on every operation. */
export function authTokenDirectory(): Disposable {
	const cwd = process.cwd();
	const directory = mkdtempSync(join(tmpdir(), "logs-auth-"));
	process.chdir(directory);
	return {
		[Symbol.dispose]() {
			process.chdir(cwd);
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
