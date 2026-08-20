/**
 * The gated USSD capability module, end to end.
 *
 * Four things are proved here, and the first two are why a state machine exists
 * at all rather than three independent RPCs:
 *
 *   1. THE TRANSITION TABLE — every (state, event) cell, each its own test. A
 *      USSD session is a scarce network-side resource: the subscriber gets ONE,
 *      so a verb that is illegal right now must be refused rather than sent, and
 *      "which verb is legal here" has a wrong answer that costs the operator a
 *      busy error nothing on screen explains.
 *   2. A REFUSED VERB DISPATCHES NOTHING. Not a network round-trip, not a state
 *      change — the doomed request must not disturb a live dialogue.
 *   3. THE LTE-ONLY CARRIER REFUSAL IS ITS OWN TYPED ANSWER. USSD is a
 *      circuit-switched supplementary service, so the identical mmcli failure
 *      means "this modem cannot" on a CS-capable registration and "this carrier
 *      will not, on this registration" on a packet-only one. Reporting the second
 *      as the first sends an operator hunting for a firmware fix for a network
 *      policy.
 *   4. THE GATE — off by default, capability-gated on top of that, and the lease
 *      taken before anything reaches the modem.
 *
 * The transition table is ALSO the Rule-D mirror proof for
 * `@ceralive/modem-control`'s `ussd/session.ts`: the pinned package predates that
 * module, so the two halves cannot share an import and are kept honest by
 * carrying the same enumerated table on both sides.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	UssdSessionSnapshot,
	UssdSessionState,
} from "@ceraui/rpc/schemas";
import { USSD_SESSION_STATES } from "@ceraui/rpc/schemas";
import { getConfig } from "../modules/config.ts";
import { setModemCapabilityEvidenceReader } from "../modules/modems/capability-gates.ts";
import {
	classifyUssdCliFailure,
	decodeUssdSessionState,
	isPacketSwitchedOnly,
	parseUssdReply,
	readUssdStatus,
	type UssdCliRunner,
	ussdRegistrationFromRecord,
} from "../modules/modems/mmcli-ussd.ts";
import {
	cancelModemUssd,
	initiateModemUssd,
	readModemUssd,
	resetModemUssdState,
	respondModemUssd,
	type UssdScheduler,
	ussdEvidence,
} from "../modules/modems/ussd.ts";
import {
	IDLE_USSD_SESSION,
	isUssdSessionOpen,
	reduceUssdSession,
	type UssdSessionEvent,
} from "../modules/modems/ussd-session.ts";
import { resetLifecycleInterlock } from "../modules/streaming/lifecycle-admission.ts";
import { resetRecoveryBarrier } from "../modules/streaming/recovery-barrier.ts";

const DEVICE = "0";
const KEY = "platform-xhci-hcd.0.auto-usb-0:1.4.4";
const BALANCE = "Your balance is $4.20. Ref 998877";

// ── 1. the transition table ──────────────────────────────────────────────────

const EVENTS = {
	initiate: { kind: "initiate" },
	respond: { kind: "respond" },
	cancel: { kind: "cancel" },
	"replied(awaiting-reply)": {
		kind: "replied",
		sessionState: "awaiting-reply",
	},
	"replied(active)": { kind: "replied", sessionState: "active" },
	"replied(released)": { kind: "replied", sessionState: "released" },
	cancelled: { kind: "cancelled" },
	"network-released": { kind: "network-released" },
	timeout: { kind: "timeout" },
	failed: { kind: "failed", reason: "carrier-rejected" },
} as const satisfies Record<string, UssdSessionEvent>;

type EventName = keyof typeof EVENTS;

const TABLE: Record<UssdSessionState, Record<EventName, string>> = {
	idle: {
		initiate: "open:initiating",
		respond: "refuse:invalid-state",
		cancel: "refuse:no-session",
		"replied(awaiting-reply)": "refuse:invalid-state",
		"replied(active)": "refuse:invalid-state",
		"replied(released)": "refuse:invalid-state",
		cancelled: "refuse:invalid-state",
		"network-released": "refuse:no-session",
		timeout: "refuse:no-session",
		failed: "refuse:no-session",
	},
	initiating: {
		initiate: "refuse:session-busy",
		respond: "refuse:invalid-state",
		cancel: "open:cancelling",
		"replied(awaiting-reply)": "open:awaiting-reply",
		"replied(active)": "open:active",
		"replied(released)": "close:completed",
		cancelled: "refuse:invalid-state",
		"network-released": "close:completed",
		timeout: "close:timed-out",
		failed: "close:failed",
	},
	active: {
		initiate: "refuse:session-busy",
		respond: "refuse:invalid-state",
		cancel: "open:cancelling",
		"replied(awaiting-reply)": "refuse:invalid-state",
		"replied(active)": "refuse:invalid-state",
		"replied(released)": "refuse:invalid-state",
		cancelled: "refuse:invalid-state",
		"network-released": "close:completed",
		timeout: "close:timed-out",
		failed: "close:failed",
	},
	"awaiting-reply": {
		initiate: "refuse:session-busy",
		respond: "open:responding",
		cancel: "open:cancelling",
		"replied(awaiting-reply)": "refuse:invalid-state",
		"replied(active)": "refuse:invalid-state",
		"replied(released)": "refuse:invalid-state",
		cancelled: "refuse:invalid-state",
		"network-released": "close:completed",
		timeout: "close:timed-out",
		failed: "close:failed",
	},
	responding: {
		initiate: "refuse:session-busy",
		respond: "refuse:invalid-state",
		cancel: "open:cancelling",
		"replied(awaiting-reply)": "open:awaiting-reply",
		"replied(active)": "open:active",
		"replied(released)": "close:completed",
		cancelled: "refuse:invalid-state",
		"network-released": "close:completed",
		timeout: "close:timed-out",
		failed: "close:failed",
	},
	cancelling: {
		initiate: "refuse:session-busy",
		respond: "refuse:invalid-state",
		cancel: "refuse:invalid-state",
		"replied(awaiting-reply)": "refuse:invalid-state",
		"replied(active)": "refuse:invalid-state",
		"replied(released)": "refuse:invalid-state",
		cancelled: "close:cancelled",
		"network-released": "close:cancelled",
		timeout: "close:timed-out",
		failed: "close:failed",
	},
	closed: {
		initiate: "refuse:no-session",
		respond: "refuse:no-session",
		cancel: "refuse:no-session",
		"replied(awaiting-reply)": "refuse:no-session",
		"replied(active)": "refuse:no-session",
		"replied(released)": "refuse:no-session",
		cancelled: "refuse:no-session",
		"network-released": "refuse:no-session",
		timeout: "refuse:no-session",
		failed: "refuse:no-session",
	},
};

const PATHS: Record<UssdSessionState, readonly UssdSessionEvent[]> = {
	idle: [],
	initiating: [EVENTS.initiate],
	active: [EVENTS.initiate, EVENTS["replied(active)"]],
	"awaiting-reply": [EVENTS.initiate, EVENTS["replied(awaiting-reply)"]],
	responding: [
		EVENTS.initiate,
		EVENTS["replied(awaiting-reply)"],
		EVENTS.respond,
	],
	cancelling: [EVENTS.initiate, EVENTS.cancel],
	closed: [EVENTS.initiate, EVENTS.timeout],
};

/** Reach a state by DRIVING the machine, so every table row is proven reachable. */
function drive(events: readonly UssdSessionEvent[]): UssdSessionSnapshot {
	let snapshot = IDLE_USSD_SESSION;
	for (const event of events) {
		const transition = reduceUssdSession(snapshot, event);
		if (!transition.ok) throw new Error(`unreachable: ${event.kind} refused`);
		snapshot = transition.snapshot;
	}
	return snapshot;
}

