/**
 * THE DUPLICATE-IP NOTICE MUST BE RE-EVALUATED, AND IT MUST NOT CONTRADICT ITSELF.
 *
 * `netif_dup_ip` shipped with three defects that compound into one operator
 * symptom — a permanent red band about a condition the device had already
 * handled:
 *
 *   (a) the severity was the hardcoded `"error"`, while the very same message
 *       ended "...they can still be bonded when per-interface link mapping is
 *       active". An error that says the thing is fine is not a finding;
 *   (b) `isBondMappingActive()` — the ONE authority on whether the (ip,iface)
 *       mapping is really in force — was never consulted, so the band said the
 *       same thing whether or not the twins were actually disambiguated;
 *   (c) the whole block, the RAISE *and* the `notificationRemove`, sat inside
 *       the `intsChanged` branch. A bond-mapping transition does not move a
 *       single byte of the interface set — same names, same addresses, same
 *       flags — so nothing re-evaluated and the band could never clear. Same
 *       raise-but-never-retract family as `policy_route_missing` and the
 *       `hdmi_error` no-signal claim.
 *
 * Everything here drives the REAL `processIfconfigOutput` against the bench's
 * own twin-HiLink collision (two physically distinct dongles, one factory MAC,
 * both leasing `192.168.8.100`) and the REAL production dep wiring — the same
 * `isBondMappingActive()` the telemetry rung reads and the same identity
 * resolution `genSrtlaBondEntries()` performs.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	getNetworkInterfaces,
	NETIF_DUP_IP_NOTIFICATION,
	processIfconfigOutput,
	resetBondOptOut,
	resetDupIpNoticeState,
	setDupIpNoticeDeps,
	setNetifDupIpSuppression,
	setQueueUpdateGwHook,
	wireDupIpNoticeDeps,
} from "../modules/network/network-interfaces.ts";
import { setNetifState } from "../modules/network/state/netif-state.ts";
import {
	clearBindMapReport,
	noteSenderBindMapReport,
	noteWriterBindMapReport,
	resetBindMapReportListeners,
} from "../modules/streaming/bind-map-disposition.ts";
import {
	getBondMappingState,
	isBondMappingActive,
} from "../modules/streaming/link-mapping-report.ts";
import {
	genSrtlaBondEntries,
	isBondLinkMappable,
	setBondIdentityResolverForTest,
} from "../modules/streaming/srtla.ts";
import {
	notificationExists,
	notificationRemove,
} from "../modules/ui/notifications.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

/**
 * The bench pair, verbatim. They ship ONE factory MAC, so systemd can name only
 * one of them predictably and the twin falls back to its kernel default — which
 * is exactly why the address cannot tell them apart and the interface CAN.
 */
const TWIN_A = "enx0c5b8f279a64";
const TWIN_B = "eth1";
const TWIN_IP = "192.168.8.100";
const SOLO_IF = "eth0";
const SOLO_IP = "192.168.78.132";

const MAPPING_INACTIVE_MSG =
	`Interfaces ${TWIN_A}, ${TWIN_B} share the same IP address: ${TWIN_IP}. ` +
	"Streaming is not affected. The only consequence is that per-interface link " +
	"mapping is not active, so checks that steer by address can't tell them " +
	"apart and only one of them can carry bonded traffic.";

const IDENTITY_DEGRADED_MSG =
	`Interfaces ${TWIN_A}, ${TWIN_B} share the same IP address: ${TWIN_IP}. ` +
	`Streaming is not affected. Per-interface link mapping is active, but ${TWIN_B} ` +
	"could not be identified as a physical device, so it can't be told apart " +
	"from its twin and is left out of the bond.";

/**
 * The IDLE arm of the same finding. Nothing has launched, so the exclusion is
 * still ahead of the operator rather than behind them — and the copy must be in
 * the tense that says so.
 */
