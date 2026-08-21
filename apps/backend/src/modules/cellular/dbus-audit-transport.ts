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
 * FAIL-CLOSED D-Bus audit wrapper for the Phase-B cellular observation path.
 *
 * The device is expected to observe the SAME ModemManager instance mmcli is
 * actively driving, so an observation path that can mutate is a way to change a
 * live modem by accident. This wrapper is the enforcement point: a method call
 * reaches the bus ONLY when its fully-qualified `interface.member` is one of the
 * three reads in {@link CELLULAR_READ_ONLY_MEMBERS}. Anything else — a known
 * mutation, an unrecognised member, a member added by a future package version —
 * is refused with a typed {@link CellularAuditRefusalError} and never forwarded.
 *
 * `org.freedesktop.ModemManager1.Modem.Signal.Setup` is refused BY NAME rather
 * than merely by omission. It reads like a passive "subscribe to signal quality"
 * call and is not: it turns on periodic extended signal reporting on the modem,
 * i.e. it writes. {@link NAMED_MUTATING_MEMBERS} exists so that fact is asserted
 * against a name instead of inferred from an allowlist gap — a refusal recorded
 * as {@link REFUSAL_NAMED_MUTATION} proves the call was recognised and rejected,
 * not simply unknown.
 *
 * Signal SUBSCRIPTIONS (`subscribeSignal`) are match-rule registrations on the
 * bus daemon, not calls against a modem, so they pass through untouched.
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

import { logger } from "../../helpers/logger.ts";

export function memberKey(call: {
	readonly interface: string;
	readonly member: string;
}): string {
	return `${call.interface}.${call.member}`;
}

export const CELLULAR_READ_ONLY_MEMBERS: ReadonlySet<string> = new Set([
	"org.freedesktop.DBus.GetNameOwner",
	"org.freedesktop.DBus.ObjectManager.GetManagedObjects",
	"org.freedesktop.ModemManager1.Modem.GetCellInfo",
]);

/**
 * Members this build KNOWS mutate a modem. The allowlist above already refuses
 * them; naming them here is what lets the audit assert an explicit rejection
 * rather than an accidental one.
 */
export const NAMED_MUTATING_MEMBERS: readonly string[] = [
	"org.freedesktop.ModemManager1.Modem.Signal.Setup",
	"org.freedesktop.ModemManager1.Modem.SetCurrentModes",
	"org.freedesktop.ModemManager1.Modem.SetPrimarySimSlot",
	"org.freedesktop.ModemManager1.Modem.Enable",
	"org.freedesktop.ModemManager1.Modem.Reset",
	"org.freedesktop.ModemManager1.Modem.Modem3gpp.Scan",
	"org.freedesktop.ModemManager1.Modem.Modem3gpp.Register",
	"org.freedesktop.ModemManager1.Sim.SendPin",
	"org.freedesktop.ModemManager1.Sim.SendPuk",
	"org.freedesktop.ModemManager1.InhibitDevice",
];

const NAMED_MUTATING_MEMBER_SET: ReadonlySet<string> = new Set(
	NAMED_MUTATING_MEMBERS,
);

export const REFUSAL_NAMED_MUTATION = "named-mutation";
export const REFUSAL_NOT_ALLOWLISTED = "not-allowlisted";

export type CellularAuditRefusalReason =
	| typeof REFUSAL_NAMED_MUTATION
	| typeof REFUSAL_NOT_ALLOWLISTED;

export class CellularAuditRefusalError extends Error {
	readonly member: string;
	readonly reason: CellularAuditRefusalReason;

	constructor(member: string, reason: CellularAuditRefusalReason) {
		super(
			`cellular audit refused D-Bus call ${member} (${reason}); the cellular observation path is read-only`,
		);
		this.name = "CellularAuditRefusalError";
		this.member = member;
		this.reason = reason;
	}
}

export interface CellularAuditRefusal {
	readonly member: string;
	readonly reason: CellularAuditRefusalReason;
}

export interface AuditingDbusTransport extends DbusTransport {
	getCallLog(): readonly string[];
	getRefusals(): readonly CellularAuditRefusal[];
}

export interface AuditingDbusTransportDeps {
	readonly onRefusal?: (refusal: CellularAuditRefusal) => void;
}

function classify(member: string): CellularAuditRefusalReason | undefined {
	if (CELLULAR_READ_ONLY_MEMBERS.has(member)) {
		return undefined;
	}
	return NAMED_MUTATING_MEMBER_SET.has(member)
		? REFUSAL_NAMED_MUTATION
		: REFUSAL_NOT_ALLOWLISTED;
}

export function createAuditingDbusTransport(
	inner: DbusTransport,
	deps: AuditingDbusTransportDeps = {},
): AuditingDbusTransport {
	const callLog: string[] = [];
	const refusals: CellularAuditRefusal[] = [];

	return {
		connect: () => inner.connect(),
		disconnect: () => inner.disconnect(),
		isConnected: () => inner.isConnected(),

		async callMethod(call: MethodCall): Promise<MethodReply> {
			const member = memberKey(call);
			const reason = classify(member);
			if (reason !== undefined) {
				const refusal: CellularAuditRefusal = { member, reason };
				refusals.push(refusal);
				logger.debug(
					`cellular audit: refused D-Bus call ${member} (${reason})`,
				);
				deps.onRefusal?.(refusal);
				throw new CellularAuditRefusalError(member, reason);
			}
			callLog.push(member);
			return inner.callMethod(call);
		},

		subscribeSignal(
			spec: SignalSpec,
			listener: SignalListener,
		): Promise<Subscription> {
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
		getRefusals: () => [...refusals],
	};
}
