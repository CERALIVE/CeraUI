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
 * The `NoInputNoOutput` pairing agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `NoInputNoOutput`, AND WHAT IT COMMITS US TO
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The board has no keypad and, during a pairing, no display an operator is
 * looking at — the operator is on a phone or laptop across an authenticated web
 * UI, not at the device. So `NoInputNoOutput` is the only capability CeraLive
 * can claim honestly, and Secure Simple Pairing resolves it to Just Works: no
 * passkey is entered, none is compared, and BlueZ asks the agent only whether
 * the pairing is AUTHORIZED.
 *
 * That makes {@link noInputNoOutputPolicy}'s authorization arm the single
 * security decision on this path, and it is gated on OPERATOR INTENT rather than
 * on the request itself: an incoming pairing is accepted ONLY while a pairing
 * window the operator opened is in force, and only for the device that window
 * names when it names one. Without that gate a `NoInputNoOutput` agent accepts
 * any pairing from anyone in radio range, silently.
 *
 * Every passkey/PIN arm REJECTS rather than inventing a value. A
 * `NoInputNoOutput` agent that answers `RequestPasskey` with `0000` is claiming
 * an input device it does not have, and it downgrades the pairing for the peer
 * that asked.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE EXPORTER MUST BE LIVE BEFORE BLUEZ SEES ITS PATH
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * An agent is a D-Bus object BlueZ calls INTO, so registering one needs an
 * object server: a bus connection that can own a name and answer inbound method
 * calls. The shared `DbusTransport` this module reuses (the cellular observation
 * path's client — see `docs/DBUS-OBSERVATION-CONTRACT.md`) is a CLIENT: it can
 * call and subscribe, and it exports nothing. Building a second D-Bus client
 * abstraction to gain that is exactly what this module must not do.
 *
 * The production exporter uses the object-server capability already present in
 * the D-Bus library beneath the shared transport. The port remains injectable;
 * when absent the module registers NOTHING and reports `exporter_unavailable`.
 * Registering a path before its answering object exists would make BlueZ block
 * on every callback until timeout, which is strictly worse than no agent.
 */

import type {
	DbusTransport,
	MethodCall,
} from "@ceralive/modem-control/transport";

import { logger } from "../../helpers/logger.ts";

import {
	AGENT_CAPABILITY_NO_IO,
	AGENT_MANAGER_IFACE,
	BLUEZ_MANAGER_PATH,
	BLUEZ_SERVICE,
	CERALIVE_AGENT_PATH,
	DBUS_CALL_TIMEOUT_MS,
} from "./bluetooth-constants.ts";

/** The `org.bluez.Agent1` members BlueZ can call on us. */
export const AGENT_METHODS = [
	"Release",
	"RequestPinCode",
	"DisplayPinCode",
	"RequestPasskey",
	"DisplayPasskey",
	"RequestConfirmation",
	"RequestAuthorization",
	"AuthorizeService",
	"Cancel",
] as const;

export type AgentMethod = (typeof AGENT_METHODS)[number];

export const BLUEZ_ERROR_REJECTED = "org.bluez.Error.Rejected";
export const BLUEZ_ERROR_CANCELED = "org.bluez.Error.Canceled";

/** What the agent answers BlueZ for one inbound call. */
export type AgentDecision =
	/** Return an empty reply — the request is granted. */
	| { readonly action: "accept" }
	/** Return a D-Bus error — the request is refused. */
	| { readonly action: "reject"; readonly error: string; readonly why: string }
	/** Return an empty reply without granting anything (informational method). */
	| { readonly action: "ignore"; readonly why: string };

/** What the policy is allowed to know about operator intent. */
export interface AgentPolicyContext {
	/** True while an operator-initiated pairing window is in force. */
	readonly pairingWindowOpen: boolean;
	/** The device the open window names, when it names one. */
	readonly expectedDevicePath?: string;
	/** Devices already trusted — service authorization follows trust. */
	readonly trustedPaths: ReadonlySet<string>;
}

function reject(why: string): AgentDecision {
	return { action: "reject", error: BLUEZ_ERROR_REJECTED, why };
}

/**
 * The pairing policy. PURE — no bus, no clock, no logging.
 *
 * `devicePath` is the object path BlueZ passes as the first argument of every
 * device-scoped method; `Release` and `Cancel` carry none.
 */
export function noInputNoOutputPolicy(
	method: AgentMethod,
	devicePath: string | undefined,
	ctx: AgentPolicyContext,
): AgentDecision {
	switch (method) {
		// A NoInputNoOutput agent has no keypad. Answering with a canned PIN or
		// passkey would claim an input device we do not have.
		case "RequestPinCode":
			return reject("no input device: cannot enter a PIN");
		case "RequestPasskey":
			return reject("no input device: cannot enter a passkey");
		// …and no display an operator is watching, so it cannot compare either.
		case "DisplayPinCode":
			return { action: "ignore", why: "no display: nothing to show" };
		case "DisplayPasskey":
			return { action: "ignore", why: "no display: nothing to show" };
		case "RequestConfirmation":
			return reject("no display device: cannot confirm a passkey");

		// The Just Works decision, and the only security gate on this path.
		case "RequestAuthorization": {
			if (!ctx.pairingWindowOpen) {
				return reject("no operator pairing window is open");
			}
			if (
				ctx.expectedDevicePath !== undefined &&
				ctx.expectedDevicePath !== devicePath
			) {
				return reject(
					`the open pairing window names ${ctx.expectedDevicePath}, not ${String(devicePath)}`,
				);
			}
			return { action: "accept" };
		}

		// Service authorization follows TRUST, not the radio: a device the
		// operator trusted may connect its profiles whenever it likes, and one
		// they have not is authorized only inside the pairing window.
		case "AuthorizeService": {
			if (devicePath !== undefined && ctx.trustedPaths.has(devicePath)) {
				return { action: "accept" };
			}
			if (ctx.pairingWindowOpen) return { action: "accept" };
			return reject("device is not trusted and no pairing window is open");
		}

		case "Cancel":
			return { action: "ignore", why: "peer cancelled the request" };
		case "Release":
			return { action: "ignore", why: "BlueZ released the agent" };
	}
}

/** The inbound handler the exporter binds to the agent object path. */
export type AgentCallHandler = (
	method: AgentMethod,
	devicePath: string | undefined,
) => AgentDecision;

export interface AgentExportHandle {
	readonly path: string;
	release(): Promise<void>;
}

/**
 * The object-server port. Supplying one is what makes the agent live; see the
 * module header for the production implementation and fail-safe absence path.
 */
export interface BluezAgentExporter {
	exportAgent(
		path: string,
		handler: AgentCallHandler,
	): Promise<AgentExportHandle>;
	/**
	 * AgentManager calls made by the SAME connection that exported the object.
	 * BlueZ keys registrations on the caller's unique bus name.
	 */
	callAgentManager?(call: MethodCall): Promise<void>;
}

export const AGENT_REGISTER_FAILURES = [
	/** No object server was supplied, so no agent was registered. */
	"exporter_unavailable",
	/** The object server refused to export the agent path. */
	"export_failed",
	/** BlueZ refused `RegisterAgent` / `RequestDefaultAgent`. */
	"bluez_refused",
] as const;

export type AgentRegisterFailure = (typeof AGENT_REGISTER_FAILURES)[number];

export type AgentRegistration =
	| {
			readonly ok: true;
			readonly path: string;
			readonly isDefaultAgent: boolean;
			unregister(): Promise<void>;
	  }
	| {
			readonly ok: false;
			readonly reason: AgentRegisterFailure;
			readonly detail?: string;
	  };

export interface PairingAgentDeps {
	readonly transport: DbusTransport;
	readonly exporter?: BluezAgentExporter;
	/** Reads live operator intent at call time, never a snapshot. */
	readonly context: () => AgentPolicyContext;
	readonly log?: (msg: string) => void;
	readonly warn?: (msg: string) => void;
}

/**
 * Export the agent object and register it with `org.bluez.AgentManager1`.
 *
 * Ordering is load-bearing: the object is exported BEFORE `RegisterAgent`, so
 * BlueZ can never be handed a path that does not answer. `RequestDefaultAgent`
 * failing is NOT fatal — another agent (a `bluetoothctl` session) may legitimately
 * hold the default slot, and a registered non-default agent still services its
 * own pairings.
 */
export async function registerPairingAgent(
	deps: PairingAgentDeps,
	agentPath: string = CERALIVE_AGENT_PATH,
): Promise<AgentRegistration> {
	const warn = deps.warn ?? ((m: string) => logger.warn(m));
	const log = deps.log ?? ((m: string) => logger.info(m));

	if (deps.exporter === undefined) {
		warn(
			"bluetooth: no D-Bus object server available, so no pairing agent was registered; pairing depends on whatever agent the host already provides",
		);
		return { ok: false, reason: "exporter_unavailable" };
	}

	const handler: AgentCallHandler = (method, devicePath) => {
		const decision = noInputNoOutputPolicy(method, devicePath, deps.context());
		if (decision.action === "reject") {
			warn(
				`bluetooth agent: refused ${method} for ${String(devicePath)} — ${decision.why}`,
			);
		}
		return decision;
	};

	let handle: AgentExportHandle;
	try {
		handle = await deps.exporter.exportAgent(agentPath, handler);
	} catch (err) {
		warn(`bluetooth: could not export the pairing agent: ${String(err)}`);
		return { ok: false, reason: "export_failed", detail: String(err) };
	}
	const exporter = deps.exporter;
	const managerCall = exporter.callAgentManager;
	const callAgentManager = managerCall
		? (call: MethodCall) => managerCall.call(exporter, call)
		: (call: MethodCall) =>
				deps.transport.callMethod(call).then(() => undefined);

	try {
		await callAgentManager({
			destination: BLUEZ_SERVICE,
			path: BLUEZ_MANAGER_PATH,
			interface: AGENT_MANAGER_IFACE,
			member: "RegisterAgent",
			signature: "os",
			args: [agentPath, AGENT_CAPABILITY_NO_IO],
			timeoutMs: DBUS_CALL_TIMEOUT_MS,
		});
	} catch (err) {
		await handle.release().catch((releaseErr: unknown) => {
			warn(
				`bluetooth: releasing the un-registered agent failed: ${String(releaseErr)}`,
			);
		});
		warn(`bluetooth: BlueZ refused RegisterAgent: ${String(err)}`);
		return { ok: false, reason: "bluez_refused", detail: String(err) };
	}

	let isDefaultAgent = true;
	try {
		await callAgentManager({
			destination: BLUEZ_SERVICE,
			path: BLUEZ_MANAGER_PATH,
			interface: AGENT_MANAGER_IFACE,
			member: "RequestDefaultAgent",
			signature: "o",
			args: [agentPath],
			timeoutMs: DBUS_CALL_TIMEOUT_MS,
		});
	} catch (err) {
		isDefaultAgent = false;
		warn(
			`bluetooth: registered the agent but BlueZ kept another default agent: ${String(err)}`,
		);
	}

	log(
		`bluetooth: registered a ${AGENT_CAPABILITY_NO_IO} pairing agent at ${agentPath}${isDefaultAgent ? " (default)" : ""}`,
	);

	return {
		ok: true,
		path: agentPath,
		isDefaultAgent,
		unregister: async () => {
			try {
				await callAgentManager({
					destination: BLUEZ_SERVICE,
					path: BLUEZ_MANAGER_PATH,
					interface: AGENT_MANAGER_IFACE,
					member: "UnregisterAgent",
					signature: "o",
					args: [agentPath],
					timeoutMs: DBUS_CALL_TIMEOUT_MS,
				});
			} catch (err) {
				warn(`bluetooth: UnregisterAgent failed: ${String(err)}`);
			}
			await handle.release().catch((err: unknown) => {
				warn(`bluetooth: releasing the agent object failed: ${String(err)}`);
			});
		},
	};
}
