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
  Regulatory RULE data from `iw reg get` — the half of regulatory truth that the
  per-frequency `iw phy` flags do NOT carry.

  BOARD-PROVEN (Rock 5B+, RTL8852BE, 2026-08-22). Under the kernel's WORLD
  domain (`00`) that adapter's `iw phy` dump lists 5180/5200/5220/5745… with no
  `no IR` marker at all, so a derivation reading only the per-channel flags
  offers them — and starting the AP then fails, because EVERY 5 GHz rule in the
  regulatory dump is `PASSIVE-SCAN`:

      country 00: DFS-UNSET
        (2402 - 2472 @ 40), (6, 20), (N/A)
        (2457 - 2482 @ 20), (6, 20), (N/A), AUTO-BW, PASSIVE-SCAN
        (5170 - 5250 @ 80), (6, 20), (N/A), AUTO-BW, PASSIVE-SCAN
        (5250 - 5330 @ 80), (6, 20), (0 ms), DFS, AUTO-BW, PASSIVE-SCAN
        (5490 - 5730 @ 160), (6, 20), (0 ms), DFS, PASSIVE-SCAN
        (5735 - 5835 @ 80), (6, 20), (N/A), PASSIVE-SCAN

      wpa_supplicant[699]: wlan0: Failed to start AP functionality
      device (wlan0): state change: config -> failed ('supplicant-timeout')

  `PASSIVE-SCAN`, `NO-IR` and the ancient `NO-IBSS` are three spellings of one
  nl80211 flag — NL80211_RRF_NO_IR, "no INITIATING radiation", which is exactly
  what bringing an AP up does. So this module answers ONE question from the rule
  data alone: may an AP initiate anywhere inside a frequency span?

  Three properties are load-bearing:

  - It is BAND-SCOPED, not channel-scoped. A span is refused only when EVERY
    rule overlapping it forbids initiation — the "PASSIVE-SCAN only" state the
    world domain puts 5 GHz in, and deliberately does NOT put 2.4 GHz in: that
    domain's `(2402 - 2472)` rule carries no such flag, so channels 1-11 are
    unaffected. The per-channel `iw phy` flags still exclude 12/13/14.
  - It FAILS OPEN. A dump that says nothing about a span permits it — absence of
    a rule is not evidence of prohibition, and an unreadable `iw reg get` is a
    statement about the READ, never a legality verdict. The per-channel flags
    remain the primary gate.
  - It reads the PER-PHY section when there is one. A self-managed wiphy carries
    its own domain, so a board whose global scope is the world domain can still
    have a radio that legally initiates on 5 GHz — and only that section says so.
*/

/** One regulatory rule line, reduced to what a legality question needs. */
export type RegulatoryRule = {
	/** Lower bound of the rule's frequency range, in MHz. */
	readonly startMhz: number;
	/** Upper bound of the rule's frequency range, in MHz. */
	readonly endMhz: number;
	/** The rule's trailing flag tokens, normalised (`PASSIVE-SCAN` ⇒ `passive scan`). */
	readonly flags: readonly string[];
};

/** `iw reg get` rules, split by the scope they were printed under. */
export type RegulatoryRuleScopes = {
	readonly global: readonly RegulatoryRule[];
	readonly byPhy: ReadonlyMap<string, readonly RegulatoryRule[]>;
};

/** `phy#0` / `phy#1 (self-managed)` — the per-radio scope header. */
const PHY_SCOPE_RE = /^phy#(\d+)\b/;
/** `(5170 - 5250 @ 80), (6, 20), (N/A), AUTO-BW, PASSIVE-SCAN` */
const RULE_RE =
	/^\(\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*@[^)]*\)\s*(.*)$/;
/** `(6, 20)` / `(0 ms)` are power and CAC readings, never restriction flags. */
const PAREN_GROUP_RE = /\([^)]*\)/g;

/**
 * The three spellings of NL80211_RRF_NO_IR. Any one of them means the radio may
 * listen on that range but must not transmit first — so no AP may be started on
 * it, whatever the per-channel `iw phy` flags happen to say.
 */
const AP_INITIATION_BLOCKING_FLAGS: ReadonlySet<string> = new Set([
	"no ir",
	"passive scan",
	"no ibss",
]);

const normalizeFlag = (flag: string): string =>
	flag.trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");

function parseRuleFlags(tail: string): string[] {
	return tail
		.replace(PAREN_GROUP_RE, "")
		.split(",")
		.map(normalizeFlag)
		.filter((flag) => flag !== "");
}

/**
 * One regulatory rule line, or `undefined` when the line is not one. Shared with
 * `wifi-capabilities.ts` so the frequency ranges its `is6GhzLegal` verdict reads
 * and the ranges this module's AP gate reads can never be parsed two ways.
 */
export function parseRegulatoryRuleLine(
	line: string,
): RegulatoryRule | undefined {
	const match = RULE_RE.exec(line.trim());
	if (!match?.[1] || !match[2]) return undefined;

	const startMhz = Number(match[1]);
	const endMhz = Number(match[2]);
	if (!Number.isFinite(startMhz) || !Number.isFinite(endMhz)) return undefined;

	return { startMhz, endMhz, flags: parseRuleFlags(match[3] ?? "") };
}

/**
 * Parse `iw reg get` into the global rule set plus every PER-PHY one. Rules that
 * appear before any scope header belong to the global scope, which is what an
 * `iw` build that omits the leading `global` line produces.
 */
export function parseRegulatoryRules(output: string): RegulatoryRuleScopes {
	const global: RegulatoryRule[] = [];
	const byPhy = new Map<string, RegulatoryRule[]>();
	let current: RegulatoryRule[] = global;

	for (const raw of output.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;

		if (line === "global") {
			current = global;
			continue;
		}

		const phy = PHY_SCOPE_RE.exec(line);
		if (phy?.[1]) {
			const name = `phy${phy[1]}`;
			let rules = byPhy.get(name);
			if (rules === undefined) {
				rules = [];
				byPhy.set(name, rules);
			}
			current = rules;
			continue;
		}

		const rule = parseRegulatoryRuleLine(line);
		if (rule !== undefined) current.push(rule);
	}

	return { global, byPhy };
}

/**
 * The rules governing ONE radio: its own section when it has a non-empty one
 * (a self-managed wiphy carries its own domain), else the global scope.
 */
export function rulesForPhy(
	scopes: RegulatoryRuleScopes,
	phy: string | undefined,
): readonly RegulatoryRule[] {
	if (phy !== undefined) {
		const own = scopes.byPhy.get(phy);
		if (own !== undefined && own.length > 0) return own;
	}
	return scopes.global;
}

/**
 * May an AP INITIATE radiation anywhere inside `[startMhz, endMhz)`?
 *
 * `true` unless the range is covered by rules and EVERY covering rule carries an
 * initiation-blocking flag. A range no rule mentions answers `true` — see the
 * fail-open rule in the module header.
 */
export function permitsApInitiationInRange(
	rules: readonly RegulatoryRule[],
	startMhz: number,
	endMhz: number,
): boolean {
	let covered = false;

	for (const rule of rules) {
		if (rule.endMhz <= startMhz || rule.startMhz >= endMhz) continue;
		covered = true;
		const blocked = rule.flags.some((flag) =>
			AP_INITIATION_BLOCKING_FLAGS.has(flag),
		);
		if (!blocked) return true;
	}

	return !covered;
}
