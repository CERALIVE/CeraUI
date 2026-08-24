/**
 * S7 device-mutation guard — the WiFi mutation actions, device side.
 *
 * The charter's S7 gate ("every device-mutation action presents native-feel
 * feedback and carries re-entry protection") has a frontend guard that
 * enumerates the surfaces routing through `osCommand`. This is its DEVICE half,
 * and it exists because the two halves protect different failure modes: the
 * frontend one catches a control that dispatches a bare RPC, and this one
 * catches a mutation that can never give that control anything to settle on —
 * an action with no terminal frame, or one that contends for a radio with no
 * admission check at all.
 *
 * It is a STATIC source scan for the same reason the frontend guard is: the
 * publishers are broadcasts and the lock is a process-wide singleton, so driving
 * all of them to dispatch would need a full NetworkManager double per action.
 * Scanning for the wiring catches the exact regression that matters — an action
 * losing its terminal frame or its admission probe.
 *
 * The `wifi-mode` row is the one this effort adds. Its FRONTEND counterpart is
 * owed by the mode-selector todo; until that control exists there is no
 * `osCommand` registration for the frontend guard to enumerate, so the device
 * half is what holds the action to the standard in the meantime.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/backend/src/` — this test lives in `src/tests/`. */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

interface WifiMutationAction {
	/** Human name of the WiFi device-mutation action. */
	readonly name: string;
	/** Stable key for the action, and the meta-guard's identity for it. */
	readonly key: string;
	/** Source file (relative to `src/`) that must carry the wiring. */
	readonly file: string;
	/**
	 * Tokens that ALL must appear for this action to be able to settle an
	 * operator's keyed operation: the terminal-frame publisher it routes through,
	 * and the adapter-lock admission it takes before contending for the radio.
	 */
	readonly mustContain: readonly string[];
}

const HOTSPOT_ACTIVATION = "modules/wifi/wifi-hotspot-activation.ts";
const HOTSPOT_CONFIG = "modules/wifi/wifi-hotspot-config.ts";
const MODE_TRANSITION = "modules/wifi/wifi-adapter-mode-transition.ts";
const WIFI_PROCEDURE = "rpc/procedures/wifi.procedure.ts";

const WIFI_MUTATION_ACTIONS: readonly WifiMutationAction[] = [
	{
		name: "Hotspot start",
		key: "hotspot-start",
		file: HOTSPOT_ACTIVATION,
		mustContain: ["deps.publishOutcome?.(", "withWifiAdapterLock("],
	},
	{
		name: "Hotspot stop",
		key: "hotspot-stop",
		file: HOTSPOT_CONFIG,
		mustContain: ["deps.publishOutcome?.(", "withWifiAdapterLock("],
	},
	{
		name: "Hotspot configure",
		key: "hotspot-configure",
		file: HOTSPOT_CONFIG,
		mustContain: ["hotspot: { config: {", "withWifiAdapterLock("],
	},
	{
		name: "Adapter mode change",
		key: "wifi-mode",
		file: MODE_TRANSITION,
		mustContain: [
			"deps.publishOutcome(",
			"chainModeTerminal(",
			"deps.isAdapterBusy(",
			"withWifiAdapterLock(",
		],
	},
] as const;

/** The canonical key set — a meta-guard so the list cannot silently shrink. */
const EXPECTED_KEYS: readonly string[] = [
	"hotspot-start",
	"hotspot-stop",
	"hotspot-configure",
	"wifi-mode",
];

const fileCache = new Map<string, string>();
function readSource(file: string): string {
	const abs = join(SRC_DIR, file);
	let source = fileCache.get(abs);
	if (source === undefined) {
		source = readFileSync(abs, "utf8");
		fileCache.set(abs, source);
	}
	return source;
}

describe("S7 WiFi device-mutation guard", () => {
	it("enumerates exactly the expected mutation actions (no silent drift)", () => {
		expect([...WIFI_MUTATION_ACTIONS.map((a) => a.key)].sort()).toEqual(
			[...EXPECTED_KEYS].sort(),
		);
	});

	it.each([...WIFI_MUTATION_ACTIONS])(
		"$name ($key) carries a terminal frame and an adapter-lock admission in $file",
		({ key, file, mustContain }) => {
			const source = readSource(file);
			for (const token of mustContain) {
				expect(
					source.includes(token),
					`WiFi mutation action "${key}" must wire its terminal frame and its ` +
						`adapter-lock admission in ${file} (missing token: ${token}). S7 ` +
						`(docs/STANDARDS-CHARTER.md) requires every device-mutation action to ` +
						`give the operator an in-flight state, a settled outcome, and re-entry ` +
						`protection — an action with no terminal frame leaves a keyed operation ` +
						`to expire on its TTL.`,
				).toBe(true);
			}
		},
	);

	it("the mode change publishes its PENDING state as well as its terminal one", () => {
		const source = readSource(MODE_TRANSITION);
		expect(source).toContain("{ pending: true, mode: target }");
	});

	it("the mode RPC takes NO `runGuarded` — the transaction owns the lock", () => {
		const source = readSource(WIFI_PROCEDURE);
		const handler = source.slice(
			source.indexOf("export const setWifiAdapterModeProcedure"),
		);
		const nextExport = handler.indexOf("\nexport const ", 1);
		const body = nextExport === -1 ? handler : handler.slice(0, nextExport);
		// `withDeviceLock` is not re-entrant and the transaction acquires the same
		// permanent-MAC key, so a guard here would make every mode change refuse
		// itself — the exact defect the hotspot toggles already carry a note about.
		expect(body).not.toContain("runGuarded(");
	});
});
