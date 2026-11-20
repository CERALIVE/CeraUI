import { nmConnsGet, nmcliParseSep } from "../network/network-manager.ts";
import type { HotspotActivationDeps } from "./wifi-hotspot-types.ts";

export type NmActivationReceipt = {
	readonly path: string;
	readonly runId: string;
};

export async function nmDisconnectActivation(
	uuid: string,
	activation: NmActivationReceipt | undefined,
	deps: Pick<HotspotActivationDeps, "readProfileInstance" | "nmDisconnect">,
): Promise<boolean> {
	if (!activation) return false;
	const currentRunId = (await deps.readProfileInstance(uuid))?.runId;
	if (currentRunId === activation.runId)
		return deps.nmDisconnect(uuid, activation.path);
	const activity = await readHotspotProfileActivity(uuid);
	return activity === "inactive" || activity === "absent";
}

/** Absence is evidence only from a complete, unambiguous inventory. */
export async function readHotspotProfileActivity(uuid: string) {
	const rows = await nmConnsGet("uuid,active");
	if (!rows) return "unknown";
	let activity: "absent" | "inactive" | "active" = "absent";
	for (const raw of rows) {
		if (!raw) continue;
		const [id, active, extra] = nmcliParseSep(raw);
		if (!id || extra !== undefined || (active !== "yes" && active !== "no"))
			return "unknown";
		if (id !== uuid) continue;
		if (activity !== "absent") return "unknown";
		activity = active === "yes" ? "active" : "inactive";
	}
	return activity;
}
