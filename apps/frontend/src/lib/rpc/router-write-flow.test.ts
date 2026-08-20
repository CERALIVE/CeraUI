/**
 * The bounded-confirmation machine behind every router-dongle write.
 *
 * The property under test is the one the retired code could not express: the
 * THIRD answer. A write is applied, refused, or NOT CONFIRMED — and the last one
 * has to be reachable, terminal, and distinct from the other two, or the surface
 * falls back to the defect it replaced (a spinner that stops, a control that has
 * not moved, and nothing on screen to say which of the three happened).
 */
import type { RouterAdmin } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	beginRouterWrite,
	failRouterWrite,
	isRouterWriteBusy,
	isSameRouterWriteTarget,
	observeRouterWrite,
	ROUTER_WRITE_CONFIRM_WINDOW_MS,
	type RouterWriteTarget,
	resolveRouterWrite,
	routerWriteObserved,
	tickRouterWrite,
} from "./router-write-flow";

const T0 = 1_000_000;

const CONTROL_ON: RouterWriteTarget = {
	kind: "control",
	control: "mobile_data",
	value: true,
};
const MODE_LTE: RouterWriteTarget = { kind: "net-mode", mode: "03" };

function admin(overrides: Partial<RouterAdmin> = {}): RouterAdmin {
	return {
		admin_url: "http://192.168.8.1",
		reachable: true,
		...overrides,
	} as RouterAdmin;
}

const withControls = (mobileData: boolean): RouterAdmin =>
	admin({ controls: { mobile_data: mobileData, roaming_autoconnect: false } });

const withMode = (current: string): RouterAdmin =>
	admin({
		capabilities: {
			net_mode: {
				state: "reported",
				modes: [{ id: "03" }, { id: "02" }],
				current,
			},
		},
	});

describe("routerWriteObserved — absence is never a match", () => {
	it("matches a control the device now reports at the requested value", () => {
		expect(routerWriteObserved(withControls(true), CONTROL_ON)).toBe(true);
	});

	it("does not match the opposite value", () => {
		expect(routerWriteObserved(withControls(false), CONTROL_ON)).toBe(false);
	});

	it("does not match a device that publishes no controls at all", () => {
		expect(routerWriteObserved(admin(), CONTROL_ON)).toBe(false);
	});

	it("does not match an absent reading", () => {
		expect(routerWriteObserved(undefined, CONTROL_ON)).toBe(false);
	});

	it("matches a net mode the device now reports as current", () => {
		expect(routerWriteObserved(withMode("03"), MODE_LTE)).toBe(true);
		expect(routerWriteObserved(withMode("02"), MODE_LTE)).toBe(false);
	});

	// A capability read that came back `unavailable` told us nothing about the
	// write, and reading "nothing" as "applied" is the whole defect class.
	it("does not match when the capability read is unavailable", () => {
		const unavailable = admin({
			capabilities: {
				net_mode: { state: "unavailable", reason: "refused", code: "112008" },
			},
		});
		expect(routerWriteObserved(unavailable, MODE_LTE)).toBe(false);
	});
});

describe("the happy path confirms on the OBSERVATION, not on the reply", () => {
	it("a successful reply only OPENS the window", () => {
		const dispatched = beginRouterWrite(CONTROL_ON);
		const resolved = resolveRouterWrite(dispatched, { success: true }, T0);

		expect(resolved.phase).toBe("awaiting");
		expect(resolved.deadlineAt).toBe(T0 + ROUTER_WRITE_CONFIRM_WINDOW_MS);
		expect(isRouterWriteBusy(resolved)).toBe(true);
	});

	it("the confirming observation is what reaches `applied`", () => {
		const resolved = resolveRouterWrite(
			beginRouterWrite(CONTROL_ON),
			{ success: true },
			T0,
		);
		const confirmed = observeRouterWrite(resolved, withControls(true));

		expect(confirmed.phase).toBe("applied");
		expect(confirmed.deadlineAt).toBeUndefined();
		expect(isRouterWriteBusy(confirmed)).toBe(false);
	});

	// The backend re-broadcasts the moment it has verified, and that frame can
	// legally beat the RPC reply back to the browser.
	it("a match seen BEFORE the reply is buffered and consumed at resolution", () => {
		const buffered = observeRouterWrite(
			beginRouterWrite(CONTROL_ON),
			withControls(true),
		);
		expect(buffered.phase).toBe("dispatching");
		expect(buffered.bufferedMatch).toBe(true);

		const resolved = resolveRouterWrite(buffered, { success: true }, T0);
		expect(resolved.phase).toBe("applied");
		expect(resolved.deadlineAt).toBeUndefined();
	});

	it("a repeat observation returns the SAME object, so a reactive consumer cannot loop", () => {
		const buffered = observeRouterWrite(
			beginRouterWrite(CONTROL_ON),
			withControls(true),
		);
		expect(observeRouterWrite(buffered, withControls(true))).toBe(buffered);
	});
});

