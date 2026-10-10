import { chmod } from "node:fs/promises";
import { join } from "node:path";

export const shippedOsStageGuard = join(
	import.meta.dir,
	"../../../../../deployment/ceralive-os-stage-guard",
);

export async function createTestOsStageGuard(
	root: string,
	directory: string,
	uid = process.getuid?.() ?? -1,
): Promise<string> {
	const source = await Bun.file(shippedOsStageGuard).text();
	const lines = source.split("\n");
	const directoryLine = "directory=/run/ceralive/os-stage";
	const ownerLine = "owner=0";
	if (
		lines.filter((line) => line === directoryLine).length !== 1 ||
		lines.filter((line) => line === ownerLine).length !== 1
	)
		throw new Error("guardian production constants are not unique");
	const copy = lines
		.map((line) => {
			if (line === directoryLine)
				return `directory='${directory.replaceAll("'", "'\\''")}'`;
			if (line === ownerLine) return `owner=${uid}`;
			return line;
		})
		.join("\n");
	const path = join(root, "test-os-stage-guard");
	await Bun.write(path, copy);
	await chmod(path, 0o700);
	return path;
}
