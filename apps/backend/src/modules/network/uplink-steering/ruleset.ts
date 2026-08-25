import {
	CLIENT_FLOW_NAMESPACE,
	CLIENT_FLOW_NAMESPACE_MASK,
	type ClientZone,
	MAX_STEERING_UPLINKS,
	MAX_STEERING_WEIGHT,
	SHARE_TABLE,
	type ShareRulesetState,
	type SteeringUplink,
	UNOWNED_MARK_MASK,
	UPLINK_MARK_MASK,
	WEIGHT_BUCKET_MODULUS,
} from "./contracts.ts";

const IPV4_CIDR_RE =
	/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d|[12]\d|3[0-2])$/;
const SAFE_NFT_IFNAME_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]{0,14}$/;

/** Deterministic FNV-1a mark: stable across reweights and backend restarts. */
export function stableUplinkMark(identity: string): number {
	if (identity.length === 0)
		throw new Error("uplink identity must not be empty");
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(identity)) {
		hash ^= byte;
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	let slot = ((hash >>> 16) ^ hash) & 0xffff;
	if (slot === 0) slot = 1;
	return (CLIENT_FLOW_NAMESPACE | (slot << 8)) >>> 0;
}

export function buildShareRuleset(state: ShareRulesetState): string {
	const zones = [...state.clientZones].sort((a, b) =>
		a.ifname.localeCompare(b.ifname),
	);
	const uplinks = [...state.uplinks].sort((a, b) =>
		a.ifname.localeCompare(b.ifname),
	);
	validateState(zones, uplinks);

	const selectable = uplinks.filter(
		(uplink) => uplink.selectable && uplink.weight > 0,
	);
	const lines = [
		`destroy table ${SHARE_TABLE.family} ${SHARE_TABLE.name}`,
		"",
		`table ${SHARE_TABLE.family} ${SHARE_TABLE.name} {`,
	];

	if (selectable.length > 0) {
		lines.push(
			"\tmap uplink_verdicts {",
			`\t\ttypeof numgen random mod ${WEIGHT_BUCKET_MODULUS} : verdict`,
			"\t\tflags interval",
			`\t\telements = { ${renderWeightedElements(selectable)} }`,
			"\t}",
			"",
		);
		for (const [index, uplink] of selectable.entries()) {
			lines.push(
				`\tchain select_${index} {`,
				`\t\tmeta mark set (meta mark & ${hexMark(UNOWNED_MARK_MASK)}) | ${hexMark(uplink.mark)}`,
				`\t\tct mark set (ct mark & ${hexMark(UNOWNED_MARK_MASK)}) | (meta mark & ${hexMark(UPLINK_MARK_MASK)})`,
				"\t\treturn",
				"\t}",
				"",
			);
		}
	}

	lines.push(
		"\tchain prerouting {",
		"\t\ttype filter hook prerouting priority mangle; policy accept;",
	);
	for (const zone of zones) {
		lines.push(renderRestoreRule(zone));
		if (selectable.length > 0) {
			lines.push(renderSelectionRule(zone));
		}
	}
	lines.push("\t}", "", "\tchain postrouting {");
	lines.push("\t\ttype nat hook postrouting priority srcnat; policy accept;");
	for (const zone of zones) {
		for (const uplink of uplinks)
			lines.push(renderMasqueradeRule(zone, uplink));
	}
	lines.push("\t}", "}", "");
	return lines.join("\n");
}

function renderWeightedElements(uplinks: readonly SteeringUplink[]): string {
	let start = 0;
	return apportionWeightBuckets(uplinks)
		.map((buckets, index) => {
			const end = start + buckets - 1;
			const interval = start === end ? `${start}` : `${start}-${end}`;
			start = end + 1;
			return `${interval} : jump select_${index}`;
		})
		.join(", ");
}

