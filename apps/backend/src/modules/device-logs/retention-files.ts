import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const legacy = [
	"debug.log",
	"debug1.log",
	"debug2.log",
	"debug3.log",
	"debug4.log",
	"debug5.log",
] as const;

export async function journalDirectoryBytes(
	path = "/var/log/journal",
): Promise<number | null> {
	try {
		let total = 0;
		for (const entry of await readdir(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				const bytes = await journalDirectoryBytes(child);
				if (bytes === null) return null;
				total += bytes;
			} else if (entry.isFile()) total += (await stat(child)).size;
		}
		return total;
	} catch {
		return null;
	}
}

export async function legacyDebugBytes(dir = process.cwd()): Promise<number> {
	let total = 0;
	for (const name of legacy) {
		try {
			const file = await stat(join(dir, name));
			if (file.isFile()) total += file.size;
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
	}
	return total;
}

export async function deleteLegacyDebugFiles(
	dir = process.cwd(),
): Promise<void> {
	for (const name of legacy) {
		try {
			await unlink(join(dir, name));
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
	}
}
