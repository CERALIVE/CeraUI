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
 * A structural reader for `nft list ruleset`, kept deliberately shallow.
 *
 * The coexistence diagnostic only ever asks THREE questions of the ruleset —
 * which table owns a rule, what a base chain's hook/priority is, and whether a
 * rule's text carries a given match — so this parses to that depth and no
 * further. It is a READER: it never derives a verdict, and it never rewrites,
 * normalizes or re-orders a rule line, because table PROVENANCE is the whole
 * discriminator between NetworkManager's shared-mode masquerade and CeraUI's
 * own (`inet ceralive_share`), and a normalized line loses it.
 */

/**
 * nft prints a base chain's priority as a standard NAME, a signed integer, or a
 * name with an offset (`filter - 10`). All three mean one number, and the
 * foreign-table integrity check compares against a number, so the names are
 * resolved here rather than at the call site.
 */
const PRIORITY_NAMES: Readonly<Record<string, number>> = {
	raw: -300,
	mangle: -150,
	dstnat: -100,
	filter: 0,
	security: 50,
	srcnat: 100,
	out: 100,
};

const TABLE_RE = /^\s*table\s+(\S+)\s+(\S+)\s*\{\s*$/;
const CHAIN_RE = /^\s*chain\s+(\S+)\s*\{\s*$/;
const HOOK_RE = /\bhook\s+(\S+)\s+priority\s+([^;]+);/;

export interface NftChain {
	readonly name: string;
	/** Absent for a regular (non-base) chain — it has no hook and no priority. */
	readonly hook?: string;
	/** Absent when the priority token could not be resolved to a number. */
	readonly priority?: number;
	readonly rules: readonly string[];
}

export interface NftTable {
	readonly family: string;
	readonly name: string;
	readonly chains: readonly NftChain[];
}

interface MutableChain {
	name: string;
	hook: string | undefined;
	priority: number | undefined;
	rules: string[];
}

/**
 * Resolve one nft base-chain priority token to its number.
 *
 * Returns `undefined` for a token this reader cannot place, which the caller
 * must treat as "not established" — never as `0`.
 */
export function resolveNftPriority(token: string): number | undefined {
	const trimmed = token.trim();
	const numeric = /^[+-]?\d+$/.exec(trimmed);
	if (numeric) return Number.parseInt(trimmed, 10);

	const offset = /^([A-Za-z]+)\s*([+-])\s*(\d+)$/.exec(trimmed);
	if (offset?.[1] && offset[2] && offset[3]) {
		const base = PRIORITY_NAMES[offset[1].toLowerCase()];
		if (base === undefined) return undefined;
		const delta = Number.parseInt(offset[3], 10);
		return offset[2] === "-" ? base - delta : base + delta;
	}

	return PRIORITY_NAMES[trimmed.toLowerCase()];
}

/**
 * Parse `nft list ruleset` output into its tables, chains and rule lines.
 *
 * Returns `null` when NOT A SINGLE table parses. A device that reached this
 * reader has an nftables kernel and at least the image's own ingest-firewall
 * table, so zero tables means the output is malformed or the read did not
 * happen — and the caller must withhold a verdict rather than conclude "no
 * NAT anywhere", which would flag every healthy board.
 */
export function parseNftRuleset(stdout: string): NftTable[] | null {
	const tables: NftTable[] = [];
	let table: { family: string; name: string; chains: NftChain[] } | undefined;
	let chain: MutableChain | undefined;

	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;

		if (chain !== undefined) {
			if (line === "}") {
				table?.chains.push(toChain(chain));
				chain = undefined;
				continue;
			}
			const hook = HOOK_RE.exec(line);
			if (hook?.[1] && hook[2]) {
				chain.hook = hook[1];
				chain.priority = resolveNftPriority(hook[2]);
				continue;
			}
			chain.rules.push(line);
			continue;
		}

		if (table !== undefined) {
			if (line === "}") {
				tables.push({
					family: table.family,
					name: table.name,
					chains: table.chains,
				});
				table = undefined;
				continue;
			}
			const opened = CHAIN_RE.exec(line);
			if (opened?.[1]) {
				chain = {
					name: opened[1],
					hook: undefined,
					priority: undefined,
					rules: [],
				};
			}
			continue;
		}

		const opened = TABLE_RE.exec(line);
		if (opened?.[1] && opened[2]) {
			table = { family: opened[1], name: opened[2], chains: [] };
		}
	}

	return tables.length > 0 ? tables : null;
}

/** The table owning `name` in `family`, or `undefined` when it is not installed. */
export function findNftTable(
	tables: readonly NftTable[],
	family: string,
	name: string,
): NftTable | undefined {
	return tables.find((table) => table.family === family && table.name === name);
}

function toChain(chain: MutableChain): NftChain {
	return {
		name: chain.name,
		...(chain.hook === undefined ? {} : { hook: chain.hook }),
		...(chain.priority === undefined ? {} : { priority: chain.priority }),
		rules: chain.rules,
	};
}
