import {
	nmConnDelete,
	nmConnsGet,
	nmcliParseSep,
	nmDisconnect,
	readNmDeviceActivation,
} from "../network/network-manager.ts";
import { nmProfileFileStillMatches } from "../network/network-manager-profile-file.ts";
import {
	type NmProfileInstance,
	nmRunId,
	sameNmProfileActivation,
} from "../network/network-manager-profile-instance.ts";

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
	current?: () => boolean,
): Promise<boolean> {
	if (!activation) return false;
	if (permit && !(await permit())) return false;
	const currentRunId = await nmRunId();
	if (currentRunId === activation.runId) {
		if (current)
			return deps.nmDisconnect(
				uuid,
				activation.path,
				activation.runId,
				activation.ifname,
				current,
			);
		return deps.nmDisconnect(
			uuid,
			activation.path,
			activation.runId,
			activation.ifname,
		);
	}
	const activity = await readHotspotProfileActivity(uuid);
	return activity === "inactive" || activity === "absent";
}

/** Absence is evidence only from a complete, unambiguous inventory. */
export async function readHotspotProfileActivity(
	uuid: string,
	settingsPath?: string,
) {
	const rows = await nmConnsGet(
		settingsPath ? "uuid,active,dbus-path" : "uuid,active",
	);
	if (!rows) return "unknown";
	let activity: "absent" | "inactive" | "active" = "absent";
	for (const raw of rows) {
		if (!raw) continue;
		const [id, active, path, extra] = nmcliParseSep(raw);
		if (
			!id ||
			extra !== undefined ||
			(settingsPath
				? !path?.match(/^\/org\/freedesktop\/NetworkManager\/Settings\/\d+$/)
				: path !== undefined) ||
			(active !== "yes" && active !== "no")
		)
			return "unknown";
		if (id !== uuid) {
			if (settingsPath && path === settingsPath) return "unknown";
			continue;
		}
		if (activity !== "absent" || (settingsPath && path !== settingsPath))
			return "unknown";
		activity = active === "yes" ? "active" : "inactive";
	}
	return activity;
}

/** Re-prove the exact inactive object, then dispatch exclusively by settings path. */
export async function deleteInactiveHotspotProfile(
	uuid: string,
	target: NmProfileInstance | null | undefined,
	read: (uuid: string) => Promise<NmProfileInstance | null | undefined>,
	stillOwned: () => boolean,
	remove = nmConnDelete,
): Promise<boolean> {
	if (!target?.runId || !target.file || !stillOwned()) return false;
	const file = target.file;
	try {
		if ((await readHotspotProfileActivity(uuid, target.path)) !== "inactive")
			return false;
		if (!sameNmProfileActivation(target, await read(uuid))) return false;
		if ((await readHotspotProfileActivity(uuid, target.path)) !== "inactive")
			return false;
		if ((await nmRunId()) !== target.runId) return false;
		const current = () => nmProfileFileStillMatches(file) && stillOwned();
		// The original daemon is pinned at dispatch. It offers no atomic inactive-only delete.
		return (
			current() && (await remove(uuid, target.path, target.runId, current))
		);
	} catch (error: unknown) {
		if (error instanceof Error) return false;
		throw error;
	}
}