function describeTransition(
	transition: ReturnType<typeof reduceUssdSession>,
): string {
	if (!transition.ok) return `refuse:${transition.refusal}`;
	const { state, outcome } = transition.snapshot;
	return state === "closed" ? `close:${outcome}` : `open:${state}`;
}

describe("the USSD session transition table", () => {
	for (const state of USSD_SESSION_STATES) {
		const start = drive(PATHS[state]);
		for (const eventName of Object.keys(EVENTS) as EventName[]) {
			const expected = TABLE[state][eventName];
			test(`${state} + ${eventName} -> ${expected}`, () => {
				expect(start.state).toBe(state);
				expect(
					describeTransition(reduceUssdSession(start, EVENTS[eventName])),
				).toBe(expected);
			});
		}
	}

	test("the table covers every state and every event, and nothing more", () => {
		expect(Object.keys(TABLE).sort()).toEqual([...USSD_SESSION_STATES].sort());
		const events = Object.keys(EVENTS).sort();
		for (const state of USSD_SESSION_STATES) {
			expect(Object.keys(TABLE[state]).sort()).toEqual(events);
		}
	});

	test("a session is open in every state but idle and closed", () => {
		for (const state of USSD_SESSION_STATES) {
			expect(isUssdSessionOpen(drive(PATHS[state]))).toBe(
				state !== "idle" && state !== "closed",
			);
		}
	});
});

