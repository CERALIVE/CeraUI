/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Fail-closed D-Bus transport audit for `modem_shadow` (Phase B).
 *
 * Shadow mode observes the SAME modem hardware mmcli is actively driving, but must
 * be MUTATION-FREE — the binding-ledger invariant is "zero `Signal.Setup` calls"
 * (`.omo/plans/modem-control-package.md` §annex). `Signal.Setup` LOOKS like a
 * passive signal-watch subscription, but it is a MUTATING ModemManager call that
 * turns on periodic extended signal reporting, so it is in the deny set below.
 *
 * This wraps any `@ceralive/modem-control` {@link DbusTransport} and enforces a
 * FAIL-CLOSED allowlist: a method call is forwarded to the bus ONLY when its
 * fully-qualified `interface.member` is in {@link SHADOW_READ_ONLY_MEMBERS}. Every
 * other member — the known mutations AND any unknown/future member — is refused
 * with a {@link ShadowMutationError} and NEVER reaches the inner transport
 * ("in doubt → treat as a write"). Signal SUBSCRIPTIONS are observational reads and
 * pass through unchanged.
 *
 * The wrapper also records an ordered call log + refusal log, so the safety-critical
 * audit test can spy on the ACTUAL dispatch of the real observer rather than assert
 * by code review.
 *
 * The member classification is derived from the package dispatch sites
 * (`@ceralive/modem-control` `src/backend/*`): the read-only observer calls only
 * `GetNameOwner` + `GetManagedObjects`; `GetCellInfo` is the one further read the
 * full backend can make; the mutations live in `mm-mutations.ts` / `sim-unlock.ts` /
 * `signal-setup.ts`.
 */

import type {
	DbusTransport,
	MethodCall,
	MethodReply,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from "@ceralive/modem-control/transport";

/** `interface.member` key for a call or signal spec. */
export function memberKey(call: {
	readonly interface: string;
	readonly member: string;
}): string {
	return `${call.interface}.${call.member}`;
}

/**
 * The ONLY D-Bus method members shadow mode may dispatch. Everything else is
 * refused. `GetNameOwner` + `GetManagedObjects` are the read-only observer's two
 * calls; `GetCellInfo` is the additional read the full backend can make — included
 * so a future read-only cell-info observation is not spuriously refused.
 */
export const SHADOW_READ_ONLY_MEMBERS: ReadonlySet<string> = new Set<string>([
	"org.freedesktop.DBus.GetNameOwner",
	"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
	"org.freedesktop.ModemManager1.Modem.GetCellInfo",
]);

/** One mutating ModemManager member, split into its interface + member. */
export interface MutatingMemberCall {
	readonly interface: string;
	readonly member: string;
}

/**
 * Every mutating member the `@ceralive/modem-control` package can dispatch. This is
 * documentation + the explicit deny surface the audit test iterates; the runtime
 * guard is the fail-closed allowlist above, which refuses these AND anything not
 * enumerated as a read.
 */
export const MUTATING_DBUS_MEMBER_CALLS: readonly MutatingMemberCall[] = [
	{
		interface: "org.freedesktop.ModemManager1.Modem",
		member: "SetCurrentModes",
	},
	{
		interface: "org.freedesktop.ModemManager1.Modem",
		member: "SetPrimarySimSlot",
	},
	{
		interface: "org.freedesktop.ModemManager1.Modem.Modem3gpp",
		member: "Scan",
	},
	{ interface: "org.freedesktop.ModemManager1", member: "InhibitDevice" },
	{ interface: "org.freedesktop.ModemManager1.Sim", member: "SendPin" },
	{ interface: "org.freedesktop.ModemManager1.Sim", member: "SendPuk" },
	// LOOKS passive, is a mutation — the annex-called-out invariant.
	{ interface: "org.freedesktop.ModemManager1.Modem.Signal", member: "Setup" },
];

/** The mutating members as fully-qualified `interface.member` keys. */
export const MUTATING_DBUS_MEMBERS: ReadonlySet<string> = new Set(
	MUTATING_DBUS_MEMBER_CALLS.map(memberKey),
);

/** Thrown when shadow mode attempts (or a bug attempts) a non-read D-Bus call. */
export class ShadowMutationError extends Error {
	readonly member: string;
	constructor(member: string) {
		super(
			`modem shadow refused a non-read D-Bus call: ${member} (shadow mode is mutation-free)`,
		);
		this.name = "ShadowMutationError";
		this.member = member;
	}
}

/** A {@link DbusTransport} that records its call log and refusal log for auditing. */
export interface AuditingTransport extends DbusTransport {
	/** Every method member the guard admitted and forwarded, in dispatch order. */
	getCallLog(): readonly string[];
	/** Every method member the guard refused, in attempt order. */
	getRefusedCalls(): readonly string[];
}

export interface AuditingTransportDeps {
	/** Notified (member key) whenever a non-read call is refused. */
	readonly onRefusal?: (member: string) => void;
}

/**
 * Wrap a transport so shadow mode can dispatch ONLY read-only members. A refused
 * call throws {@link ShadowMutationError} and is never forwarded to `inner`; signal
 * subscriptions and lifecycle passthroughs are untouched.
 */
export function createAuditingTransport(
	inner: DbusTransport,
	deps: AuditingTransportDeps = {},
): AuditingTransport {
	const callLog: string[] = [];
	const refusedCalls: string[] = [];

	return {
		connect: () => inner.connect(),
		disconnect: () => inner.disconnect(),
		isConnected: () => inner.isConnected(),

		async callMethod(call: MethodCall): Promise<MethodReply> {
			const key = memberKey(call);
			if (!SHADOW_READ_ONLY_MEMBERS.has(key)) {
				// Fail closed: known mutation OR unknown member → refuse, never forward.
				refusedCalls.push(key);
				deps.onRefusal?.(key);
				throw new ShadowMutationError(key);
			}
			callLog.push(key);
			return inner.callMethod(call);
		},

		subscribeSignal(
			spec: SignalSpec,
			listener: SignalListener,
		): Promise<Subscription> {
			// Signal subscriptions are observational reads — they never mutate the modem.
			return inner.subscribeSignal(spec, listener);
		},

		on(event: TransportEvent, handler: (payload?: unknown) => void): void {
			inner.on(event, handler);
		},
		off(event: TransportEvent, handler: (payload?: unknown) => void): void {
			inner.off(event, handler);
		},
		subscriptionCount: () => inner.subscriptionCount(),

		getCallLog: () => [...callLog],
		getRefusedCalls: () => [...refusedCalls],
	};
}
