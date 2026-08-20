/**
 * The USB-mode switch flow — the pure state machine.
 *
 * The property this suite exists to lock is that RPC success ALONE never moves
 * what the operator sees. Every other case here is one of the ways a naive
 * implementation gets that wrong: confirming on the reply, dropping a broadcast
 * that beat the reply back, starting the confirmation window at dispatch, or
 * correlating the device by an identifier the transition itself invalidates.
 */
import type { ModemList } from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	beginUsbModeFlow,
	canTrackUsbModeSwitch,
	displayedUsbMode,
	failUsbModeFlow,
	findModemByStableKey,
	isUsbModeFlowBusy,
	observeUsbModeSnapshot,
	resolveUsbModeFlow,
	tickUsbModeFlow,
	USB_MODE_CONFIRM_WINDOW_MS,
} from "$lib/rpc/usb-mode-flow";

const KEY = "platform-xhci-hcd.0-usb-1:2";
const T0 = 1_700_000_000_000;

function modems(
	entries: Array<{
		id: string;
		stableKey?: string;
		usbMode?: "qmi" | "mbim";
		ifname?: string;
	}>,
): ModemList {
	const list: ModemList = {};
	for (const entry of entries) {
		list[entry.id] = {
			ifname: entry.ifname ?? "wwan0",
			name: `modem ${entry.id}`,
			network_type: { supported: [], active: null },
			...(entry.stableKey !== undefined ? { stable_key: entry.stableKey } : {}),
			...(entry.usbMode !== undefined ? { usb_mode: entry.usbMode } : {}),
		};
	}
	return list;
}

function started(list?: ModemList) {
	return beginUsbModeFlow({ stableKey: KEY, target: "mbim", modems: list });
}

describe("device correlation", () => {
	it("matches by stable_key alone", () => {
		const list = modems([
			{ id: "0", stableKey: "other", usbMode: "mbim" },
			{ id: "1", stableKey: KEY, usbMode: "qmi" },
		]);
		expect(findModemByStableKey(list, KEY)?.usb_mode).toBe("qmi");
	});

	it("never falls back to the numeric id or the ifname", () => {
		// The transition RE-ISSUES the MM index and CHANGES the ifname, so a
		// fallback on either would confirm against a different device — or none.
		const list = modems([{ id: "0", ifname: "wwan0", usbMode: "mbim" }]);
		expect(findModemByStableKey(list, KEY)).toBeUndefined();
		expect(findModemByStableKey(list, "wwan0")).toBeUndefined();
		expect(findModemByStableKey(list, "0")).toBeUndefined();
	});

	it("refuses to track a modem that publishes no stable_key", () => {
		expect(canTrackUsbModeSwitch({ stable_key: KEY })).toBe(true);
		expect(canTrackUsbModeSwitch({})).toBe(false);
		expect(canTrackUsbModeSwitch({ stable_key: "" })).toBe(false);
	});
});

describe("RPC success alone never flips the displayed mode", () => {
	it("holds the spinner and the baseline mode after a successful reply", () => {
		const before = modems([{ id: "0", stableKey: KEY, usbMode: "qmi" }]);
		let flow = started(before);
		flow = resolveUsbModeFlow(flow, { success: true }, T0);

		expect(flow.phase).toBe("awaiting");
		expect(isUsbModeFlowBusy(flow)).toBe(true);
		// The feed has NOT changed, so the display has not either.
		expect(displayedUsbMode(before, KEY, flow)).toBe("qmi");
	});

	it("flips ONLY once a snapshot reports the target for THIS device", () => {
		let flow = resolveUsbModeFlow(
			started(modems([{ id: "0", stableKey: KEY, usbMode: "qmi" }])),
			{ success: true },
			T0,
		);
		// The transition re-issued the MM index AND changed the ifname — the
		// device is only recognisable by its stable key.
		const after = modems([
			{ id: "7", stableKey: KEY, usbMode: "mbim", ifname: "wwan1" },
		]);

		flow = observeUsbModeSnapshot(flow, after);
		expect(flow.phase).toBe("confirmed");
		expect(displayedUsbMode(after, KEY, flow)).toBe("mbim");
	});

	it("ignores a snapshot in which ANOTHER device reached the target", () => {
		let flow = resolveUsbModeFlow(started(), { success: true }, T0);
		flow = observeUsbModeSnapshot(
			flow,
			modems([{ id: "0", stableKey: "someone-else", usbMode: "mbim" }]),
		);
		expect(flow.phase).toBe("awaiting");
	});
});

