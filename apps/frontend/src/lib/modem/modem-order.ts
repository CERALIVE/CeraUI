/**
 * Hardware-first display order for the Network modem inventory.
 */
import type { Modem } from "@ceraui/rpc/schemas";

/**
 * THE ROW ORDER IS A FUNCTION OF THE HARDWARE, NEVER OF THE WIRE ID.
 *
 * `NetworkView` derives its roster as `Object.entries(modems)`, and EVERY wire
 * id is `String(number)` — the mmcli index for a managed modem, an allocated
 * index for a dongle (`modem-wire-projection.ts` `allocateSyntheticIds`). Those
 * are integer-like keys, so JavaScript's own object semantics already order the
 * roster by ASCENDING NUMERIC ID, whatever order the backend emitted. Emission
 * order is therefore NOT the problem, and a fixture built to prove it is
 * vacuous — the object canonicalises it away before anything can observe it.
 *
 * The problem is that the id is RE-ISSUED, so ascending-id is not a stable
 * ordering of the operator's hardware:
 *
 *   - a replugged modem is handed a FRESH, higher mmcli index, so its row jumps
 *     to the BOTTOM of the list;
 *   - a ModemManager restart renumbers the whole roster (board-measured:
 *     `11,13,14,15 -> 0,1,2,3`) in whatever order it re-probes the ports, so two
 *     rows can swap without anything about the hardware changing.
 *
 * On a one- or two-modem bench that reads as a flicker. On the eight-device
 * fleet this effort targets it is an operator reaching for a row that is no
 * longer where they left it.
 *
 * The key is therefore the strongest identity the wire carries:
 *
 *   1. `stable_key` — the ID_PATH-derived USB PORT. A replug into the same port
 *      keeps it, a composition change keeps it, and a unit MOVED to another port
 *      correctly sorts elsewhere, because it really is somewhere else now.
 *   2. `id` — the roster key, unique by construction, compared as a STRING. The
 *      honest floor for a row whose ID_PATH never resolved; it is the re-issued
 *      index, so such a row can still move under a re-enumeration, but nothing
 *      better exists for it. Note this is NOT the numeric order the object gave
 *      us for free: `"10"` precedes `"9"`. That is deliberate — one comparison
 *      rule for both rungs, and an unanchored row has no ordering worth
 *      preserving anyway.
 *
 * ANCHORED ROWS SORT AHEAD OF UNANCHORED ONES, and a row that gains its anchor
 * therefore moves ONCE — `stable_key` is filled by an async udev read, so at
 * boot a row can legitimately appear before its port is known. That single
 * settle is the price of never guessing a port; it is not a replug event, and no
 * later broadcast repeats it.
 *
 * Comparison is CODE-UNIT, never `localeCompare`: locale-aware collation would
 * make the row order depend on the operator's language, which is the exact class
 * of instability this rule exists to remove.
 *
 * Non-mutating (the caller's array is a `$derived`), total (the `id` tiebreak
 * cannot tie — ids are map keys), and idempotent.
 */
export function modemRowSortKey(id: string, modem: Modem): string {
	const anchor = modem.stable_key?.trim();
	return anchor ? `0\u0000${anchor}\u0000${id}` : `1\u0000${id}`;
}

/** The roster in {@link modemRowSortKey} order. Returns a new array. */
export function sortModemEntries(
	entries: readonly (readonly [string, Modem])[],
): [string, Modem][] {
	return [...entries]
		.map(([id, modem]) => [modemRowSortKey(id, modem), id, modem] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([, id, modem]) => [id, modem]);
}
