import {
	nmConnsGet,
	nmcliParseSep,
	nmDisconnect,
	readNmDeviceActivation,
} from "../network/network-manager.ts";
import { nmRunId } from "../network/network-manager-profile-instance.ts";

export type NmActivationReceipt = {
	readonly path: string;
	readonly runId: string;
	readonly ifname: string;
};

/** Only the selected device can attest its activation; the inventory cannot. */
export async function observeHotspotActivation(uuid: string, ifname: string) {
	const runId = await nmRunId();
	if (!runId) return undefined;
	const active = await readNmDeviceActivation(ifname);
	if (active?.uuid !== uuid || !active.path || (await nmRunId()) !== runId)
		return undefined;
	return { path: active.path, runId, ifname, connected: active.connected };
}

export async function nmDisconnectActivation(
	uuid: string,
	activation: NmActivationReceipt | undefined,
	deps: { readonly nmDisconnect: typeof nmDisconnect } = { nmDisconnect },
	permit?: () => Promise<boolean>,
): Promise<boolean> {
	if (!activation) return false;
	if (permit && !(await permit())) return false;
	const currentRunId = await nmRunId();
	if (currentRunId === activation.runId)
		return deps.nmDisconnect(
			uuid,
			activation.path,
			activation.runId,
			activation.ifname,
		);
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