describe("the bound produces the third answer, and it is terminal", () => {
	it("expiry renders `unconfirmed` — never a success, never a refusal", () => {
		const resolved = resolveRouterWrite(
			beginRouterWrite(CONTROL_ON),
			{ success: true },
			T0,
		);

		expect(tickRouterWrite(resolved, T0 + 1).phase).toBe("awaiting");

		const expired = tickRouterWrite(
			resolved,
			T0 + ROUTER_WRITE_CONFIRM_WINDOW_MS,
		);
		expect(expired.phase).toBe("unconfirmed");
		expect(expired.deadlineAt).toBeUndefined();
		expect(isRouterWriteBusy(expired)).toBe(false);
	});

	// Once the operator has been told the outcome is unknown, the honest repair
	// is a fresh read — not a retroactive edit of what they were told.
	it("a late observation cannot upgrade an `unconfirmed` write into a success", () => {
		const expired = tickRouterWrite(
			resolveRouterWrite(beginRouterWrite(CONTROL_ON), { success: true }, T0),
			T0 + ROUTER_WRITE_CONFIRM_WINDOW_MS,
		);
		expect(observeRouterWrite(expired, withControls(true)).phase).toBe(
			"unconfirmed",
		);
	});

	it("a late observation cannot resurrect a refused write either", () => {
		const refused = resolveRouterWrite(
			beginRouterWrite(CONTROL_ON),
			{ success: false, error: "not_applied" },
			T0,
		);
		expect(refused.phase).toBe("refused");
		expect(observeRouterWrite(refused, withControls(true)).phase).toBe(
			"refused",
		);
	});
});

describe("a refusal carries the device's own reason, never a substitute", () => {
	it("keeps the typed error", () => {
		const refused = resolveRouterWrite(
			beginRouterWrite(CONTROL_ON),
			{ success: false, error: "not_applied" },
			T0,
		);
		expect(refused.error).toBe("not_applied");
		expect(refused.deadlineAt).toBeUndefined();
	});

	it("keeps the vendor's own code on a net-mode refusal", () => {
		const refused = resolveRouterWrite(
			beginRouterWrite(MODE_LTE),
			{ success: false, error: "capability_unavailable", code: "112008" },
			T0,
		);
		expect(refused.error).toBe("capability_unavailable");
		expect(refused.code).toBe("112008");
	});

	it("falls back to the mutation refusal when no transport error was named", () => {
		const refused = resolveRouterWrite(
			beginRouterWrite(CONTROL_ON),
			{ success: false, mutationRefusal: "streaming_active" },
			T0,
		);
		expect(refused.error).toBe("streaming_active");
	});

	it("a thrown call is `unreachable` — the dongle never answered us", () => {
		const failed = failRouterWrite(beginRouterWrite(CONTROL_ON));
		expect(failed.phase).toBe("refused");
		expect(failed.error).toBe("unreachable");
	});

	it("an absent result is a refusal, not a silent success", () => {
		expect(
			resolveRouterWrite(beginRouterWrite(CONTROL_ON), undefined, T0).phase,
		).toBe("refused");
	});
});

describe("target identity", () => {
	it("separates the two controls, the two values, and the two modes", () => {
		expect(isSameRouterWriteTarget(CONTROL_ON, CONTROL_ON)).toBe(true);
		expect(
			isSameRouterWriteTarget(CONTROL_ON, { ...CONTROL_ON, value: false }),
		).toBe(false);
		expect(
			isSameRouterWriteTarget(CONTROL_ON, {
				kind: "control",
				control: "roaming_autoconnect",
				value: true,
			}),
		).toBe(false);
		expect(
			isSameRouterWriteTarget(MODE_LTE, { kind: "net-mode", mode: "02" }),
		).toBe(false);
		expect(isSameRouterWriteTarget(MODE_LTE, CONTROL_ON)).toBe(false);
	});
});