// ── 2. the mmcli layer ───────────────────────────────────────────────────────

describe("the mmcli USSD layer", () => {
	test("the session-state token decodes, and an unknown token releases", () => {
		expect(decodeUssdSessionState("user-response")).toBe("awaiting-reply");
		expect(decodeUssdSessionState("active")).toBe("active");
		expect(decodeUssdSessionState("idle")).toBe("released");
		// An unreadable state must CLOSE the session rather than leave an operator
		// looking at a dialogue nothing can advance.
		expect(decodeUssdSessionState("unknown")).toBe("released");
		expect(decodeUssdSessionState(undefined)).toBe("released");
	});

	test("the reply parser accepts both mmcli shapes and quotes are stripped", () => {
		expect(parseUssdReply(`modem.3gpp.ussd.reply : '${BALANCE}'`)).toBe(
			BALANCE,
		);
		expect(
			parseUssdReply(
				`successfully sent USSD command:\n    Reply: '${BALANCE}'\n`,
			),
		).toBe(BALANCE);
	});

	test("an unrecognised shape yields NO reply rather than a guess", () => {
		expect(parseUssdReply("successfully sent USSD command:")).toBeUndefined();
		expect(parseUssdReply("modem.3gpp.ussd.status : idle")).toBeUndefined();
		expect(parseUssdReply("Reply: --")).toBeUndefined();
	});

	test("registration facts come from the modem's own record", () => {
		expect(
			ussdRegistrationFromRecord({
				"modem.3gpp.registration-state": "home",
				"modem.generic.access-technologies": ["lte"],
			}),
		).toEqual({
			registered: true,
			csDomain: false,
			accessTechnologies: ["lte"],
		});
		// CSFB says outright that the CS domain is reachable, so the radio in use
		// does not get to overrule it.
		expect(
			ussdRegistrationFromRecord({
				"modem.3gpp.registration-state": "home-csfb-not-preferred",
				"modem.generic.access-technologies": ["lte"],
			}).csDomain,
		).toBe(true);
		// An unread technology list declares nothing.
		expect(
			ussdRegistrationFromRecord({ "modem.3gpp.registration-state": "home" })
				.csDomain,
		).toBeUndefined();
		expect(
			ussdRegistrationFromRecord({
				"modem.3gpp.registration-state": "searching",
			}).registered,
		).toBe(false);
	});

	test("packet-switched-only needs evidence in BOTH directions", () => {
		expect(
			isPacketSwitchedOnly({
				registered: true,
				csDomain: false,
				accessTechnologies: ["lte"],
			}),
		).toBe(true);
		expect(
			isPacketSwitchedOnly({
				registered: true,
				csDomain: false,
				accessTechnologies: ["lte", "umts"],
			}),
		).toBe(false);
		expect(
			isPacketSwitchedOnly({ registered: true, accessTechnologies: ["lte"] }),
		).toBe(false);
		expect(isPacketSwitchedOnly({ registered: false })).toBe(false);
	});

	test("the SAME refusal reads differently on a CS-capable vs an LTE-only registration", () => {
		const cs = {
			registered: true,
			csDomain: true,
			accessTechnologies: ["umts"],
		};
		const lte = {
			registered: true,
			csDomain: false,
			accessTechnologies: ["lte"],
		};
		expect(classifyUssdCliFailure("operation not supported", cs)).toBe(
			"unsupported",
		);
		expect(classifyUssdCliFailure("operation not supported", lte)).toBe(
			"lte-only-unsupported",
		);
		expect(
			classifyUssdCliFailure("the network rejected the request", lte),
		).toBe("lte-only-unsupported");
	});

	test("reasons that are NOT ambiguous are never promoted", () => {
		const lte = {
			registered: true,
			csDomain: false,
			accessTechnologies: ["lte"],
		};
		expect(classifyUssdCliFailure("modem not registered", lte)).toBe(
			"not-registered",
		);
		expect(classifyUssdCliFailure("operation already in progress", lte)).toBe(
			"session-busy",
		);
		expect(classifyUssdCliFailure("no active USSD session", lte)).toBe(
			"no-session",
		);
		expect(classifyUssdCliFailure("couldn't find modem", lte)).toBe(
			"unknown_modem",
		);
		expect(classifyUssdCliFailure("some unrelated explosion", lte)).toBe(
			"transport-failed",
		);
	});

	test("a status read that answered but named no state key is drift, not an idle session", () => {
		return readUssdStatus(DEVICE, async () => "modem.3gpp.enabled : yes").then(
			(result) => {
				expect(result).toEqual({ ok: false, reason: "transport-failed" });
			},
		);
	});

	test("an invalid modem selector never reaches the CLI", async () => {
		let calls = 0;
		const result = await readUssdStatus("../etc/passwd", async () => {
			calls += 1;
			return "";
		});
		expect(result).toEqual({ ok: false, reason: "unknown_modem" });
		expect(calls).toBe(0);
	});
});