const IDLE_UNMAPPABLE_MSG =
	`Interfaces ${TWIN_A}, ${TWIN_B} share the same IP address: ${TWIN_IP}. ` +
	`Streaming is not affected. ${TWIN_B} could not be identified as a physical ` +
	"device, so once a stream starts it can't be told apart from its twin and " +
	"will be left out of the bond.";

function ifconfigStanza(name: string, ip: string): string {
	return [
		`${name}: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500`,
		`        inet ${ip}  netmask 255.255.255.0  broadcast 192.168.8.255`,
		"        ether 0c:5b:8f:27:9a:64  txqueuelen 1000  (Ethernet)",
		"        RX packets 200  bytes 20000 (20.0 KB)",
		`        TX packets 100  bytes 1000 (1.0 KB)`,
	].join("\n");
}

/** The twin collision, plus one ordinary uplink that must never be implicated. */
const TWIN_IFCONFIG = [
	ifconfigStanza(TWIN_A, TWIN_IP),
	ifconfigStanza(TWIN_B, TWIN_IP),
	ifconfigStanza(SOLO_IF, SOLO_IP),
].join("\n\n");

// A pinned clock, so two passes over identical text produce a byte-identical
// snapshot — `sampledAt` is the only field that would otherwise move, and the
// unchanged-set assertion below is what proves nothing but the mapping state
// drove the retraction.
const FIXED_NOW = 1_700_000_000_000;

/** One ifconfig pass. Calling it twice with the same text is an UNCHANGED set. */
function pollNetif(): void {
	processIfconfigOutput(TWIN_IFCONFIG, undefined, FIXED_NOW);
}

/** Put the (ip,iface) mapping in force, exactly as a mapped launch reports it. */
function activateBondMapping(): void {
	noteWriterBindMapReport("bind-map-passed", genSrtlaBondEntries());
}

/** A launch whose sidecar could not be published: the mapping is NOT in force. */
function degradeBondMapping(): void {
	noteWriterBindMapReport("mapping-write-failed", genSrtlaBondEntries());
}

/** The one failure mode `unmappableBondEntry` exists for: a dead descriptor read. */
function failIdentityFor(ifname: string): void {
	setBondIdentityResolverForTest((name) => {
		if (name === ifname) throw new Error("descriptor read failed");
		return resolveModemPhysicalIdentity(name);
	});
}

function recordingClient(sink: string[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (message: string) => sink.push(message),
	} as unknown as AppWebSocket;
}

function captureFrames(run: () => void): Array<Record<string, unknown>> {
	const sink: string[] = [];
	const client = recordingClient(sink);
	addClient(client);
	try {
		run();
	} finally {
		removeClient(client);
	}
	return sink.map((raw) => JSON.parse(raw) as Record<string, unknown>);
}

function removedIds(frames: Array<Record<string, unknown>>): string[] {
	return frames.flatMap((frame) => {
		const payload = frame.notification as
			| { remove?: Array<{ id: string }> }
			| undefined;
		return (payload?.remove ?? []).map((entry) => entry.id);
	});
}

function messageNow(): string | undefined {
	return notificationExists(NETIF_DUP_IP_NOTIFICATION)?.msg;
}

function shownNotices(
	frames: Array<Record<string, unknown>>,
): Array<{ name: string; type: string; msg: string }> {
	return frames.flatMap((frame) => {
		const payload = frame.notification as
			| { show?: Array<{ name: string; type: string; msg: string }> }
			| undefined;
		return payload?.show ?? [];
	});
}

beforeEach(async () => {
	const netif = getNetworkInterfaces();
	for (const name of Object.keys(netif)) delete netif[name];
	setNetifState({});
	for (const name of [TWIN_A, TWIN_B, SOLO_IF]) {
		setNetifDupIpSuppression(name, false);
	}
	resetBondOptOut();
	setQueueUpdateGwHook(null);
	clearBindMapReport();
	notificationRemove(NETIF_DUP_IP_NOTIFICATION);
	resetDupIpNoticeState();
	// The SHIPPED wiring, not a double: the same `isBondMappingActive()` the
	// telemetry rung gates on and the same identity resolution the bind-map
	// writer performs.
	await wireDupIpNoticeDeps();
});

