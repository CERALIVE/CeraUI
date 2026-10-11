import type { UplinkCandidate, UplinkKind } from "./core.ts";

type InventoryRow = {
	readonly type: string;
	readonly state: string;
	readonly metered: string;
};

function readInventory(
	nmcli: string,
): ReadonlyMap<string, InventoryRow> | null {
	const rows = new Map<string, InventoryRow>();
	for (const block of nmcli.trim().split(/\r?\n\s*\r?\n/)) {
		if (block.startsWith("GENERAL.")) {
			const fields = new Map<string, string>();
			for (const line of block.split(/\r?\n/)) {
				const at = line.indexOf(":");
				const key = line.slice(0, at);
				if (
					at < 1 ||
					!/^GENERAL\.(?:DEVICE|TYPE|STATE|METERED)$/.test(key) ||
					fields.has(key)
				)
					return null;
				fields.set(key, line.slice(at + 1));
			}
			const ifname = fields.get("GENERAL.DEVICE");
			const type = fields.get("GENERAL.TYPE");
			const state = fields.get("GENERAL.STATE");
			if (!ifname || !type || !state || rows.has(ifname)) return null;
			rows.set(ifname, {
				type,
				state,
				metered: fields.get("GENERAL.METERED") ?? "unknown",
			});
		} else {
			for (const line of block.split(/\r?\n/)) {
				const match =
					/^([^:]+):([^:]+):([^:]+)(?::(?:GENERAL.METERED:)?([^:]+))?$/.exec(
						line,
					);
				const ifname = match?.[1];
				const type = match?.[2];
				const state = match?.[3];
				if (!ifname || !type || !state || rows.has(ifname)) return null;
				rows.set(ifname, { type, state, metered: match?.[4] ?? "unknown" });
			}
		}
	}
	return rows;
}

export function discoverCandidates(
	ifnames: readonly string[],
	nmcli: string,
	mmIfnames: readonly string[],
	routerIfnames: readonly string[],
	dongleIfnames: readonly string[] = [],
): UplinkCandidate[] {
	const rows = readInventory(nmcli);
	if (!rows) return [];
	return ifnames.flatMap((ifname) => {
		const row = rows.get(ifname);
		if (!row || !/^(?:100\s*\(connected|connected)/.test(row.state)) return [];
		const cellular =
			mmIfnames.includes(ifname) ||
			routerIfnames.includes(ifname) ||
			row.type === "gsm";
		const metered =
			cellular || /^(?:yes|guess-yes|yes \(guessed\))$/i.test(row.metered)
				? true
				: /^(?:no|guess-no|no \(guessed\))$/i.test(row.metered)
					? false
					: null;
		const kind: UplinkKind =
			cellular || metered === true
				? "cellular"
				: dongleIfnames.includes(ifname)
					? "dongle"
					: row.type === "wifi"
						? "wifi"
						: row.type === "ethernet"
							? "ethernet"
							: "other";
		return [{ ifname, kind, metered }];
	});
}
