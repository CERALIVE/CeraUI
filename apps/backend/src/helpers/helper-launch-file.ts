import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	unlinkSync,
} from "node:fs";
import {
	openStoredStateDirectory,
	readStoredStateDescriptor,
} from "../modules/system/update-orchestrator/stored-state-file.ts";

export const ADDON_HELPER_LAUNCHER =
	'printf "%s\\n" "$$" > "$1" || exit 125; shift; exec "$@"';
export type HelperLaunchFile = {
	readonly prepare: () => string;
	readonly read: () => Promise<string | null>;
	readonly cleanup: () => void;
};
const swept = new Set<string>();
const PID_NAME = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.pid$/;

export function createHelperLaunchFile(
	directory = "/run/ceralive/addon-launch",
	uid = 0,
): HelperLaunchFile {
	let parent: number | undefined;
	let fd: number | undefined;
	const name = `${randomUUID()}.pid`;
	return {
		prepare: () => {
			mkdirSync(directory, { recursive: true, mode: 0o700 });
			parent = openStoredStateDirectory(directory, true);
			const info = fstatSync(parent);
			if (info.uid !== uid || (info.mode & 0o777) !== 0o700)
				throw new Error("add-on launch directory must be private and owned");
			const anchored = `/proc/self/fd/${parent}`;
			// Restart clears local ownership; sweep residue before our first launch, never active files.
			if (!swept.has(directory)) {
				for (const old of readdirSync(anchored)) {
					if (PID_NAME.test(old)) {
						try {
							unlinkSync(`${anchored}/${old}`);
						} catch (cause) {
							if (!(cause instanceof Error)) throw cause;
						}
					}
				}
				swept.add(directory);
			}
			fd = openSync(
				`${anchored}/${name}`,
				constants.O_RDWR |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW |
					constants.O_NONBLOCK,
				0o600,
			);
			return `${directory}/${name}`;
		},
		read: async () => {
			if (fd === undefined)
				throw new Error("add-on launch identity was not prepared");
			return readStoredStateDescriptor(fd, 32).toString("utf8");
		},
		cleanup: () => {
			// Only delete our inode; cleanup failure must not replace the helper outcome.
			try {
				if (fd !== undefined && parent !== undefined) {
					const file = `/proc/self/fd/${parent}/${name}`;
					const current = lstatSync(file),
						owned = fstatSync(fd);
					if (current.ino === owned.ino && current.dev === owned.dev)
						unlinkSync(file);
				}
			} catch (cause) {
				if (!(cause instanceof Error)) throw cause;
			} finally {
				if (fd !== undefined) {
					closeSync(fd);
					fd = undefined;
				}
				if (parent !== undefined) {
					closeSync(parent);
					parent = undefined;
				}
			}
		},
	};
}
