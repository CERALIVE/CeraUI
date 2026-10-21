import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
	openStoredStateDirectory,
	readStoredStateDescriptor,
} from "./stored-state-file.ts";

export type PublicCredentialFile = {
	readonly bytes: Buffer;
	readonly identity: string;
};

export class CredentialPublicFileError extends Error {
	constructor(readonly reason: "unsafe-file" | "changed") {
		super(reason);
	}
}

export function readPublicCredentialFile(
	path: string,
	limit: number,
): PublicCredentialFile {
	const parent = openStoredStateDirectory(dirname(path), true);
	try {
		const anchored = `/proc/self/fd/${parent}/${basename(path)}`;
		const fd = openSync(
			anchored,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const info = fstatSync(fd, { bigint: true });
			const uid = BigInt(process.getuid?.() ?? 0);
			if ((info.uid !== 0n && info.uid !== uid) || (info.mode & 0o022n) !== 0n)
				throw new CredentialPublicFileError("unsafe-file");
			const bytes = readStoredStateDescriptor(fd, limit);
			const named = lstatSync(anchored, { bigint: true });
			const identity = (s: typeof info) =>
				`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
			if (identity(named) !== identity(info))
				throw new CredentialPublicFileError("changed");
			return { bytes, identity: identity(info) };
		} finally {
			closeSync(fd);
		}
	} finally {
		closeSync(parent);
	}
}
