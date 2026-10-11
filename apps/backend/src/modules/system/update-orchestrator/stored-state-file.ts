import { constants } from "node:fs";
import { open } from "node:fs/promises";

export class StoredStateReadError extends Error {
	override readonly name = "StoredStateReadError";
	constructor(readonly reason: "not_regular_file") {
		super(reason);
	}
}

export async function readStoredStateFile(
	path: string,
): Promise<string | null> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return null;
		throw error;
	}
	try {
		if (!(await handle.stat()).isFile())
			throw new StoredStateReadError("not_regular_file");
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}
