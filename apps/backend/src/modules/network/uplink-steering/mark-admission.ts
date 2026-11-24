import { type ClientZone, UPLINK_MARK_MASK } from "./contracts.ts";
import type { MarkClaim } from "./mark-journal.ts";

export const MARK_GUARD = "ceralive_share_guard";
export const receiptName = (seq: number) => `assignment_${seq}`;
const epochMask = Array.from({ length: 32 }, (_, index) => index + 96).join(
	" | ",
);

export interface MarkAdmission {
	readonly seq: number;
	readonly phase: "committed" | "fenced";
	readonly zones: readonly ClientZone[];
	readonly claims: readonly MarkClaim[];
}

export function epochBits(epoch: number): string {
	return Array.from({ length: 32 }, (_, bit) => bit)
		.filter((bit) => ((epoch >>> bit) & 1) !== 0)
		.map((bit) => bit + 96)
		.join(" | ");
}

function assertZone(zone: ClientZone): void {
	if (
		!/^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}$/.test(zone.ifname) ||
		!/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/.test(zone.ipv4Cidr)
	) {
		throw new Error("invalid steering guard zone");
	}
}

export function buildMarkGuard(admission: MarkAdmission): string {
	const zones = new Map(
		admission.zones.map((zone) => [`${zone.ifname}/${zone.ipv4Cidr}`, zone]),
	);
	const lines = [
		`add table inet ${MARK_GUARD}`,
		`delete table inet ${MARK_GUARD}`,
		`table inet ${MARK_GUARD} {`,
		`\tchain ${admission.phase === "committed" ? receiptName(admission.seq) : `fenced_${admission.seq}`} { }`,
		"\tchain egress {",
		"\t\ttype filter hook postrouting priority mangle; policy accept;",
	];
	for (const { ifname, ipv4Cidr } of zones.values()) {
		assertZone({ ifname, ipv4Cidr });
		const scope = `iifname "${ifname}" ip saddr ${ipv4Cidr}`;
		for (const claim of admission.claims) {
			const mark = `0x${claim.mark.toString(16)}`;
			const label =
				claim.epoch === 0
					? ""
					: ` ct label & (${epochMask}) == (${epochBits(claim.epoch)})`;
			lines.push(
				`\t\t${scope} meta mark & 0x${UPLINK_MARK_MASK.toString(16)} == ${mark} meta oif ${claim.ifindex}${label} accept`,
			);
		}
		lines.push(`\t\t${scope} drop`);
	}
	lines.push("\t}", "}", "");
	return lines.join("\n");
}
