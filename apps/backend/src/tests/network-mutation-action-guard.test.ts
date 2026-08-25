/**
 * S7 device-mutation guard — the NETWORK mutation actions, device side.
 *
 * The sibling of `wifi-mutation-action-guard.test.ts`, and it exists for the
 * same reason: the charter's S7 gate has a FRONTEND guard that enumerates the
 * surfaces routing through `osCommand`, and that guard cannot see a mutation
 * which never gives a control anything to settle on. This is the DEVICE half —
 * it catches an action with no terminal frame, and one that answers `success`
 * for work it did not do.
 *
 * It is a STATIC source scan for the same reason the WiFi one is: the publishers
 * are broadcasts, so driving every action to dispatch would need a full
 * NetworkManager double per action. Scanning for the wiring catches the exact
 * regression that matters — an action losing its terminal frame, its rollback,
 * or its honest refusal.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `apps/backend/src/` — this test lives in `src/tests/`. */
const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));

interface NetworkMutationAction {
	readonly name: string;
	readonly key: string;
	readonly file: string;
	readonly mustContain: readonly string[];
}

const ETH_ROLE_TRANSITION = "modules/network/ethernet-role-transition.ts";
const NETWORK_PROCEDURE = "rpc/procedures/network.procedure.ts";
const INGEST_CONTROL = "modules/network/network-ingest-control.ts";

const NETWORK_MUTATION_ACTIONS: readonly NetworkMutationAction[] = [
	{
		name: "Ethernet port role",
		key: "eth-role",
		file: ETH_ROLE_TRANSITION,
		mustContain: [
			// A terminal frame on every exit path, and a pending frame before any
			// dispatch, so a keyed operation never expires on its TTL.
			"deps.publishOutcome(",
			"{ pending: true, role }",
			// Persist-first with rollback: a refused flip must leave neither the
			// config nor the netif flags half-applied.
			"deps.persistRole(",
			"deps.restoreRole(name, previous)",
		],
	},
	{
		name: "Interface enable/disable",
		key: "netif-configure",
		file: NETWORK_PROCEDURE,
		mustContain: [
			// The honest-outcome fix: a rejection by `handleNetif` reaches the
			// caller as a typed failure rather than a fabricated success.
			"const outcome = handleNetif(",
			"return { success: false, error: outcome.reason };",
		],
	},
	{
		name: "Network-ingest enable/disable",
		key: "ingest-enabled",
		file: INGEST_CONTROL,
		mustContain: ["export async function setIngestEnabled("],
	},
] as const;

/** The canonical key set — a meta-guard so the list cannot silently shrink. */
const EXPECTED_KEYS: readonly string[] = [
	"eth-role",
	"netif-configure",
	"ingest-enabled",
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

describe("S7 network device-mutation guard", () => {
	it("enumerates exactly the expected mutation actions (no silent drift)", () => {
		expect([...NETWORK_MUTATION_ACTIONS.map((a) => a.key)].sort()).toEqual(
			[...EXPECTED_KEYS].sort(),
		);
	});

	it.each([...NETWORK_MUTATION_ACTIONS])(
		"$name ($key) carries its outcome wiring in $file",
		({ key, file, mustContain }) => {
			const source = readSource(file);
			for (const token of mustContain) {
				expect(
					source.includes(token),
					`Network mutation action "${key}" must wire its honest outcome in ` +
						`${file} (missing token: ${token}). S7 ` +
						`(docs/STANDARDS-CHARTER.md) requires every device-mutation action ` +
						`to give the operator a settled outcome — an action with no terminal ` +
						`frame leaves a keyed operation to expire on its TTL, and one that ` +
						`answers success for work it did not do is worse than either.`,
				).toBe(true);
			}
		},
	);

	it("the role RPC refuses an emulated host BEFORE persisting anything", () => {
		const source = readSource(NETWORK_PROCEDURE);
		const handler = source.slice(
			source.indexOf("export const setEthernetRoleProcedure"),
		);
		const refusal = handler.indexOf("unavailable_in_emulated_mode");
		const dispatch = handler.indexOf("setEthernetRole(input.name");

		expect(refusal).toBeGreaterThan(-1);
		expect(dispatch).toBeGreaterThan(-1);
		// Persisting a role a host can never apply would leave the boot reconciler
		// chasing it on every boot, forever.
		expect(refusal).toBeLessThan(dispatch);
	});

	it("the netif procedure never fabricates a success on a rejected apply", () => {
		const source = readSource(NETWORK_PROCEDURE);
		const handler = source.slice(
			source.indexOf("export const configureNetworkInterfaceProcedure"),
			source.indexOf("export const setNetworkIngestEnabledProcedure"),
		);
		// The retired shape: dispatch, ignore the answer, always report success.
		expect(handler).not.toMatch(
			/handleNetif\([^)]*\);\s*\n\s*return \{\s*\n?\s*success: true/,
		);
		expect(handler).toContain("!outcome.ok");
	});
});