// ── 3. the module ────────────────────────────────────────────────────────────

type Script = {
	readonly initiate?: string | Error;
	readonly respond?: string | Error;
	readonly cancel?: Error;
	readonly status?: string;
};

function scripted(script: Script): { runCli: UssdCliRunner; args: string[][] } {
	const args: string[][] = [];
	const runCli: UssdCliRunner = (argv) => {
		args.push(argv);
		const flag = argv.find((entry) => entry.startsWith("--3gpp-ussd"));
		if (flag === undefined) {
			// The bare `-K -m <id>` registration read on the failure path.
			return Promise.resolve(
				"modem.3gpp.registration-state : home\nmodem.generic.access-technologies : lte",
			);
		}
		if (flag === "--3gpp-ussd-status") {
			return Promise.resolve(
				script.status ?? "modem.3gpp.ussd.status : user-response",
			);
		}
		if (flag === "--3gpp-ussd-cancel") {
			return script.cancel === undefined
				? Promise.resolve("")
				: Promise.reject(script.cancel);
		}
		const outcome = flag.startsWith("--3gpp-ussd-initiate")
			? script.initiate
			: script.respond;
		if (outcome instanceof Error) return Promise.reject(outcome);
		return Promise.resolve(outcome ?? `Reply: '${BALANCE}'`);
	};
	return { runCli, args };
}

function manualScheduler(): { scheduler: UssdScheduler; fire(): void } {
	let pending: (() => void) | undefined;
	return {
		scheduler: (_delayMs, run) => {
			pending = run;
			return {
				cancel: () => {
					pending = undefined;
				},
			};
		},
		fire: () => {
			pending?.();
			pending = undefined;
		},
	};
}

