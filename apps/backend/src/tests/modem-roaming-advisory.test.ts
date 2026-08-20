/*
 * The per-modem ROAMING ADVISORY contract (todo 40).
 *
 * Three properties are load-bearing and each has its own block below:
 *
 *   1. It RETRACTS. A persistent notification never expires on its own
 *      (`notificationRemaining()` returns "lives forever" for every one of
 *      them), so the raise sites here are only correct if the matching
 *      retractions fire — on roaming ending AND on the modem disappearing.
 *   2. It is KEYED, with a stated fallback chain. Two modems must never share
 *      one notification slot, and a modem with no usable key is suppressed
 *      rather than collided.
 *   3. It NEVER GATES. Roaming is a billing fact; it must not reach streaming
 *      or bonding, and it must not so much as mutate the payload it reads.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { broadcastModems } from "../modules/modems/modem-status.ts";
import {
	removeModem,
	type Modem as StateModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import {
	evaluateRoamingAdvisories,
	evaluateRoamingAdvisoriesForWire,
	ROAMING_ADVISORY_KEY,
	ROAMING_ADVISORY_PREFIX,
	type RoamingAdvisoryDeps,
	type RoamingObservation,
	type RoamingWireModem,
	resetRoamingAdvisoryState,
	roamingAdvisoryName,
	roamingAdvisorySlot,
	standingRoamingAdvisoryNames,
} from "../modules/modems/roaming-advisory.ts";
import { notificationRemove } from "../modules/ui/notifications.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";

interface NotifyCall {
	name: string;
	type: string;
	msg: string;
	duration: number;
	isPersistent: boolean;
	isDismissable: boolean;
	key: string | undefined;
	params: Record<string, unknown> | undefined;
}

function harness(): {
	deps: RoamingAdvisoryDeps;
	notifies: NotifyCall[];
	removes: string[];
} {
	const notifies: NotifyCall[] = [];
	const removes: string[] = [];
	const deps = {
		notify: (
			name: string,
			type: string,
			msg: string,
			duration = 0,
			isPersistent = false,
			isDismissable = true,
			_authedOnly = true,
			key?: string,
			params?: Record<string, unknown>,
		) => {
			notifies.push({
				name,
				type,
				msg,
				duration,
				isPersistent,
				isDismissable,
				key,
				params,
			});
			return true;
		},
		removeNotification: (name: string) => {
			removes.push(name);
			return { remove: [{ id: name, revision: 1 }] };
		},
	} as unknown as RoamingAdvisoryDeps;
	return { deps, notifies, removes };
}

function observation(
	overrides: Partial<RoamingObservation> = {},
): RoamingObservation {
	return {
		stableKey: "platform-fc880000.usb-usb-0:1.4.1",
		wireId: "2",
		label: "RM530N-GL - 12345",
		roaming: true,
		...overrides,
	};
}

beforeEach(() => {
	resetRoamingAdvisoryState();
});

describe("roaming advisory — raise on transition", () => {
	it("raises exactly one calm, persistent, dismissable, keyed advisory", () => {
		const { deps, notifies, removes } = harness();

		const result = evaluateRoamingAdvisories([observation()], deps);

		expect(result.raised).toEqual([
			`${ROAMING_ADVISORY_PREFIX}platform-fc880000.usb-usb-0:1.4.1`,
		]);
		expect(result.retracted).toEqual([]);
		expect(removes).toEqual([]);
		expect(notifies).toHaveLength(1);

		const raised = notifies[0];
		expect(raised?.type).toBe("info");
		expect(raised?.isPersistent).toBe(true);
		// The documented safety net: the automatic retraction is the mechanism,
		// but a wedged poll loop must never trap an operator under it.
		expect(raised?.isDismissable).toBe(true);
		expect(raised?.key).toBe(ROAMING_ADVISORY_KEY);
		expect(raised?.params).toEqual({ name: "RM530N-GL - 12345" });
		expect(raised?.msg).toContain("RM530N-GL - 12345");
	});

	it("says nothing at all while no modem is roaming", () => {
		const { deps, notifies, removes } = harness();

		const result = evaluateRoamingAdvisories(
			[observation({ roaming: false })],
			deps,
		);

		expect(result).toEqual({ raised: [], retracted: [] });
		expect(notifies).toEqual([]);
		expect(removes).toEqual([]);
	});

	it("reads the modem's registration claim, NOT the roaming PERMISSION", () => {
		const { deps, notifies } = harness();

		// `config.roaming: true` with `status.roaming: false` is the ordinary case
		// of a modem allowed to roam that is sitting on its home network. Advising
		// on it would report a setting back to the operator who set it.
		evaluateRoamingAdvisoriesForWire(
			{
				"2": {
					name: "RM530N-GL",
					ifname: "wwan0",
					stable_key: "path-a",
					config: { roaming: true },
					status: { roaming: false },
				} as RoamingWireModem,
			},
			deps,
		);

		expect(notifies).toEqual([]);
	});

	it("says nothing about a row that reports no radio status at all", () => {
		const { deps, notifies } = harness();

		// Every `router-ethernet` dongle is this row: the backend omits `status`
		// rather than fabricating a zeroed one, so this build cannot vouch for a
		// roaming answer either way and must not invent one.
		evaluateRoamingAdvisoriesForWire(
			{ "1": { name: "MF79U", ifname: "enx0c5b", stable_key: "path-z" } },
			deps,
		);

		expect(notifies).toEqual([]);
	});
});

describe("roaming advisory — one raise per episode", () => {
	it("never re-toasts an unchanged roaming state", () => {
		const { deps, notifies } = harness();

		evaluateRoamingAdvisories([observation()], deps);
		for (let i = 0; i < 5; i++) {
			const repeat = evaluateRoamingAdvisories([observation()], deps);
			expect(repeat).toEqual({ raised: [], retracted: [] });
		}

		expect(notifies).toHaveLength(1);
	});

	it("does not re-raise when only the device LABEL changes mid-episode", () => {
		const { deps, notifies } = harness();

		evaluateRoamingAdvisories([observation()], deps);
		evaluateRoamingAdvisories(
			[observation({ label: "Quectel RM530N-GL" })],
			deps,
		);

		expect(notifies).toHaveLength(1);
	});

	it("raises again for a SECOND episode after the first one ended", () => {
		const { deps, notifies, removes } = harness();

		evaluateRoamingAdvisories([observation()], deps);
		evaluateRoamingAdvisories([observation({ roaming: false })], deps);
		evaluateRoamingAdvisories([observation()], deps);

		expect(notifies).toHaveLength(2);
		expect(removes).toHaveLength(1);
	});
});

describe("roaming advisory — retraction", () => {
	it("retracts when the modem's own next registration state says it stopped", () => {
		const { deps, removes } = harness();
		evaluateRoamingAdvisories([observation()], deps);

		const result = evaluateRoamingAdvisories(
			[observation({ roaming: false })],
			deps,
		);

		const name = roamingAdvisoryName("platform-fc880000.usb-usb-0:1.4.1");
		expect(result.retracted).toEqual([name]);
		expect(removes).toEqual([name]);
		expect(standingRoamingAdvisoryNames()).toEqual([]);
	});

	it("retracts when the modem DISAPPEARS from the broadcast", () => {
		const { deps, removes } = harness();
		evaluateRoamingAdvisories([observation()], deps);

		// A device-absent modem emits no further registration states. Leaving the
		// advisory standing here is the `policy_route_missing` latch class: a
		// permanent claim about hardware that is no longer in the board.
		const result = evaluateRoamingAdvisories([], deps);

		expect(result.retracted).toEqual([
			roamingAdvisoryName("platform-fc880000.usb-usb-0:1.4.1"),
		]);
		expect(removes).toHaveLength(1);
		expect(standingRoamingAdvisoryNames()).toEqual([]);
	});

	it("retracts only the modem that stopped, leaving its roaming sibling alone", () => {
		const { deps, removes, notifies } = harness();
		const a = observation({ stableKey: "path-a", wireId: "2", label: "A" });
		const b = observation({ stableKey: "path-b", wireId: "4", label: "B" });
		evaluateRoamingAdvisories([a, b], deps);
		expect(notifies).toHaveLength(2);

		evaluateRoamingAdvisories([{ ...a, roaming: false }, b], deps);

		expect(removes).toEqual([roamingAdvisoryName("path-a")]);
		expect(standingRoamingAdvisoryNames()).toEqual([
			roamingAdvisoryName("path-b"),
		]);
	});

	it("is idempotent once retracted — a steady non-roaming state emits nothing", () => {
		const { deps, removes } = harness();
		evaluateRoamingAdvisories([observation()], deps);
		evaluateRoamingAdvisories([], deps);

		evaluateRoamingAdvisories([], deps);
		evaluateRoamingAdvisories([observation({ roaming: false })], deps);

		expect(removes).toHaveLength(1);
	});
});

describe("roaming advisory — the key chain", () => {
	it("prefers stable_key over the legacy wire id", () => {
		expect(roamingAdvisorySlot(observation())).toBe(
			"platform-fc880000.usb-usb-0:1.4.1",
		);
	});

	it("falls back to the legacy wire id when stable_key is absent", () => {
		const { deps, notifies } = harness();

		// `stable_key` is OPTIONAL by todo 17's contract — a modem with no udev
		// ID_PATH still deserves the advisory.
		evaluateRoamingAdvisories([observation({ stableKey: undefined })], deps);

		expect(notifies[0]?.name).toBe(`${ROAMING_ADVISORY_PREFIX}2`);
	});

	it("treats a blank stable_key as absent rather than as a slot", () => {
		expect(roamingAdvisorySlot(observation({ stableKey: "   " }))).toBe("2");
	});

	it("SUPPRESSES the advisory for a modem with neither key", () => {
		const { deps, notifies, removes } = harness();

		const result = evaluateRoamingAdvisories(
			[observation({ stableKey: undefined, wireId: "" })],
			deps,
		);

		expect(
			roamingAdvisorySlot(observation({ stableKey: undefined, wireId: "" })),
		).toBeUndefined();
		expect(result).toEqual({ raised: [], retracted: [] });
		expect(notifies).toEqual([]);
		expect(removes).toEqual([]);
	});

	it("never lets two keyless modems collide on a shared slot", () => {
		const { deps, notifies } = harness();

		evaluateRoamingAdvisories(
			[
				observation({ stableKey: undefined, wireId: undefined, label: "A" }),
				observation({ stableKey: undefined, wireId: undefined, label: "B" }),
			],
			deps,
		);

		expect(notifies).toEqual([]);
	});

	it("survives a mid-episode renumber: same stable_key, new wire id, one advisory", () => {
		const { deps, notifies, removes } = harness();
		evaluateRoamingAdvisories([observation({ wireId: "2" })], deps);

		evaluateRoamingAdvisories([observation({ wireId: "7" })], deps);

		expect(notifies).toHaveLength(1);
		expect(removes).toEqual([]);
	});

	it("keys two roaming modems into two distinct slots", () => {
		const { deps, notifies } = harness();

		evaluateRoamingAdvisories(
			[
				observation({ stableKey: "path-a", wireId: "2" }),
				observation({ stableKey: "path-b", wireId: "4" }),
			],
			deps,
		);

		expect(notifies.map((n) => n.name)).toEqual([
			roamingAdvisoryName("path-a"),
			roamingAdvisoryName("path-b"),
		]);
	});
});

describe("roaming advisory — it never gates", () => {
	const SOURCE = readFileSync(
		join(import.meta.dir, "..", "modules", "modems", "roaming-advisory.ts"),
		"utf8",
	);

	it("imports nothing from the streaming, bonding or network-control surfaces", () => {
		const imports = [...SOURCE.matchAll(/from\s+["']([^"']+)["']/g)].map(
			(m) => m[1] ?? "",
		);

		expect(imports).toEqual(["../ui/notifications.ts"]);
	});

	it("names no streaming/bonding control verb anywhere in its executable source", () => {
		// A grep gate rather than a comment: the next person to touch this file is
		// not going to read a paragraph asking them not to make roaming gate a
		// stream, and an advisory that can take a link out of the bond is a
		// different (unshipped) feature with its own confirmation design.
		//
		// Comments are stripped first — the module's own header EXPLAINS what it
		// must never reach, and a gate that failed on the explanation would push
		// the next author to delete the explanation.
		const code = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
			/(^|\s)\/\/[^\n]*/g,
			"$1",
		);

		for (const forbidden of [
			/\bstartStream\b/,
			/\bstopStream\b/,
			/\bsetBitrate\b/,
			/\bgetIsStreaming\b/,
			/\bsrtla\b/i,
			/\bbond(ing)?\b/i,
			/\benabled\s*=/,
			/modules\/streaming/,
			/modules\/network/,
		]) {
			expect(code).not.toMatch(forbidden);
		}
	});

	it("touches no effect surface beyond notify + removeNotification", () => {
		const touched = new Set<string>();
		const { deps } = harness();
		const watched = new Proxy(deps as unknown as Record<string, unknown>, {
			get(target, prop: string) {
				touched.add(prop);
				return target[prop];
			},
		}) as unknown as RoamingAdvisoryDeps;

		evaluateRoamingAdvisories([observation()], watched);
		evaluateRoamingAdvisories([], watched);

		expect([...touched].sort()).toEqual(["notify", "removeNotification"]);
	});

	it("leaves the modems payload it read byte-identical", () => {
		const { deps } = harness();
		const message: Record<string, RoamingWireModem> = {
			"2": {
				name: "RM530N-GL - 12345",
				ifname: "wwan0",
				stable_key: "path-a",
				status: { roaming: true },
			},
		};
		const before = JSON.stringify(message);

		evaluateRoamingAdvisoriesForWire(message, deps);

		expect(JSON.stringify(message)).toBe(before);
	});

	it("evaluates a deeply frozen payload without attempting to write to it", () => {
		const { deps, notifies } = harness();
		const modem: RoamingWireModem = Object.freeze({
			name: "RM530N-GL - 12345",
			ifname: "wwan0",
			stable_key: "path-a",
			status: Object.freeze({ roaming: true }),
		});

		expect(() =>
			evaluateRoamingAdvisoriesForWire(Object.freeze({ "2": modem }), deps),
		).not.toThrow();
		expect(notifies).toHaveLength(1);
	});
});

