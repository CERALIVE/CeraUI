import { OS_UPDATE_STATE_DIR } from "./os-manifest.ts";
import { storedStateEntryPresent } from "./stored-state-file.ts";

export async function readActivationArmed(
	path = `${OS_UPDATE_STATE_DIR}/activation-armed`,
): Promise<boolean> {
	return storedStateEntryPresent(path);
}
