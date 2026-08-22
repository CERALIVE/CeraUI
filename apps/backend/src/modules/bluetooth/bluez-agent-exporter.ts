/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

import type { MethodCall } from "@ceralive/modem-control/transport";
import * as dbusNativeModule from "@httptoolkit/dbus-native";
import { logger } from "../../helpers/logger.ts";
import { AGENT_IFACE, DBUS_CALL_TIMEOUT_MS } from "./bluetooth-constants.ts";
import type {
	AgentCallHandler,
	AgentDecision,
	AgentExportHandle,
	BluezAgentExporter,
} from "./bluez-agent.ts";

interface RawConnection {
	on(event: "error", listener: (value?: unknown) => void): void;
	once(event: "connect" | "error", listener: (value?: unknown) => void): void;
	removeListener(
		event: "connect" | "error",
		listener: (value?: unknown) => void,
	): void;
}

interface RawMethodCall {
	readonly destination: string;
	readonly path: string;
	readonly interface: string;
	readonly member: string;
	readonly signature?: string;
	readonly body?: readonly unknown[];
}

interface AgentInterfaceDefinition {
	readonly name: string;
	readonly methods: Readonly<Record<string, readonly [string, string]>>;
}

interface RawBus {
	readonly connection: RawConnection;
	exportInterface(
		implementation: Readonly<
			Record<string, (...args: readonly unknown[]) => null>
		>,
		path: string,
		definition: AgentInterfaceDefinition,
	): void;
	invoke(message: RawMethodCall): Promise<unknown>;
	disconnect(): Promise<void>;
}

declare module "@httptoolkit/dbus-native" {
	interface DBusClient {
		readonly connection: RawConnection;
		exportInterface(
			implementation: Readonly<
				Record<string, (...args: readonly unknown[]) => null>
			>,
			path: string,
			definition: AgentInterfaceDefinition,
		): void;
		invoke(message: RawMethodCall): Promise<unknown>;
	}
}

export interface BluezAgentExporterDeps {
	readonly busAddress: string;
	readonly createClient?: (busAddress: string) => RawBus;
}

const AGENT_DEFINITION: AgentInterfaceDefinition = {
	name: AGENT_IFACE,
	methods: {
		Release: ["", ""],
		RequestPinCode: ["o", "s"],
		DisplayPinCode: ["os", ""],
		RequestPasskey: ["o", "u"],
		DisplayPasskey: ["ouq", ""],
		RequestConfirmation: ["ou", ""],
		RequestAuthorization: ["o", ""],
		AuthorizeService: ["os", ""],
		Cancel: ["", ""],
	},
};

class AgentRejectedError extends Error {
	readonly dbusName: string;

	constructor(decision: Extract<AgentDecision, { readonly action: "reject" }>) {
		super(decision.why);
		this.name = "AgentRejectedError";
		this.dbusName = decision.error;
	}
}

function defaultCreateClient(busAddress: string): RawBus {
	const options = { direct: false, busAddress, ReturnLongjs: true };
	return dbusNativeModule.createClient(options);
}

function waitForConnect(bus: RawBus): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("BlueZ agent D-Bus connection timed out"));
		}, DBUS_CALL_TIMEOUT_MS);
		timer.unref?.();
		const onConnect = (): void => {
			cleanup();
			resolve();
		};
		const onError = (cause?: unknown): void => {
			cleanup();
			reject(cause instanceof Error ? cause : new Error(String(cause)));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			bus.connection.removeListener("connect", onConnect);
			bus.connection.removeListener("error", onError);
		};
		bus.connection.once("connect", onConnect);
		bus.connection.once("error", onError);
	});
}

function withCallTimeout(call: Promise<unknown>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error("BlueZ AgentManager D-Bus call timed out"));
		}, DBUS_CALL_TIMEOUT_MS);
		timer.unref?.();
		call.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function answer(
	handler: AgentCallHandler,
	method: Parameters<AgentCallHandler>[0],
	devicePath: string | undefined,
): null {
	const decision = handler(method, devicePath);
	if (decision.action === "reject") throw new AgentRejectedError(decision);
	return null;
}

function implementationFor(
	handler: AgentCallHandler,
): Readonly<Record<string, (...args: readonly unknown[]) => null>> {
	const path = (value: unknown): string | undefined =>
		typeof value === "string" ? value : undefined;
	return {
		Release: () => answer(handler, "Release", undefined),
		RequestPinCode: (device) => answer(handler, "RequestPinCode", path(device)),
		DisplayPinCode: (device) => answer(handler, "DisplayPinCode", path(device)),
		RequestPasskey: (device) => answer(handler, "RequestPasskey", path(device)),
		DisplayPasskey: (device) => answer(handler, "DisplayPasskey", path(device)),
		RequestConfirmation: (device) =>
			answer(handler, "RequestConfirmation", path(device)),
		RequestAuthorization: (device) =>
			answer(handler, "RequestAuthorization", path(device)),
		AuthorizeService: (device) =>
			answer(handler, "AuthorizeService", path(device)),
		Cancel: () => answer(handler, "Cancel", undefined),
	};
}

/**
 * Build the production exporter on the D-Bus library already underneath the
 * shared transport. The dedicated connection both exports Agent1 and issues the
 * AgentManager calls, because BlueZ associates an agent path with its caller's
 * unique bus name.
 */
export function createBluezAgentExporter(
	deps: BluezAgentExporterDeps,
): BluezAgentExporter {
	const createClient = deps.createClient ?? defaultCreateClient;
	let bus: RawBus | undefined;

	return {
		async exportAgent(path, handler): Promise<AgentExportHandle> {
			const next = createClient(deps.busAddress);
			try {
				await waitForConnect(next);
				next.exportInterface(
					implementationFor(handler),
					path,
					AGENT_DEFINITION,
				);
			} catch (error) {
				try {
					await next.disconnect();
				} catch (disconnectError) {
					throw new AggregateError(
						[error, disconnectError],
						"BlueZ agent export and cleanup both failed",
					);
				}
				throw error;
			}
			next.connection.on("error", (cause?: unknown) => {
				logger.warn(`bluetooth: pairing-agent bus error: ${String(cause)}`);
			});
			bus = next;
			return {
				path,
				release: async () => {
					if (bus === next) bus = undefined;
					await next.disconnect();
				},
			};
		},
		async callAgentManager(call: MethodCall): Promise<void> {
			const active = bus;
			if (active === undefined) {
				throw new Error("BlueZ agent object is not exported");
			}
			await withCallTimeout(
				active.invoke({
					destination: call.destination,
					path: call.path,
					interface: call.interface,
					member: call.member,
					...(call.signature !== undefined
						? { signature: call.signature }
						: {}),
					...(call.args !== undefined ? { body: call.args } : {}),
				}),
			);
		},
	};
}
