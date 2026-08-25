/*
 * `sharing_diag` only ever reaches a client through the POST-AUTH INITIAL PUSH
 * and an on-CHANGE broadcast — there is no periodic re-send, and its slowest
 * input is a 30 s poll, so a missed hydration leaves a fresh browser on the
 * pre-check all-`unknown` state indefinitely.
 *
 * These cases pin BOTH halves of that wire, for the reason `cpu-initial-push`
 * records: the first cut of a signal like this wired the LEGACY
 * `modules/ui/status.ts` relay enumeration and left
 * `rpc/adapter.ts::sendInitialStatusToClient` — the path every browser actually
 * uses — untouched. The whole suite was green and the board rendered nothing.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";

import {
	deriveSharingDiag,
	EXPECTED_FIREWALL_BACKEND,
} from "../modules/network/sharing-diag/checks.ts";
import {
	getSharingDiag,
	publishSharingDiag,
	resetSharingDiagForTest,
	SHARING_DIAG_EVENT,
} from "../modules/network/sharing-diag/status.ts";
import { setup } from "../modules/setup.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import {
	ipRuleShow,
	nftRuleset,
	SHARED_PREFIX,
} from "./sharing-diag-test-fixtures.ts";

describe("the sharing-coexistence verdict reaches a newly authenticated client", () => {
	// buildInitialStatus() fires getSshStatus(), which rejects on a malformed
	// setup.ssh_user a sibling test file may have left in the shared setup object.
	let savedSshUser: string | undefined;
	beforeAll(() => {
		savedSshUser = setup.ssh_user;
		setup.ssh_user = undefined;
	});
	afterAll(() => {
		setup.ssh_user = savedSshUser;
	});
	afterEach(() => resetSharingDiagForTest());

	test("the post-login snapshot carries the CURRENT verdict, not a placeholder", () => {
		// Before any pass has run the snapshot is honestly unknown, never `ok`.
		expect(buildInitialStatus().sharingDiag).toEqual({
			state: "unknown",
			checkedAt: 0,
			firewallBackend: { state: "unknown" },
			steeringRules: { state: "unknown" },
			sharedNat: { state: "unknown" },
			foreignTables: { state: "unknown" },
		});

		publishSharingDiag({
			state: "degraded",
			checkedAt: 1_700_000_000_000,
			firewallBackend: {
				state: "degraded",
				reason: "firewall_backend_unpinned",
				detail: "no explicit firewall-backend is pinned; expected nftables",
			},
			steeringRules: { state: "ok" },
			sharedNat: { state: "ok" },
			foreignTables: { state: "unknown" },
		});

		const hydrated = buildInitialStatus().sharingDiag;
		expect(hydrated.state).toBe("degraded");
		expect(hydrated.firewallBackend.reason).toBe("firewall_backend_unpinned");
		expect(hydrated.foreignTables.state).toBe("unknown");
	});

	test("the RPC adapter actually SENDS it — a snapshot field nobody emits is dead", async () => {
		const adapter = await Bun.file(
			new URL("../rpc/adapter.ts", import.meta.url).pathname,
		).text();

		expect(adapter).toContain("initialStatus.sharingDiag");
		expect(adapter).toContain("SHARING_DIAG_EVENT");
	});

	test("the event name the adapter emits is the one the frontend switches on", () => {
		expect(SHARING_DIAG_EVENT).toBe("sharing_diag");
	});

	test("a shadowed-rule device reaches the wire as degraded, end to end", () => {
		publishSharingDiag(
			deriveSharingDiag(
				{
					firewallBackend: EXPECTED_FIREWALL_BACKEND,
					ipRuleShow: ipRuleShow({ steeringPriority: 90 }),
					nftRuleset: nftRuleset(),
					sharedZones: [{ ifname: "wlan0", ipv4Cidr: SHARED_PREFIX }],
				},
				5,
			),
		);

		expect(getSharingDiag().state).toBe("degraded");
		expect(getSharingDiag().steeringRules.reason).toBe(
			"steering_rule_shadows_source_route",
		);
		expect(buildInitialStatus().sharingDiag.steeringRules.reason).toBe(
			"steering_rule_shadows_source_route",
		);
	});
});
