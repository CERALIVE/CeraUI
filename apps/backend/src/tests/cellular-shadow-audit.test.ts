import { describe, expect, test } from "bun:test";

import { createMmDbusObserver } from "@ceralive/modem-control";
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
	createAuditingTransport,
	MUTATING_DBUS_MEMBER_CALLS,
	MUTATING_DBUS_MEMBERS,
	memberKey,
	SHADOW_READ_ONLY_MEMBERS,
	ShadowMutationError,
} from "../modules/cellular/dbus-audit-transport.ts";
import {
	startModemShadow,
	stopModemShadow,
} from "../modules/cellular/shadow.ts";
import type { ShadowModemState } from "../modules/cellular/shadow-divergence.ts";

const SIGNAL_SETUP = "org.freedesktop.ModemManager1.Modem.Signal.Setup";

/**
 * An in-memory `DbusTransport` that records every dispatched member call and signal
 * subscription. It answers the two reads the read-only observer makes so
 * `observer.start()` completes with an authoritative (empty) snapshot, letting the
 * audit run the REAL package observer over a spy rather than a code-review assertion.
 */
class RecordingTransport implements DbusTransport {
	readonly calls: string[] = [];
	readonly subscriptions: string[] = [];
	#connected = false;

	async connect(): Promise<void> {
		this.#connected = true;
	}
	async disconnect(): Promise<void> {
		this.#connected = false;
	}
	isConnected(): boolean {
		return this.#connected;
	}
	async callMethod(call: MethodCall): Promise<MethodReply> {
		this.calls.push(memberKey(call));
		if (call.member === "GetNameOwner") {
			return { signature: "s", body: [":1.42"] };
		}
		if (call.member === "GetManagedObjects") {
			// a{oa{sa{sv}}} with an empty tree → an authoritative empty snapshot.
			return { signature: "a{oa{sa{sv}}}", body: [[]] };
		}
		return { signature: "", body: [] };
	}
	async subscribeSignal(
		spec: SignalSpec,
		_listener: SignalListener,
	): Promise<Subscription> {
		this.subscriptions.push(memberKey(spec));
		return { unsubscribe: async () => {} };
	}
	on(_event: TransportEvent, _handler: (payload?: unknown) => void): void {}
	off(_event: TransportEvent, _handler: (payload?: unknown) => void): void {}
	subscriptionCount(): number {
		return this.subscriptions.length;
	}
}

describe("modem shadow — transport-level mutation audit", () => {
	test("the REAL observer over the auditing transport issues only read-only calls — never Signal.Setup", async () => {
		const inner = new RecordingTransport();
		const audit = createAuditingTransport(inner);
		const observer = createMmDbusObserver({ transport: audit });

		const first = await observer.start();
		expect(first.ok).toBe(true);

		// Every forwarded call is in the read-only allowlist (fail-closed).
		for (const member of audit.getCallLog()) {
			expect(SHADOW_READ_ONLY_MEMBERS.has(member)).toBe(true);
		}
		// Signal.Setup — the annex-called-out mutation — NEVER appears.
		expect(audit.getCallLog()).not.toContain(SIGNAL_SETUP);
		// No mutation member appears at all.
		for (const mutation of MUTATING_DBUS_MEMBERS) {
			expect(audit.getCallLog()).not.toContain(mutation);
		}
		// The guard never tripped — the observer is genuinely read-only.
		expect(audit.getRefusedCalls()).toEqual([]);
		// The two authoritative reads actually reached the bus.
		expect(inner.calls).toContain("org.freedesktop.DBus.GetNameOwner");
		expect(inner.calls).toContain(
			"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
		);

		await observer.stop();
	});

	test("the auditing transport fails closed: every mutating member is refused and never forwarded", async () => {
		const inner = new RecordingTransport();
		const audit = createAuditingTransport(inner);

		for (const call of MUTATING_DBUS_MEMBER_CALLS) {
			await expect(
				audit.callMethod({
					destination: "org.freedesktop.ModemManager1",
					path: "/org/freedesktop/ModemManager1/Modem/0",
					interface: call.interface,
					member: call.member,
				}),
			).rejects.toBeInstanceOf(ShadowMutationError);
		}

		// Not one mutating call was forwarded to the underlying bus.
		expect(inner.calls).toEqual([]);
		// Every mutation attempt was recorded as a refusal.
		expect(audit.getRefusedCalls().sort()).toEqual(
			[...MUTATING_DBUS_MEMBERS].sort(),
		);
	});

	test("Signal.Setup specifically is refused and reported to the onRefusal hook", async () => {
		const inner = new RecordingTransport();
		const refused: string[] = [];
		const audit = createAuditingTransport(inner, {
			onRefusal: (member) => refused.push(member),
		});

		await expect(
			audit.callMethod({
				destination: "org.freedesktop.ModemManager1",
				path: "/org/freedesktop/ModemManager1/Modem/0",
				interface: "org.freedesktop.ModemManager1.Modem.Signal",
				member: "Setup",
				signature: "u",
				args: [5],
			}),
		).rejects.toThrow(ShadowMutationError);

		expect(refused).toEqual([SIGNAL_SETUP]);
		expect(inner.calls).toEqual([]);
	});

	test("read-only members are forwarded unchanged", async () => {
		const inner = new RecordingTransport();
		const audit = createAuditingTransport(inner);

		const reply = await audit.callMethod({
			destination: "org.freedesktop.ModemManager1",
			path: "/org/freedesktop/ModemManager1",
			interface: "org.freedesktop.DBus.ObjectManager",
			member: "GetManagedObjects",
		});

		expect(reply.body).toEqual([[]]);
		expect(inner.calls).toEqual([
			"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
		]);
		expect(audit.getRefusedCalls()).toEqual([]);
	});

	test("an unknown/future member is refused by default (in-doubt-is-a-write)", async () => {
		const inner = new RecordingTransport();
		const audit = createAuditingTransport(inner);

		await expect(
			audit.callMethod({
				destination: "org.freedesktop.ModemManager1",
				path: "/org/freedesktop/ModemManager1/Modem/0",
				interface: "org.freedesktop.ModemManager1.Modem",
				member: "SomeFutureMethod",
			}),
		).rejects.toBeInstanceOf(ShadowMutationError);
		expect(inner.calls).toEqual([]);
	});

	test("startModemShadow drives the observer read-only and never mutates the bus", async () => {
		const inner = new RecordingTransport();
		const observed: ShadowModemState[][] = [];

		await startModemShadow({
			createTransport: () => inner,
			createObserver: (transport) => createMmDbusObserver({ transport }),
			readMmcliStates: () => [],
			mapObservation: (list) => {
				observed.push([...(list.rows as ShadowModemState[])]);
				return [];
			},
			log: () => {},
		});

		// The observer completed its first authoritative snapshot via reads only.
		expect(inner.calls).toContain("org.freedesktop.DBus.GetNameOwner");
		expect(inner.calls).toContain(
			"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
		);
		expect(inner.calls).not.toContain(SIGNAL_SETUP);
		for (const mutation of MUTATING_DBUS_MEMBERS) {
			expect(inner.calls).not.toContain(mutation);
		}

		await stopModemShadow();
	});
});