afterEach(() => {
	setBondIdentityResolverForTest(null);
	clearBindMapReport();
	resetBindMapReportListeners();
	setDupIpNoticeDeps(null);
	notificationRemove(NETIF_DUP_IP_NOTIFICATION);
	resetDupIpNoticeState();
});

describe("the duplicate-IP notice reflects whether the collision is handled", () => {
	// (1) Nothing disambiguates the twins yet, so the operator genuinely has a
	//     link that cannot be told from its sibling. The band belongs here.
	test("mapping INACTIVE raises netif_dup_ip for the twin pair", () => {
		degradeBondMapping();
		pollNetif();

		const notice = notificationExists(NETIF_DUP_IP_NOTIFICATION);
		expect(notice).toBeDefined();
		// Defect (a): a handled-or-not condition is never an `error`.
		expect(notice?.type).toBe("warning");
		// The uninvolved uplink is never named.
		expect(notice?.msg).not.toContain(SOLO_IF);
	});

	// (5) The exact string, because the retired one contradicted its own
	//     severity and a paraphrase would let that regress unnoticed.
	test("the raised message states WHY the pair is still ambiguous, verbatim", () => {
		degradeBondMapping();
		pollNetif();

		expect(notificationExists(NETIF_DUP_IP_NOTIFICATION)?.msg).toBe(
			MAPPING_INACTIVE_MSG,
		);
	});

	// (2) Defect (b): with the mapping in force the sender binds
	//     SO_BINDTODEVICE, so both twins really do carry traffic and really are
	//     distinguishable. Claiming an error there is the contradiction.
	test("mapping ACTIVE with both entries mappable raises no error-severity notice", () => {
		pollNetif();
		activateBondMapping();
		pollNetif();

		const notice = notificationExists(NETIF_DUP_IP_NOTIFICATION);
		expect(notice?.type).not.toBe("error");
		// "at most informational" — this build says nothing at all, because the
		// per-interface `error: "duplicate IPv4 addr"` already rides the netif
		// wire and the Network page renders it.
		expect(notice).toBeUndefined();
	});

	// (3) THE REGRESSION THIS TODO EXISTS FOR. Defect (c): the interface set is
	//     byte-identical across the transition, so an `intsChanged`-gated block
	//     re-evaluates nothing and the band stands forever.
	test("inactive -> active with an UNCHANGED interface set CLEARS the notice", () => {
		degradeBondMapping();
		pollNetif();
		expect(notificationExists(NETIF_DUP_IP_NOTIFICATION)).toBeDefined();

		const before = getNetworkInterfaces();
		const snapshotBefore = JSON.stringify(before);

		activateBondMapping();
		const frames = captureFrames(() => {
			pollNetif();
		});

		// Non-vacuity: the interface set really did not move, so nothing but the
		// mapping state can have driven the retraction.
		expect(JSON.stringify(getNetworkInterfaces())).toBe(snapshotBefore);
		expect(notificationExists(NETIF_DUP_IP_NOTIFICATION)).toBeUndefined();
		expect(removedIds(frames)).toContain(NETIF_DUP_IP_NOTIFICATION);
	});

	// (4) A mapped bond whose identity resolution genuinely degraded: the row
	//     cannot be published for that link, so it is NOT disambiguated and the
	//     warning is real.
	test("a mapped pair with one unmappable entry still warns", () => {
		failIdentityFor(TWIN_B);
		pollNetif();
		activateBondMapping();
		pollNetif();

		const notice = notificationExists(NETIF_DUP_IP_NOTIFICATION);
		expect(notice).toBeDefined();
		expect(notice?.type).toBe("warning");
		expect(notice?.msg).toBe(IDENTITY_DEGRADED_MSG);
	});

	// (6) A degraded bond is not a broken device, so the band must say so
	//     outright rather than leave an operator wondering. The promise is
	//     about STREAMING, never today's bonding protocol: a second transport
	//     is already on the roadmap (`TD-plain-srt-egress`).
	test("both branches promise streaming is unaffected and name no protocol", () => {
		for (const msg of [MAPPING_INACTIVE_MSG, IDENTITY_DEGRADED_MSG]) {
			expect(msg).toContain("Streaming is not affected.");
			expect(msg).not.toMatch(/srtla|\brist\b|\bsrt\b/i);
		}
	});
});

