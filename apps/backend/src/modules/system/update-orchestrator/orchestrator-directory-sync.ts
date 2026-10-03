import { closeSync, constants, fsyncSync, openSync } from "node:fs";
import { dirname } from "node:path";

export function syncOrchestratorDirectory(filePath: string): void {
	const parent = openSync(
		dirname(filePath),
		constants.O_RDONLY | constants.O_DIRECTORY,
	);
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}
