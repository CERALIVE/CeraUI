import { lstat } from "node:fs/promises";
import { OS_UPDATE_STATE_DIR } from "./os-manifest.ts";

export async function readActivationArmed(
	path = `${OS_UPDATE_STATE_DIR}/activation-armed`,
): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}
