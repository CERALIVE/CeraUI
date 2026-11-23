import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The external NM model preserves files across daemon/backend restarts. */
export function firstApKeyfiles(
	contents: (uuid: string) => string = (uuid) => uuid,
) {
	const root = mkdtempSync(join(tmpdir(), "first-ap-keyfiles-"));
	const files = new Map<string, string>();
	let serial = 0;
	const write = (uuid: string) => {
		const filename = files.get(uuid) ?? join(root, `${uuid}.nmconnection`);
		const temporary = join(root, `write-${++serial}`);
		writeFileSync(temporary, contents(uuid), { mode: 0o600 });
		renameSync(temporary, filename);
		files.set(uuid, filename);
	};
	return {
		write,
		filename: (uuid: string) => {
			if (!files.has(uuid)) write(uuid);
			return files.get(uuid) ?? "";
		},
		restore: (snapshot: readonly string[][]) => {
			for (const [uuid, filename] of snapshot)
				if (uuid && filename) files.set(uuid, filename);
		},
		close: () => rmSync(root, { recursive: true, force: true }),
	};
}
