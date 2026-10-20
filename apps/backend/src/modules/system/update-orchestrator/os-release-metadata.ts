import { closeSync, lstatSync, readlinkSync } from "node:fs";
import {
	openStoredStateDirectory,
	readStoredStateFile,
	STORED_STATE_LIMITS,
	StoredStateReadError,
} from "./stored-state-file.ts";

export async function readOsReleaseMetadata(): Promise<string | null> {
	let parent: number;
	try {
		parent = openStoredStateDirectory("/etc");
	} catch (cause) {
		if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
			return null;
		throw new StoredStateReadError("read_failed", { cause });
	}
	try {
		const entry = `/proc/self/fd/${parent}/os-release`;
		let linked = false;
		try {
			linked = lstatSync(entry).isSymbolicLink();
		} catch (cause) {
			if (
				!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
			)
				throw cause;
		}
		if (!linked)
			return await readStoredStateFile(
				"/etc/os-release",
				STORED_STATE_LIMITS.settings,
			);
		const link = readlinkSync(entry);
		if (link !== "../usr/lib/os-release" && link !== "/usr/lib/os-release")
			throw new StoredStateReadError("read_failed");
		// Never follow the inspected link: read only the fixed, independently anchored target.
		const metadata = await readStoredStateFile(
			"/usr/lib/os-release",
			STORED_STATE_LIMITS.settings,
		);
		if (metadata === null) throw new StoredStateReadError("read_failed");
		return metadata;
	} catch (cause) {
		if (cause instanceof StoredStateReadError) throw cause;
		throw new StoredStateReadError("read_failed", { cause });
	} finally {
		closeSync(parent);
	}
}
