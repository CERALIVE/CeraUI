/**
 * Fail-closed D-Bus audit contract.
 *
 * The device observes the SAME ModemManager mmcli is driving, so the guarantee
 * that matters is not "we do not currently call anything mutating" but "a
 * mutating call CANNOT reach the bus". Every case below therefore asserts the
 * inner transport was never touched, not merely that a call threw.
 *
 * `Signal.Setup` is refused BY NAME (`named-mutation`), never as an unrecognised
 * member — it reads like a passive subscription and is actually a write, so the
 * refusal has to be an assertion about a name rather than a gap in a list.
 */
import { describe, expect, test } from "bun:test";

import type {
	DbusTransport,
	MethodCall,
	MethodReply,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from "@ceralive/modem-control/transport";

import {
	CELLULAR_READ_ONLY_MEMBERS,
	CellularAuditRefusalError,
	createAuditingDbusTransport,
	memberKey,
	NAMED_MUTATING_MEMBERS,
	REFUSAL_NAMED_MUTATION,
	REFUSAL_NOT_ALLOWLISTED,
} from "../modules/cellular/dbus-audit-transport.ts";

const SIGNAL_SETUP = "org.freedesktop.ModemManager1.Modem.Signal.Setup";

interface RecordingTransport extends DbusTransport {
	readonly calls: string[];
	readonly subscriptions: string[];
}

function recordingTransport(): RecordingTransport {
	const calls: string[] = [];
	const subscriptions: string[] = [];
	return {
		calls,
		subscriptions,
		connect: async () => {},
		disconnect: async () => {},
		isConnected: () => true,
		async callMethod(call: MethodCall): Promise<MethodReply> {
			calls.push(memberKey(call));
			return { signature: "", body: [] };
		},
		async subscribeSignal(
			spec: SignalSpec,
			_listener: SignalListener,
		): Promise<Subscription> {
			subscriptions.push(memberKey(spec));
			return { unsubscribe: async () => {} };
		},
		on(_event: TransportEvent, _handler: (payload?: unknown) => void): void {},
		off(_event: TransportEvent, _handler: (payload?: unknown) => void): void {},
		subscriptionCount: () => subscriptions.length,
	};
}

function splitMember(key: string): { interface: string; member: string } {
	const cut = key.lastIndexOf(".");
	return { interface: key.slice(0, cut), member: key.slice(cut + 1) };
}

function call(key: string): MethodCall {
	return {
		destination: "org.freedesktop.ModemManager1",
		path: "/",
		...splitMember(key),
	};
}

describe("the allowlist is exactly three reads", () => {
	test("no member beyond the three named reads is admitted", () => {
		expect([...CELLULAR_READ_ONLY_MEMBERS].sort()).toEqual([
			"org.freedesktop.DBus.GetNameOwner",
			"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
			"org.freedesktop.ModemManager1.Modem.GetCellInfo",
		]);
	});

	for (const allowed of [
		"org.freedesktop.DBus.GetNameOwner",
		"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
		"org.freedesktop.ModemManager1.Modem.GetCellInfo",
	]) {
		test(`${allowed} is forwarded to the bus`, async () => {
			const inner = recordingTransport();
			const audited = createAuditingDbusTransport(inner);

			await audited.callMethod(call(allowed));

			expect(inner.calls).toEqual([allowed]);
			expect(audited.getCallLog()).toEqual([allowed]);
			expect(audited.getRefusals()).toEqual([]);
		});
	}
});

describe("refusal table", () => {
	test("Signal.Setup is refused BY NAME, and never reaches the bus", async () => {
		// Given the one call that looks passive and is not
		const inner = recordingTransport();
		const audited = createAuditingDbusTransport(inner);

		// When it is attempted
		const attempt = audited.callMethod(call(SIGNAL_SETUP));

		// Then it is refused as a RECOGNISED mutation, not as an unknown member
		await expect(attempt).rejects.toBeInstanceOf(CellularAuditRefusalError);
		expect(audited.getRefusals()).toEqual([
			{ member: SIGNAL_SETUP, reason: REFUSAL_NAMED_MUTATION },
		]);
		expect(inner.calls).toEqual([]);
	});

	test("Signal.Setup is enumerated in the named-mutation table", () => {
		expect(NAMED_MUTATING_MEMBERS).toContain(SIGNAL_SETUP);
		expect(CELLULAR_READ_ONLY_MEMBERS.has(SIGNAL_SETUP)).toBe(false);
	});

	for (const mutation of NAMED_MUTATING_MEMBERS) {
		test(`${mutation} is refused as a named mutation`, async () => {
			const inner = recordingTransport();
			const audited = createAuditingDbusTransport(inner);

			await expect(audited.callMethod(call(mutation))).rejects.toMatchObject({
				name: "CellularAuditRefusalError",
				member: mutation,
				reason: REFUSAL_NAMED_MUTATION,
			});
			expect(inner.calls).toEqual([]);
		});
	}

	test("an UNKNOWN member fails closed rather than open", async () => {
		// Given a member no version of this build has ever heard of
		const inner = recordingTransport();
		const audited = createAuditingDbusTransport(inner);
		const unknown = "org.freedesktop.ModemManager1.Modem.SomeFutureCall";

		// When it is attempted
		await expect(audited.callMethod(call(unknown))).rejects.toMatchObject({
			member: unknown,
			reason: REFUSAL_NOT_ALLOWLISTED,
		});

		// Then it was refused, not forwarded — in doubt, treat it as a write
		expect(inner.calls).toEqual([]);
	});

	test("a near-miss on a permitted member is still refused", async () => {
		const inner = recordingTransport();
		const audited = createAuditingDbusTransport(inner);
		await expect(
			audited.callMethod(call("org.freedesktop.DBus.GetNameOwner2")),
		).rejects.toBeInstanceOf(CellularAuditRefusalError);
		expect(inner.calls).toEqual([]);
	});

	test("a refusal notifies the injected observer", async () => {
		const seen: string[] = [];
		const audited = createAuditingDbusTransport(recordingTransport(), {
			onRefusal: (refusal) => seen.push(`${refusal.member}:${refusal.reason}`),
		});

		await expect(audited.callMethod(call(SIGNAL_SETUP))).rejects.toThrow();

		expect(seen).toEqual([`${SIGNAL_SETUP}:${REFUSAL_NAMED_MUTATION}`]);
	});

	test("refusals accumulate in attempt order and admit nothing", async () => {
		const inner = recordingTransport();
		const audited = createAuditingDbusTransport(inner);

		await expect(audited.callMethod(call(SIGNAL_SETUP))).rejects.toThrow();
		await audited.callMethod(call("org.freedesktop.DBus.GetNameOwner"));
		await expect(
			audited.callMethod(call("org.freedesktop.ModemManager1.Sim.SendPin")),
		).rejects.toThrow();

		expect(audited.getRefusals().map((r) => r.member)).toEqual([
			SIGNAL_SETUP,
			"org.freedesktop.ModemManager1.Sim.SendPin",
		]);
		expect(inner.calls).toEqual(["org.freedesktop.DBus.GetNameOwner"]);
	});
});

describe("passthrough surface", () => {
	test("signal subscriptions are observational and pass through untouched", async () => {
		const inner = recordingTransport();
		const audited = createAuditingDbusTransport(inner);

		await audited.subscribeSignal(
			{
				interface: "org.freedesktop.DBus.ObjectManager",
				member: "InterfacesAdded",
			},
			() => {},
		);

		expect(inner.subscriptions).toEqual([
			"org.freedesktop.DBus.ObjectManager.InterfacesAdded",
		]);
		expect(audited.getRefusals()).toEqual([]);
	});

	test("lifecycle methods delegate to the inner transport", async () => {
		const inner = recordingTransport();
		const audited = createAuditingDbusTransport(inner);

		await audited.connect();
		await audited.disconnect();

		expect(audited.isConnected()).toBe(true);
		expect(audited.subscriptionCount()).toBe(0);
	});

	test("the returned logs are copies a caller cannot mutate", async () => {
		const audited = createAuditingDbusTransport(recordingTransport());
		await audited.callMethod(call("org.freedesktop.DBus.GetNameOwner"));

		(audited.getCallLog() as string[]).push("injected");

		expect(audited.getCallLog()).toEqual(["org.freedesktop.DBus.GetNameOwner"]);
	});
});
