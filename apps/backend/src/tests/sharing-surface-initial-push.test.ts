/*
 * POST-LOGIN HYDRATION for the Internet-Sharing surface (todo 13).
 *
 * Its four inputs split cleanly, and the split IS the contract:
 *
 *   PERSISTENT — `uplinks`, `uplink-steering`, `uplink-shaper`, `sharing_diag`,
 *     and the `netif` rows carrying `ethRole`. Each is broadcast on CHANGE, so
 *     a client that connects between changes learns nothing until the next one.
 *     They MUST ride the post-login snapshot.
 *
 *   TRANSIENT — `uplink-flows-reset`. It describes a hard-down drain that has
 *     already happened. Replaying it at a later login would tell an operator a
 *     conntrack flush is occurring now, so it MUST NOT be in the snapshot, and
 *     its absence is asserted here rather than assumed.
 *
 * The hydration is pinned on the PRODUCTION path — `buildInitialStatus()` plus
 * an explicit emission in `rpc/adapter.ts::sendInitialStatusToClient` — never
 * the legacy `modules/ui/status.ts` relay enumeration, for the reason
 * `cpu-initial-push.test.ts` records: the first cut of a signal like this wired
 * the relay, left the adapter every browser actually uses untouched, and shipped
 * green with a board that rendered nothing.
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
	publishSharingDiag,
	resetSharingDiagForTest,
} from "../modules/network/sharing-diag/status.ts";
import { UplinkHealthEngine } from "../modules/network/uplink-health/model.ts";
import {
	getUplinksMessage,
	setUplinkHealthEngineForTest,
} from "../modules/network/uplink-health/state.ts";
import { ShaperUnavailableError } from "../modules/network/uplink-shaper/contracts.ts";
import {
	publishShaperUnavailable,
	resetUplinkShaperStatusForTest,
	UPLINK_SHAPER_EVENT,
} from "../modules/network/uplink-shaper/status.ts";
import {
	publishUplinkSteeringAvailability,
	resetUplinkSteeringStatusForTest,
	UPLINK_FLOWS_RESET_EVENT,
	UPLINK_STEERING_EVENT,
} from "../modules/network/uplink-steering/status.ts";
import { setup } from "../modules/setup.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";

const ADAPTER_SOURCE = await Bun.file(
	new URL("../rpc/adapter.ts", import.meta.url).pathname,
).text();

describe("the Internet-Sharing inputs reach a newly authenticated client", () => {
	// buildInitialStatus() fires getSshStatus(), which rejects on a malformed
	// setup.ssh_user a sibling test file may have left in the shared setup object.
	let savedSshUser: string | undefined;
	beforeAll(() => {
		savedSshUser = setup.ssh_user;
		setup.ssh_user = undefined;
	});
	afterAll(() => {
		setup.ssh_user = savedSshUser;
		setUplinkHealthEngineForTest(null);
	});
	afterEach(() => {
		resetSharingDiagForTest();
		resetUplinkSteeringStatusForTest();
		resetUplinkShaperStatusForTest();
		setUplinkHealthEngineForTest(null);
	});

	test("the snapshot carries the CURRENT per-uplink health, not a placeholder", () => {
		const engine = new UplinkHealthEngine();
		engine.observe({
			iface: "wwan0",
			kind: "cellular",
			outcome: "definitive_loss",
			now: 1_700_000_000_000,
		});
		setUplinkHealthEngineForTest(engine);

		const hydrated = buildInitialStatus().uplinks;
		expect(hydrated).toEqual(getUplinksMessage());
		expect(hydrated.map((record) => record.iface)).toContain("wwan0");
	});

	test("the snapshot carries the CURRENT steering + shaper state", () => {
		publishUplinkSteeringAvailability({
			available: false,
			reason: "overlapping_subnet",
			detail: "client zone 10.42.0.0/24 overlaps wwan0",
		});
		publishShaperUnavailable(
			new ShaperUnavailableError(
				"foreign_qdisc",
				"root handle 8001: is not ours",
			),
		);

		const initial = buildInitialStatus();
		expect(initial.uplinkSteering).toEqual({
			state: "steering_unavailable",
			reason: "overlapping_subnet",
			detail: "client zone 10.42.0.0/24 overlaps wwan0",
		});
		expect(initial.uplinkShaper.state).toBe("shaper_unavailable");
		expect(
			initial.uplinkShaper.state === "shaper_unavailable" &&
				initial.uplinkShaper.priorityDegraded,
		).toBe(true);
	});

	test("the snapshot carries the CURRENT coexistence verdict", () => {
		publishSharingDiag({
			state: "degraded",
			checkedAt: 1_700_000_030_000,
			firewallBackend: {
				state: "degraded",
				reason: "firewall_backend_unpinned",
			},
			steeringRules: { state: "ok" },
			sharedNat: { state: "ok" },
			foreignTables: { state: "unknown" },
		});

		expect(buildInitialStatus().sharingDiag.firewallBackend.reason).toBe(
			"firewall_backend_unpinned",
		);
	});

	test("the RPC adapter actually SENDS each persistent field", () => {
		// A snapshot field nobody emits is dead. Asserted against the shipped
		// adapter source, exactly as the sharing_diag case does.
		for (const field of [
			"initialStatus.uplinks",
			"initialStatus.uplinkSteering",
			"initialStatus.uplinkShaper",
			"initialStatus.sharingDiag",
			"initialStatus.netif",
		]) {
			expect(ADAPTER_SOURCE).toContain(field);
		}
	});

	test("the event names the adapter emits are the ones the frontend switches on", () => {
		expect(UPLINK_STEERING_EVENT).toBe("uplink-steering");
		expect(UPLINK_SHAPER_EVENT).toBe("uplink-shaper");
		expect(ADAPTER_SOURCE).toContain('"uplinks"');
		expect(ADAPTER_SOURCE).toContain('"uplink-steering"');
		expect(ADAPTER_SOURCE).toContain('"uplink-shaper"');
	});
});

describe("the one-shot hard-down notice is NEVER hydrated", () => {
	let savedSshUser: string | undefined;
	beforeAll(() => {
		savedSshUser = setup.ssh_user;
		setup.ssh_user = undefined;
	});
	afterAll(() => {
		setup.ssh_user = savedSshUser;
	});

	test("no snapshot field carries the transient, under any name", () => {
		const initial = buildInitialStatus() as Record<string, unknown>;
		expect(Object.keys(initial)).not.toContain("uplinkFlowsReset");
		expect(
			Object.keys(initial).filter((key) => /flowsReset|flows_reset/i.test(key)),
		).toEqual([]);
	});

	test("its serialized snapshot names no interface the drain touched", () => {
		// Structural, not merely key-shaped: the whole payload is searched for the
		// event's own vocabulary, so a future field that smuggled it in fails here.
		const serialized = JSON.stringify(buildInitialStatus());
		expect(serialized).not.toContain(UPLINK_FLOWS_RESET_EVENT);
		expect(serialized).not.toContain("linkId");
	});

	test("the adapter never emits it, while it DOES emit its persistent sibling", () => {
		// The paired positive is the non-vacuity check: this file's grep is
		// demonstrably able to find an event the adapter really does send.
		expect(ADAPTER_SOURCE).toContain('"uplink-steering"');
		expect(ADAPTER_SOURCE).not.toContain("uplink-flows-reset");
		expect(ADAPTER_SOURCE).not.toContain("UPLINK_FLOWS_RESET_EVENT");
	});
});
