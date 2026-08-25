/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * `ip rule show` read for the coexistence diagnostic.
 *
 * The line shapes are the ones `uplink-steering/route-policy.ts` already writes
 * and matches — a `<prio>: from <src> lookup <table>` source rule and a
 * `<prio>: from all fwmark <mark>/<mask> lookup <table>` steering rule. The
 * difference is deliberate and is the whole reason this is not a re-use of that
 * module's readers: those are scoped to `FWMARK_RULE_PRIORITY` because their job
 * is to find the rules the steering layer OWNS, whereas this one must see a
 * steering rule that has drifted OFF that priority — which is exactly the fault
 * it exists to report.
 */

import {
	CLIENT_FLOW_NAMESPACE,
	CLIENT_FLOW_NAMESPACE_MASK,
} from "../uplink-steering/contracts.ts";

const ANY_RULE_RE = /^\s*(\d+):\s+\S/;
const FWMARK_RULE_RE =
	/^\s*(\d+):\s+.*\bfwmark\s+(0x[0-9a-f]+)(?:\/0x[0-9a-f]+)?\s+(?:lookup|table)\s+(\S+)/i;
const SOURCE_RULE_RE = /^\s*(\d+):\s+from\s+(\S+)\s+lookup\s+(\S+)/;

export interface SteeringRule {
	readonly priority: number;
	readonly mark: number;
	readonly table: string;
}

export interface SourceRouteRule {
	readonly priority: number;
	readonly source: string;
	readonly table: string;
}

export interface ParsedIpRules {
	/** Rules whose fwmark carries the `CLIENT_FLOW` provenance byte — ours. */
	readonly steering: readonly SteeringRule[];
	/** The image's per-uplink source rules (`from <ip>`), never `from all`. */
	readonly sourceRoutes: readonly SourceRouteRule[];
}

/**
 * Parse `ip rule show`.
 *
 * Returns `null` when NOT A SINGLE rule line is parseable: a real `ip rule show`
 * always carries at least the three base rules, so zero matches means the output
 * is malformed or unavailable and the caller must withhold rather than conclude
 * "no steering rules, therefore healthy".
 */
export function parseIpRuleBands(stdout: string): ParsedIpRules | null {
	const steering: SteeringRule[] = [];
	const sourceRoutes: SourceRouteRule[] = [];
	let parsedAny = false;

	for (const line of stdout.split("\n")) {
		if (!ANY_RULE_RE.test(line)) continue;
		parsedAny = true;

		const fwmark = FWMARK_RULE_RE.exec(line);
		if (fwmark?.[1] && fwmark[2] && fwmark[3]) {
			const mark = Number.parseInt(fwmark[2], 16) >>> 0;
			const namespace = ((mark & CLIENT_FLOW_NAMESPACE_MASK) >>> 0) as number;
			if (namespace === CLIENT_FLOW_NAMESPACE) {
				steering.push({
					priority: Number.parseInt(fwmark[1], 10),
					mark,
					table: fwmark[3],
				});
			}
			continue;
		}

		const source = SOURCE_RULE_RE.exec(line);
		if (source?.[1] && source[2] && source[3] && source[2] !== "all") {
			sourceRoutes.push({
				priority: Number.parseInt(source[1], 10),
				source: source[2],
				table: source[3],
			});
		}
	}

	return parsedAny ? { steering, sourceRoutes } : null;
}
