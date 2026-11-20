import { nmConnsGet, nmcliParseSep } from "../network/network-manager.ts";

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
