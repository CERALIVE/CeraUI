/** A single `from <src> lookup <table>` entry parsed from `ip rule show`. */
export type PolicyRule = {
	/** The rule's source selector: a specific IP, or `"all"`. */
	src: string;
	/** The routing table the rule dispatches to (numeric or well-known name). */
	table: string;
};

const ETHERNET_UPLINK_RE = /^(?:eth|en)/;

// `from <src> lookup <table>` — `src` is an IP or `all`; `table` is a number or
// a well-known name (local/main/default). The priority prefix is ignored.
const IP_RULE_LINE_RE = /from\s+(\S+)\s+lookup\s+(\S+)/;

/**
 * Parse `ip rule show` output into its `from <src> lookup <table>` rules.
 *
 * Returns `null` when NOT A SINGLE rule line is parseable — a real `ip rule show`
 * ALWAYS carries at least the three base rules (`from all lookup local/main/
 * default`), so zero matches means the output is malformed/unavailable and the
 * caller must degrade rather than conclude "no rules → flag everything".
 */
export function parseIpRules(stdout: string): PolicyRule[] | null {
	const rules: PolicyRule[] = [];
	for (const line of stdout.split("\n")) {
		const m = line.match(IP_RULE_LINE_RE);
		if (m?.[1] && m[2]) {
			rules.push({ src: m[1], table: m[2] });
		}
	}
	return rules.length > 0 ? rules : null;
}

/** Does `ip route show table <t>` output contain a default route? */
export function parseHasDefaultRoute(stdout: string): boolean {
	return stdout.split("\n").some((line) => line.trim().startsWith("default"));
}

/** Is this a wired ethernet uplink? */
export function isEthernetUplinkIface(name: string): boolean {
	return ETHERNET_UPLINK_RE.test(name);
}
