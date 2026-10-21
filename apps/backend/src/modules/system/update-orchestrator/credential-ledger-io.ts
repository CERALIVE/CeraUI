import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { openStoredStateDirectory } from "./stored-state-file.ts";

export function saveCredentialLedger(
	path: string,
	contents: string,
	syncDirectory: (fd: number) => void = fsyncSync,
): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const parent = openStoredStateDirectory(dirname(path), true);
	const root = `/proc/self/fd/${parent}`;
	const temp = `${root}/.credential-notices-${randomUUID()}.tmp`;
	let renamed = false;
	try {
		const fd = openSync(
			temp,
			constants.O_WRONLY |
				constants.O_CREAT |
				constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
		try {
			writeFileSync(fd, contents);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, `${root}/${basename(path)}`);
		renamed = true;
		syncDirectory(parent);
	} finally {
		try {
			if (!renamed) unlinkSync(temp);
		} finally {
			closeSync(parent);
		}
	}
}