const identity = () => Promise.resolve({ stableKey: KEY });

function enableGate(): void {
	getConfig().modem_capabilities = { ussd: true };
}

function capable(): void {
	setModemCapabilityEvidenceReader(() => ({ capability: { ussd: "present" } }));
}

describe("the gated USSD module", () => {
	beforeEach(() => {
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		resetModemUssdState();
	});

	afterEach(() => {
		resetLifecycleInterlock();
		resetRecoveryBarrier();
		resetModemUssdState();
		setModemCapabilityEvidenceReader(null);
		delete getConfig().modem_capabilities;
	});

	test("the gate is OFF by default, and a refused verb reaches NO modem", async () => {
		capable();
		const { runCli, args } = scripted({});
		const result = await initiateModemUssd(DEVICE, "*123#", {
			runCli,
			resolveIdentity: identity,
		});
		expect(result.mutationRefusal).toBe("module_disabled");
		expect(result.success).toBe(false);
		expect(args).toHaveLength(0);
	});

	test("an UNPROVEN capability fails CLOSED, even with the gate on", async () => {
		enableGate();
		const { runCli, args } = scripted({});
		const result = await initiateModemUssd(DEVICE, "*123#", {
			runCli,
			resolveIdentity: identity,
		});
		expect(result.mutationRefusal).toBe("module_unavailable");
		expect(args).toHaveLength(0);
	});

	test("an unresolvable identity is refused before the gate and before the CLI", async () => {
		enableGate();
		capable();
		const { runCli, args } = scripted({});
		const result = await initiateModemUssd(DEVICE, "*123#", {
			runCli,
			resolveIdentity: () => Promise.resolve(undefined),
		});
		expect(result).toEqual({ success: false, error: "unknown_modem" });
		expect(args).toHaveLength(0);
	});

	test("an initiate the network answers with a question opens the dialogue", async () => {
		enableGate();
		capable();
		const timer = manualScheduler();
		const { runCli, args } = scripted({});
		const result = await initiateModemUssd(DEVICE, "*123#", {
			runCli,
			resolveIdentity: identity,
			scheduler: timer.scheduler,
		});

		expect(result.success).toBe(true);
		expect(result.session?.state).toBe("awaiting-reply");
		expect(result.ussdReply).toBe(BALANCE);
		expect(args[0]).toEqual(["-m", DEVICE, "--3gpp-ussd-initiate=*123#"]);
	});

	test("an initiate the network releases completes in one shot and resets to idle", async () => {
		enableGate();
		capable();
		const { runCli } = scripted({ status: "modem.3gpp.ussd.status : idle" });
		const deps = { runCli, resolveIdentity: identity };
		const result = await initiateModemUssd(DEVICE, "*123#", deps);

		expect(result.session).toEqual({ state: "closed", outcome: "completed" });
		// The very next dialogue is admitted rather than refused busy.
		const again = await initiateModemUssd(DEVICE, "*123#", deps);
		expect(again.error).not.toBe("session-busy");
	});

	test("responding continues the dialogue; a second initiate is refused with ZERO calls", async () => {
		enableGate();
		capable();
		const timer = manualScheduler();
		const { runCli, args } = scripted({});
		const deps = {
			runCli,
			resolveIdentity: identity,
			scheduler: timer.scheduler,
		};
		await initiateModemUssd(DEVICE, "*123#", deps);

		const busy = await initiateModemUssd(DEVICE, "*100#", deps);
		expect(busy.error).toBe("session-busy");
		const afterRefusal = args.length;

		const responded = await respondModemUssd(DEVICE, "1", deps);
		expect(responded.success).toBe(true);
		expect(responded.session?.state).toBe("awaiting-reply");
		expect(args[afterRefusal]).toEqual(["-m", DEVICE, "--3gpp-ussd-respond=1"]);
	});

	test("respond and cancel with no session are refused, and dispatch NOTHING", async () => {
		enableGate();
		capable();
		const { runCli, args } = scripted({});
		const deps = { runCli, resolveIdentity: identity };

		expect((await respondModemUssd(DEVICE, "1", deps)).error).toBe(
			"invalid-state",
		);
		expect((await cancelModemUssd(DEVICE, deps)).error).toBe("no-session");
		expect(args).toHaveLength(0);
	});

	test("cancelling mid-dialogue closes the session and dispatches Cancel", async () => {
		enableGate();
		capable();
		const timer = manualScheduler();
		const { runCli, args } = scripted({});
		const deps = {
			runCli,
			resolveIdentity: identity,
			scheduler: timer.scheduler,
		};
		await initiateModemUssd(DEVICE, "*123#", deps);

		const cancelled = await cancelModemUssd(DEVICE, deps);

		expect(cancelled.success).toBe(true);
		expect(cancelled.session).toEqual({
			state: "closed",
			outcome: "cancelled",
		});
		expect(args.at(-1)).toEqual(["-m", DEVICE, "--3gpp-ussd-cancel"]);
	});

	test("an unanswered session closes at the bound and releases the network side", async () => {
		enableGate();
		capable();
		const timer = manualScheduler();
		const { runCli, args } = scripted({});
		const deps = {
			runCli,
			resolveIdentity: identity,
			scheduler: timer.scheduler,
		};
		await initiateModemUssd(DEVICE, "*123#", deps);
		expect(args.some((argv) => argv.includes("--3gpp-ussd-cancel"))).toBe(
			false,
		);

		timer.fire();
		await Promise.resolve();
		await Promise.resolve();

		// The next dialogue is admitted, which is the observable consequence of
		// the session having been closed rather than left dangling.
		const next = await initiateModemUssd(DEVICE, "*123#", deps);
		expect(next.error).not.toBe("session-busy");
		expect(args.some((argv) => argv.includes("--3gpp-ussd-cancel"))).toBe(true);
	});

	test("an LTE-only carrier rejection is surfaced as its own typed refusal", async () => {
		enableGate();
		capable();
		const { runCli } = scripted({
			initiate: new Error("error: operation not supported"),
		});
		const result = await initiateModemUssd(DEVICE, "*123#", {
			runCli,
			resolveIdentity: identity,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("lte-only-unsupported");
		expect(result.session).toEqual({
			state: "closed",
			outcome: "failed",
			refusal: "lte-only-unsupported",
		});
	});

	test("a failed dialogue is terminal for the SESSION, never for the modem", async () => {
		enableGate();
		capable();
		const { runCli } = scripted({
			initiate: new Error("error: the network rejected the request"),
		});
		const deps = { runCli, resolveIdentity: identity };
		await initiateModemUssd(DEVICE, "*123#", deps);

		const second = await initiateModemUssd(DEVICE, "*123#", deps);
		expect(second.error).not.toBe("session-busy");
	});

	test("the read records capability, and only a POSITIVE unsupported writes `absent`", async () => {
		const deps = { resolveIdentity: identity };
		expect(ussdEvidence(KEY)).toBe("unknown");

		await readModemUssd(DEVICE, {
			...deps,
			runCli: async () => "modem.3gpp.ussd.status : idle",
		});
		expect(ussdEvidence(KEY)).toBe("present");

		resetModemUssdState();
		await readModemUssd(DEVICE, {
			...deps,
			runCli: () => Promise.reject(new Error("error: some transient failure")),
		});
		// A failed read is a statement about the READ. Writing `absent` here would
		// hide a modem that does carry the interface.
		expect(ussdEvidence(KEY)).toBe("unknown");

		resetModemUssdState();
		await readModemUssd(DEVICE, {
			...deps,
			runCli: () => Promise.reject(new Error("error: no USSD support")),
		});
		expect(ussdEvidence(KEY)).toBe("absent");
	});
});