describe("roaming advisory — the broadcast seam", () => {
	function recordingClient(sink: string[]): AppWebSocket {
		return {
			data: { isAuthenticated: true, lastActive: Date.now() },
			send: (message: string) => sink.push(message),
		} as unknown as AppWebSocket;
	}

	function frames(run: () => void): Array<Record<string, unknown>> {
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

	function shownNotifications(
		captured: Array<Record<string, unknown>>,
	): Array<Record<string, unknown>> {
		return captured.flatMap((frame) => {
			const payload = frame.notification as
				| { show?: Array<Record<string, unknown>> }
				| undefined;
			return payload?.show ?? [];
		});
	}

	function removedIds(captured: Array<Record<string, unknown>>): string[] {
		return captured.flatMap((frame) => {
			const payload = frame.notification as
				| { remove?: Array<{ id: string }> }
				| undefined;
			return (payload?.remove ?? []).map((entry) => entry.id);
		});
	}

	function roamingModem(roaming: boolean): StateModem {
		return {
			ifname: "wwan0",
			name: "RM530N-GL - 12345",
			network_type: {
				supported: { "5g": { allowed: "5g", preferred: "none" } },
				active: "5g",
			},
			status: {
				connection: "connected",
				network: "Partner",
				network_type: "5G",
				signal: 61,
				roaming,
			},
		} as unknown as StateModem;
	}

	beforeEach(() => {
		removeModem(2);
		resetRoamingAdvisoryState();
	});

	afterEach(() => {
		removeModem(2);
		notificationRemove(roamingAdvisoryName("2"));
		resetRoamingAdvisoryState();
	});

	it("raises through the REAL notification store on a roaming broadcast", () => {
		setModem(2, roamingModem(true));

		const captured = frames(() => {
			broadcastModems();
		});

		const shown = shownNotifications(captured);
		const advisory = shown.find((n) =>
			String(n.name).startsWith(ROAMING_ADVISORY_PREFIX),
		);
		expect(advisory).toBeDefined();
		// `info` is only representable because the backend now uses the SHARED
		// wire enum; a store that rejected it would surface exactly here.
		expect(advisory?.type).toBe("info");
		expect(advisory?.is_persistent).toBe(true);
		expect(advisory?.is_dismissable).toBe(true);
		expect(advisory?.key).toBe(ROAMING_ADVISORY_KEY);
	});

	it("retracts through the REAL store when the modem leaves the broadcast", () => {
		setModem(2, roamingModem(true));
		frames(() => {
			broadcastModems();
		});

		removeModem(2);
		const captured = frames(() => {
			broadcastModems();
		});

		expect(removedIds(captured)).toContain(roamingAdvisoryName("2"));
	});

	it("leaves the modems payload identical whether or not an advisory fires", () => {
		setModem(2, roamingModem(true));

		const withAdvisory = frames(() => {
			broadcastModems();
		});
		// Second pass: the advisory is already standing, so it emits nothing —
		// and the modems payload must be the SAME bytes either way. That is the
		// never-gates claim stated as evidence rather than as a promise.
		const withoutAdvisory = frames(() => {
			broadcastModems();
		});

		const modemsPayload = (captured: Array<Record<string, unknown>>) =>
			captured
				.filter((frame) => frame.status !== undefined)
				.map((frame) => JSON.stringify(frame.status));

		expect(modemsPayload(withoutAdvisory)).toEqual(modemsPayload(withAdvisory));
		expect(shownNotifications(withoutAdvisory)).toEqual([]);
	});
});

describe("roaming advisory — wire adaptation", () => {
	it("labels the advisory with the modem name, falling back to the ifname", () => {
		const { deps, notifies } = harness();

		evaluateRoamingAdvisoriesForWire(
			{
				"2": { ifname: "wwan0", stable_key: "a", status: { roaming: true } },
				"4": {
					name: "SIM7600G-H",
					ifname: "wwan1",
					stable_key: "b",
					status: { roaming: true },
				},
			},
			deps,
		);

		expect(notifies.map((n) => n.params?.name)).toEqual([
			"wwan0",
			"SIM7600G-H",
		]);
	});

	it("uses the record key as the legacy id when no stable_key is on the row", () => {
		const { deps, notifies } = harness();

		evaluateRoamingAdvisoriesForWire(
			{ "4": { name: "SIM7600G-H", status: { roaming: true } } },
			deps,
		);

		expect(notifies[0]?.name).toBe(`${ROAMING_ADVISORY_PREFIX}4`);
	});
});