describe("QA: the bench twin fixture across a mapping-inactive -> active flip", () => {
	test("the frames an operator receives are raise-then-retract, and nothing else", () => {
		degradeBondMapping();

		const raiseFrames = captureFrames(() => {
			pollNetif();
		});
		const raised = shownNotices(raiseFrames).filter(
			(n) => n.name === NETIF_DUP_IP_NOTIFICATION,
		);
		expect(raised).toHaveLength(1);
		expect(raised[0]?.type).toBe("warning");
		expect(raised[0]?.msg).toBe(MAPPING_INACTIVE_MSG);
		expect(removedIds(raiseFrames)).not.toContain(NETIF_DUP_IP_NOTIFICATION);

		// A second poll while nothing moved must not re-broadcast the band.
		const idleFrames = captureFrames(() => {
			pollNetif();
		});
		expect(
			shownNotices(idleFrames).filter(
				(n) => n.name === NETIF_DUP_IP_NOTIFICATION,
			),
		).toHaveLength(0);
		expect(removedIds(idleFrames)).not.toContain(NETIF_DUP_IP_NOTIFICATION);

		activateBondMapping();
		const clearFrames = captureFrames(() => {
			pollNetif();
		});
		expect(removedIds(clearFrames)).toContain(NETIF_DUP_IP_NOTIFICATION);
		expect(
			shownNotices(clearFrames).filter(
				(n) => n.name === NETIF_DUP_IP_NOTIFICATION,
			),
		).toHaveLength(0);
	});

	test("a bond with no collision at all never raises the band", () => {
		degradeBondMapping();
		processIfconfigOutput(ifconfigStanza(SOLO_IF, SOLO_IP));

		expect(notificationExists(NETIF_DUP_IP_NOTIFICATION)).toBeUndefined();
	});
});