export function apportionWeightBuckets(
	uplinks: readonly SteeringUplink[],
): number[] {
	const total = uplinks.reduce((sum, uplink) => sum + uplink.weight, 0);
	if (total <= 0) return [];
	const shares = uplinks.map((uplink, index) => {
		const scaled = uplink.weight * WEIGHT_BUCKET_MODULUS;
		return {
			index,
			buckets: Math.floor(scaled / total),
			remainder: scaled % total,
		};
	});
	let remaining =
		WEIGHT_BUCKET_MODULUS -
		shares.reduce((sum, share) => sum + share.buckets, 0);
	for (const share of [...shares].sort(
		(a, b) => b.remainder - a.remainder || a.index - b.index,
	)) {
		if (remaining === 0) break;
		share.buckets++;
		remaining--;
	}
	return shares.map((share) => share.buckets);
}

function renderRestoreRule(zone: ClientZone): string {
	return `\t\tiifname "${zone.ifname}" ip saddr ${zone.ipv4Cidr} ct state established,related ct mark & ${hexMark(CLIENT_FLOW_NAMESPACE_MASK)} == ${hexMark(CLIENT_FLOW_NAMESPACE)} meta mark set (meta mark & ${hexMark(UNOWNED_MARK_MASK)}) | (ct mark & ${hexMark(UPLINK_MARK_MASK)}) comment "restore client flow"`;
}

function renderSelectionRule(zone: ClientZone): string {
	return `\t\tiifname "${zone.ifname}" ip saddr ${zone.ipv4Cidr} ct state new ct mark & ${hexMark(CLIENT_FLOW_NAMESPACE_MASK)} != ${hexMark(CLIENT_FLOW_NAMESPACE)} numgen random mod ${WEIGHT_BUCKET_MODULUS} vmap @uplink_verdicts comment "select client uplink"`;
}

function renderMasqueradeRule(
	zone: ClientZone,
	uplink: SteeringUplink,
): string {
	return `\t\tiifname "${zone.ifname}" ip saddr ${zone.ipv4Cidr} ct mark & ${hexMark(UPLINK_MARK_MASK)} == ${hexMark(uplink.mark)} oifname "${uplink.ifname}" masquerade comment "client flow NAT"`;
}

function validateState(
	zones: readonly ClientZone[],
	uplinks: readonly SteeringUplink[],
): void {
	if (uplinks.length > MAX_STEERING_UPLINKS) {
		throw new Error(`too many steering uplinks: ${uplinks.length}`);
	}
	const marks = new Map<number, string>();
	for (const zone of zones) {
		assertIfname(zone.ifname);
		assertIpv4Cidr(zone.ipv4Cidr);
	}
	for (const uplink of uplinks) {
		assertIfname(uplink.ifname);
		if (
			!Number.isInteger(uplink.weight) ||
			uplink.weight < 0 ||
			uplink.weight > MAX_STEERING_WEIGHT
		) {
			throw new Error(`invalid weight for ${uplink.ifname}`);
		}
		if (
			(uplink.mark & CLIENT_FLOW_NAMESPACE_MASK) >>> 0 !==
				CLIENT_FLOW_NAMESPACE ||
			(uplink.mark & UNOWNED_MARK_MASK) !== 0
		) {
			throw new Error(`invalid steering mark for ${uplink.ifname}`);
		}
		const prior = marks.get(uplink.mark);
		if (prior !== undefined && prior !== uplink.identity) {
			throw new Error(
				`steering mark collision: ${prior} and ${uplink.identity}`,
			);
		}
		marks.set(uplink.mark, uplink.identity);
	}
}

function assertIfname(ifname: string): void {
	if (!SAFE_NFT_IFNAME_RE.test(ifname)) {
		throw new Error(`unsafe interface: ${ifname}`);
	}
}

function assertIpv4Cidr(cidr: string): void {
	const match = cidr.match(IPV4_CIDR_RE);
	if (!match || match.slice(1, 5).some((part) => Number(part) > 255)) {
		throw new Error(`invalid IPv4 CIDR: ${cidr}`);
	}
}

function hexMark(mark: number): string {
	return `0x${(mark >>> 0).toString(16).padStart(8, "0")}`;
}
