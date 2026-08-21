/*
    CeraUI - shadow-mode test harness for bun:test

    A RECORDING fake D-Bus transport plus a scripted observer, shared by the
    audit, redaction and retention suites.

    The recording transport is the load-bearing piece of the mutation-freedom
    proof, and only because of WHERE it sits: `startModemShadow` wraps whatever
    `createTransport` returns in the production `createAuditingDbusTransport`, so
    the fake is BELOW the same guard the device runs. Every call the fake records
    is therefore a call that would have reached the real bus — which is what makes
    "zero non-allowlisted calls, zero Signal.Setup" an assertion about executed
    traffic rather than about a wrapper written for the test.
*/

import type {
	ModemObservationPort,
	ObservationList,
} from "@ceralive/modem-control";
import type {
	DbusTransport,
	MethodCall,
	MethodReply,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from "@ceralive/modem-control/transport";

import { memberKey } from "../../modules/cellular/dbus-audit-transport.ts";

export const SIGNAL_SETUP_MEMBER =
	"org.freedesktop.ModemManager1.Modem.Signal.Setup";

export interface RecordingTransport extends DbusTransport {
	/** Fully-qualified members that actually REACHED this fake. */
	readonly calls: string[];
	readonly subscriptions: string[];
	readonly disconnects: { count: number };
}

export function recordingTransport(): RecordingTransport {
	const calls: string[] = [];
	const subscriptions: string[] = [];
	const disconnects = { count: 0 };
	return {
		calls,
		subscriptions,
		disconnects,
		connect: async (): Promise<void> => undefined,
		disconnect: async () => {
			disconnects.count += 1;
		},
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
			return { unsubscribe: async (): Promise<void> => undefined };
		},
		on: (_event: TransportEvent, _handler: (payload?: unknown) => void) =>
			undefined,
		off: (_event: TransportEvent, _handler: (payload?: unknown) => void) =>
			undefined,
		subscriptionCount: () => subscriptions.length,
	};
}

export interface ScriptedObserver extends ModemObservationPort {
	/** Push a further list to every subscriber, as the real observer would. */
	emit(list: ObservationList): void;
	readonly stopped: { count: number };
}

/**
 * An observer whose `start()` resolves `first` and whose stream is driven by the
 * test. `onConstructed` receives the transport it was handed, so a scenario can
 * make the observer attempt a call through it.
 */
export function scriptedObserver(
	first: ObservationList,
	onConstructed?: (transport: DbusTransport) => void | Promise<void>,
): (transport: DbusTransport) => ScriptedObserver {
	return (transport: DbusTransport) => {
		const listeners = new Set<(list: ObservationList) => void>();
		const stopped = { count: 0 };
		void onConstructed?.(transport);
		return {
			stopped,
			start: async () => first,
			observe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			stop: async () => {
				stopped.count += 1;
			},
			emit(list: ObservationList) {
				for (const listener of listeners) {
					listener(list);
				}
			},
		};
	};
}

/** A well-formed `CellularSnapshot`-shaped observer row, loosely typed. */
export function observerRow(
	ifname: string,
	over: Record<string, unknown> = {},
): unknown {
	return {
		identity: {
			equipmentId: { value: "351756051523999", confidence: "high" },
			runtimePath: `/org/freedesktop/ModemManager1/Modem/0`,
		},
		presence: "present",
		sourceHealth: "live",
		simSlots: [{ index: 1, occupied: true, active: true, lock: "none" }],
		radioPower: "on",
		mmState: "connected",
		registration: { status: "home", activeRats: new Set(["lte"]) },
		nmActivation: "activated",
		dataInterface: { present: true, name: ifname },
		reconcileStatus: "applied",
		recoveryState: { stage: "idle", attempts: 0 },
		revision: 1,
		...over,
	};
}

export function okList(rows: readonly unknown[]): ObservationList {
	return { ok: true, rows } as unknown as ObservationList;
}