/*
  THE MAPPING STATE IS A TRI-STATE, AND THE BOOLEAN COULD NOT EXPRESS IT.

  `isBondMappingActive()` answers `false` for two facts that call for OPPOSITE
  operator copy: no bond has been described at all, and a described mapping that
  is degraded. Reading that one bit told an IDLE operator — nothing launched,
  both twins perfectly mappable — that "only one of them can carry bonded
  traffic", which is a claim about a bond that does not exist. Every case below
  drives the SHIPPED `wireDupIpNoticeDeps()` pair, so the state under test is the
  same `getBondMappingState()` the producer reads.
*/
describe("the notice is decided on none | active | degraded", () => {
	test("`none` with every twin mappable is SILENT", () => {
		pollNetif();

		expect(getBondMappingState()).toBe("none");
		// Non-vacuity: the collision is real and both members are describable, so
		// the silence is the verdict rather than an absent group.
		expect(getNetworkInterfaces()[TWIN_A]?.ip).toBe(TWIN_IP);
		expect(getNetworkInterfaces()[TWIN_B]?.ip).toBe(TWIN_IP);
		expect(isBondLinkMappable(TWIN_A, TWIN_IP)).toBe(true);
		expect(isBondLinkMappable(TWIN_B, TWIN_IP)).toBe(true);
		expect(notificationExists(NETIF_DUP_IP_NOTIFICATION)).toBeUndefined();
	});

	test("`none` with an unmappable twin warns in the FUTURE tense", () => {
		failIdentityFor(TWIN_B);
		pollNetif();

		const notice = notificationExists(NETIF_DUP_IP_NOTIFICATION);
		expect(getBondMappingState()).toBe("none");
		expect(notice?.type).toBe("warning");
		expect(notice?.msg).toBe(IDLE_UNMAPPABLE_MSG);
		// It must claim NEITHER of the other two states: no launch has happened,
		// so nothing collapsed the addresses and no mapping is in force.
		expect(notice?.msg).not.toBe(MAPPING_INACTIVE_MSG);
		expect(notice?.msg).not.toContain("link mapping is active");
		expect(notice?.msg).not.toContain("link mapping is not active");
	});

	test("`none` does NOT weaken todo 41's unmappable refusal", () => {
		failIdentityFor(TWIN_B);
		pollNetif();

		// The band is an honesty surface; the exclusion itself is unchanged. A
		// dup-IP twin the writer cannot describe is still refused by
		// `isBondCandidate`, so it never reaches the entry list at all.
		const ifaces = genSrtlaBondEntries().map((entry) => entry.iface);
		expect(ifaces).toContain(TWIN_A);
		expect(ifaces).not.toContain(TWIN_B);
		expect(isBondLinkMappable(TWIN_B, TWIN_IP)).toBe(false);
		expect(getNetworkInterfaces()[TWIN_B]?.enabled).toBe(false);
	});

	test("the same collision reads three different ways across the tri-state", () => {
		const seen: Array<[string, string | undefined]> = [];

		pollNetif();
		seen.push([getBondMappingState(), messageNow()]);

		degradeBondMapping();
		pollNetif();
		seen.push([getBondMappingState(), messageNow()]);

		activateBondMapping();
		pollNetif();
		seen.push([getBondMappingState(), messageNow()]);

		expect(seen).toEqual([
			["none", undefined],
			["degraded", MAPPING_INACTIVE_MSG],
			["active", undefined],
		]);
	});

	test("a stop retires the described bond and the band goes back to silent", () => {
		degradeBondMapping();
		pollNetif();
		expect(notificationExists(NETIF_DUP_IP_NOTIFICATION)).toBeDefined();

		clearBindMapReport();
		const frames = captureFrames(() => {
			pollNetif();
		});

		expect(getBondMappingState()).toBe("none");
		expect(removedIds(frames)).toContain(NETIF_DUP_IP_NOTIFICATION);
		expect(notificationExists(NETIF_DUP_IP_NOTIFICATION)).toBeUndefined();
	});
});

describe("getBondMappingState folds only what a consumer may act on", () => {
	test("no described bond is `none`, and the boolean cannot say so", () => {
		expect(getBondMappingState()).toBe("none");
		expect(isBondMappingActive()).toBe(false);
	});

	test("a mapped launch is `active`", () => {
		pollNetif();
		activateBondMapping();

		expect(getBondMappingState()).toBe("active");
		expect(isBondMappingActive()).toBe(true);
	});

	test("a launch the sender could not honour is `degraded`", () => {
		pollNetif();
		degradeBondMapping();

		expect(getBondMappingState()).toBe("degraded");
		expect(isBondMappingActive()).toBe(false);
	});

	test("a sender-reported `absent` folds into `degraded`, keeping its reason", () => {
		// `absent` and `degraded` are one fact to a consumer — a DESCRIBED bond
		// whose mapping is not in force — and the precise reason still rides
		// `status.reason` for anyone who needs it.
		noteSenderBindMapReport({
			status: { state: "absent", reason: "missing_file" },
			disposition: { state: "legacy_unique_only" },
		});

		expect(getBondMappingState()).toBe("degraded");
		expect(isBondMappingActive()).toBe(false);
	});

	test("`isBondMappingActive` is byte-unchanged for every state", () => {
		const table: Array<[() => void, boolean]> = [
			[() => clearBindMapReport(), false],
			[() => activateBondMapping(), true],
			[() => degradeBondMapping(), false],
		];
		pollNetif();
		for (const [arrange, expected] of table) {
			arrange();
			expect(isBondMappingActive()).toBe(expected);
		}
	});
});
