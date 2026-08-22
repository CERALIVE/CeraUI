import { describe, expect, test } from "bun:test";

import type { MethodCall } from "@ceralive/modem-control/transport";
import { AGENT_IFACE } from "../modules/bluetooth/bluetooth-constants.ts";
import { createBluezAgentExporter } from "../modules/bluetooth/bluez-agent-exporter.ts";

const AGENT_PATH = "/tv/ceralive/bluetooth/agent";
const DEVICE_PATH = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF";

class FakeConnection {
	readonly #listeners = new Map<string, Set<(value?: unknown) => void>>();

	on(event: "error", listener: (value?: unknown) => void): void {
		const listeners = this.#listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.#listeners.set(event, listeners);
	}

	once(event: "connect" | "error", listener: (value?: unknown) => void): void {
		const wrapped = (value?: unknown): void => {
			this.removeListener(event, wrapped);
			listener(value);
		};
		const listeners = this.#listeners.get(event) ?? new Set();
		listeners.add(wrapped);
		this.#listeners.set(event, listeners);
	}

	removeListener(
		event: "connect" | "error",
		listener: (value?: unknown) => void,
	): void {
		this.#listeners.get(event)?.delete(listener);
	}

	emit(event: "connect" | "error", value?: unknown): void {
		for (const listener of [...(this.#listeners.get(event) ?? [])]) {
			listener(value);
		}
	}
}

class FakeObjectServer {
	readonly connection = new FakeConnection();
	readonly calls: MethodCall[] = [];
	implementation: Readonly<
		Record<string, (...args: readonly unknown[]) => null>
	> = {};
	interfaceName: string | undefined;
	disconnected = false;

	exportInterface(
		implementation: Readonly<
			Record<string, (...args: readonly unknown[]) => null>
		>,
		_path: string,
		definition: { readonly name: string },
	): void {
		this.implementation = implementation;
		this.interfaceName = definition.name;
	}

	async invoke(call: MethodCall): Promise<void> {
		this.calls.push(call);
	}

	async disconnect(): Promise<void> {
		this.disconnected = true;
	}
}

describe("the production BlueZ Agent1 exporter", () => {
	test("it exports Agent1 and answers RequestAuthorization on the registering connection", async () => {
		const bus = new FakeObjectServer();
		const exporter = createBluezAgentExporter({
			busAddress: "unix:path=/test/system-bus",
			createClient: () => bus,
		});
		const exportPromise = exporter.exportAgent(AGENT_PATH, (method, path) =>
			method === "RequestAuthorization" && path === DEVICE_PATH
				? { action: "accept" }
				: {
						action: "reject",
						error: "org.bluez.Error.Rejected",
						why: "outside the operator pairing window",
					},
		);
		bus.connection.emit("connect");
		const handle = await exportPromise;

		await exporter.callAgentManager?.({
			destination: "org.bluez",
			path: "/org/bluez",
			interface: "org.bluez.AgentManager1",
			member: "RegisterAgent",
			signature: "os",
			args: [AGENT_PATH, "NoInputNoOutput"],
		});
		const authorization = bus.implementation.RequestAuthorization;

		expect(bus.interfaceName).toBe(AGENT_IFACE);
		expect(bus.calls).toHaveLength(1);
		expect(authorization?.(DEVICE_PATH)).toBeNull();

		await handle.release();
		expect(bus.disconnected).toBe(true);
	});
});