describe("a broadcast may legally beat the RPC reply", () => {
	it("buffers a pre-resolution match and consumes it at resolution", () => {
		let flow = started(modems([{ id: "0", stableKey: KEY, usbMode: "qmi" }]));
		expect(flow.phase).toBe("dispatching");

		flow = observeUsbModeSnapshot(
			flow,
			modems([{ id: "9", stableKey: KEY, usbMode: "mbim" }]),
		);
		expect(flow.phase).toBe("dispatching");
		expect(flow.bufferedMatch).toBe(true);

		flow = resolveUsbModeFlow(flow, { success: true }, T0);
		// Confirmed WITHOUT ever entering the window — the only later broadcast
		// might be the 30 s poll, so dropping this match would time out a healthy
		// switch on a fast backend.
		expect(flow.phase).toBe("confirmed");
		expect(flow.deadlineAt).toBeUndefined();
	});

	it("is idempotent on a repeated pre-resolution match", () => {
		const after = modems([{ id: "9", stableKey: KEY, usbMode: "mbim" }]);
		const buffered = observeUsbModeSnapshot(started(), after);
		// Identity, so a reactive consumer writing this back cannot self-trigger.
		expect(observeUsbModeSnapshot(buffered, after)).toBe(buffered);
	});
});

describe("the 20 s bound starts at RPC RESOLUTION, not at dispatch", () => {
	it("arms the deadline only when the reply lands", () => {
		const dispatched = started();
		expect(dispatched.deadlineAt).toBeUndefined();

		const resolved = resolveUsbModeFlow(dispatched, { success: true }, T0);
		expect(resolved.deadlineAt).toBe(T0 + USB_MODE_CONFIRM_WINDOW_MS);
	});

	it("does not expire while the RPC is still running, however long it takes", () => {
		// The RPC awaits the WHOLE server-side transaction, which the transition
		// engine bounds itself (re-enumeration can legitimately take a minute).
		const dispatched = started();
		expect(tickUsbModeFlow(dispatched, T0 + 600_000)).toBe(dispatched);
	});

	it("a near-deadline backend still confirms inside the post-resolve window", () => {
		let flow = resolveUsbModeFlow(started(), { success: true }, T0);
		flow = tickUsbModeFlow(flow, T0 + USB_MODE_CONFIRM_WINDOW_MS - 1);
		expect(flow.phase).toBe("awaiting");

		flow = observeUsbModeSnapshot(
			flow,
			modems([{ id: "0", stableKey: KEY, usbMode: "mbim" }]),
		);
		expect(flow.phase).toBe("confirmed");
	});

	it("expiring reports STILL TRANSITIONING — never a silent success", () => {
		let flow = resolveUsbModeFlow(
			started(modems([{ id: "0", stableKey: KEY, usbMode: "qmi" }])),
			{ success: true },
			T0,
		);
		flow = tickUsbModeFlow(flow, T0 + USB_MODE_CONFIRM_WINDOW_MS);

		expect(flow.phase).toBe("unconfirmed");
		expect(isUsbModeFlowBusy(flow)).toBe(false);
		expect(
			displayedUsbMode(
				modems([{ id: "0", stableKey: KEY, usbMode: "qmi" }]),
				KEY,
				flow,
			),
		).toBe("qmi");
	});

	it("a late broadcast cannot resurrect an expired flow", () => {
		let flow = tickUsbModeFlow(
			resolveUsbModeFlow(started(), { success: true }, T0),
			T0 + USB_MODE_CONFIRM_WINDOW_MS,
		);
		flow = observeUsbModeSnapshot(
			flow,
			modems([{ id: "0", stableKey: KEY, usbMode: "mbim" }]),
		);
		expect(flow.phase).toBe("unconfirmed");
	});
});

describe("refusals", () => {
	it("carries the typed refusal and its reason", () => {
		const flow = resolveUsbModeFlow(
			started(),
			{
				success: false,
				error: "transition_failed",
				reason: "postcondition_mismatch",
			},
			T0,
		);
		expect(flow.phase).toBe("refused");
		expect(flow.refusal).toBe("transition_failed");
		expect(flow.reason).toBe("postcondition_mismatch");
		expect(flow.deadlineAt).toBeUndefined();
	});

	it("carries a bare refusal with no reason", () => {
		const flow = resolveUsbModeFlow(
			started(),
			{ success: false, error: "uncertified" },
			T0,
		);
		expect(flow.refusal).toBe("uncertified");
		expect(flow.reason).toBeUndefined();
	});

	it("a refusal after a buffered match is STILL a refusal", () => {
		// Nothing switched, so a coincidental snapshot must not launder the
		// refusal into a success.
		let flow = observeUsbModeSnapshot(
			started(),
			modems([{ id: "0", stableKey: KEY, usbMode: "mbim" }]),
		);
		flow = resolveUsbModeFlow(
			flow,
			{ success: false, error: "uncertified" },
			T0,
		);
		expect(flow.phase).toBe("refused");
	});

	it("a thrown RPC is a typed transport failure, never a success", () => {
		const flow = failUsbModeFlow(started());
		expect(flow.phase).toBe("refused");
		expect(flow.refusal).toBe("transition_failed");
		expect(flow.reason).toBe("transaction_error");
	});

	it("a settled flow ignores a second resolution", () => {
		const settled = resolveUsbModeFlow(started(), { success: true }, T0);
		expect(resolveUsbModeFlow(settled, { success: false }, T0)).toBe(settled);
		expect(failUsbModeFlow(settled)).toBe(settled);
	});
});
