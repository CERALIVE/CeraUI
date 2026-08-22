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
 * The Bluetooth composition root.
 *
 * It owns the ORDER — reconcile the services, then observe BlueZ, then register
 * the agent, then reconnect trusted devices — and the degradation: every step
 * that cannot complete resolves to the ONE typed `bt_unavailable` token with an
 * honest cause, and boot continues (S6).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORDER IS A CONTRACT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. `isRealDevice()` — FIRST, and it is what makes the dev path spawn-free and
 *    bus-free. Everything below it touches the host.
 * 2. Reconcile the units to the persisted preference (b2). Observing BlueZ
 *    before this is pointless on the field boards this exists for: their
 *    `bluetooth.service` is disabled by the OLD image policy, so the bus name
 *    has no owner and the observation would fail with `bluez_unavailable` —
 *    reporting broken hardware for a service nobody had started yet.
 * 3. Observe. The client subscribes before it snapshots (see `bluez-dbus.ts`).
 * 4. Register the pairing agent — BEST EFFORT. The production object server
 *    answers inbound Agent1 calls; an export/refusal failure still leaves the
 *    module able to observe, trust and forget.
 * 5. Boot reconnect (e), ONCE, bounded — after the snapshot, because the
 *    trusted set comes FROM the snapshot.
 *
 * The operator preference is read from the persisted store, so a device whose
 * operator has Bluetooth switched off does not connect to BlueZ at all — the
 * radio stays off and nothing on this path touches it.
 */

import type { DbusTransport } from "@ceralive/modem-control/transport";
import { createDbusTransport } from "@ceralive/modem-control/transport";

import { logger } from "../../helpers/logger.ts";
import { isRealDevice as defaultIsRealDevice } from "../system/device-detection.ts";

import {
	type BtUnavailable,
	btUnavailable,
	isBtUnavailable,
} from "./bluetooth-availability.ts";
import {
	DISCOVERY_WINDOW_MS,
	resolveSystemBusAddress,
} from "./bluetooth-constants.ts";
import {
	type BluetoothAdapterRow,
	type BluetoothDeviceRow,
	BluetoothRegistry,
} from "./bluetooth-registry.ts";
import {
	type BluetoothServicesDeps,
	defaultBluetoothServicesDeps,
	reconcileBluetoothServices,
} from "./bluetooth-services.ts";
import {
	type AgentPolicyContext,
	type AgentRegisterFailure,
	type AgentRegistration,
	type BluezAgentExporter,
	registerPairingAgent,
} from "./bluez-agent.ts";
import { createBluezAgentExporter } from "./bluez-agent-exporter.ts";
import {
	type BluetoothResult,
	type BluezClient,
	createBluezClient,
	type DiscoveryFilter,
} from "./bluez-dbus.ts";

export interface BluetoothAgentState {
	readonly registered: boolean;
	readonly isDefaultAgent: boolean;
	readonly reason?: AgentRegisterFailure;
}

export interface BluetoothStackState {
	/** False whenever `unavailable` is set — the two are never both meaningful. */
	readonly available: boolean;
	readonly unavailable?: BtUnavailable;
	/** The persisted operator preference (absent ⇒ never decided ⇒ false). */
	readonly enabled: boolean;
	readonly adapters: readonly BluetoothAdapterRow[];
	readonly devices: readonly BluetoothDeviceRow[];
	readonly agent: BluetoothAgentState;
	/** The boot reconnect has been attempted this process lifetime. */
	readonly bootReconnectDone: boolean;
}

export interface BluetoothStackDeps {
	isRealDevice: () => Promise<boolean>;
	/**
	 * The service layer, which OWNS the preference store — the stack reads it
	 * through `services.preference` rather than carrying a second seam of its
	 * own. Two stores would let the reconciler apply one answer while the stack
	 * decided whether to observe BlueZ from another; production wires both to the
	 * same singleton, so the divergence would only ever appear under test or
	 * after a refactor, which is the worst place to find it.
	 */
	services: BluetoothServicesDeps;
	/**
	 * The bus seam. ONE transport is built per stack start and shared by the
	 * client and the agent registration — the agent must talk to the SAME bus
	 * connection whose object server exported it, or `RegisterAgent` names a path
	 * on a connection BlueZ is not calling back into.
	 */
	createTransport: () => DbusTransport;
	/** Builds the BlueZ client over that transport; injected so tests never dial. */
	createClient: (
		transport: DbusTransport,
		registry: BluetoothRegistry,
		onChange: () => void,
	) => BluezClient;
	agentExporter?: BluezAgentExporter;
	onChange?: () => void;
	log: (msg: string) => void;
	warn: (msg: string) => void;
}

export const defaultBluetoothStackDeps: BluetoothStackDeps = {
	isRealDevice: () => defaultIsRealDevice(),
	services: defaultBluetoothServicesDeps,
	createTransport: () =>
		createDbusTransport({ busAddress: resolveSystemBusAddress() }),
	createClient: (transport, registry, onChange) =>
		createBluezClient({ transport, registry, onChange }),
	agentExporter: createBluezAgentExporter({
		busAddress: resolveSystemBusAddress(),
	}),
	log: (msg) => logger.info(msg),
	warn: (msg) => logger.warn(msg),
};

const UNAVAILABLE_AGENT: BluetoothAgentState = {
	registered: false,
	isDefaultAgent: false,
};

/**
 * One live Bluetooth stack. Everything stateful (the registry, the client, the
 * pairing window, the boot-reconnect latch) is owned here, so a test drives a
 * fresh instance instead of resetting module globals.
 */
export class BluetoothStack {
	readonly #deps: BluetoothStackDeps;
	readonly #registry = new BluetoothRegistry();
	#transport: DbusTransport | undefined;
	#client: BluezClient | undefined;
	#agent: AgentRegistration | undefined;
	#agentState: BluetoothAgentState = UNAVAILABLE_AGENT;
	#unavailable: BtUnavailable | undefined = btUnavailable(
		"bluez_unavailable",
		"the Bluetooth stack has not started",
	);
	#enabled = false;
	#bootReconnectDone = false;
	#pairingWindow: { open: boolean; devicePath?: string } = { open: false };
	#discoveryTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(deps: BluetoothStackDeps = defaultBluetoothStackDeps) {
		this.#deps = deps;
	}

	/** The live operator/agent view. Cheap — safe to call on every broadcast. */
	state(): BluetoothStackState {
		const base = {
			enabled: this.#enabled,
			adapters: this.#registry.adapters(),
			devices: this.#registry.devices(),
			agent: this.#agentState,
			bootReconnectDone: this.#bootReconnectDone,
		};
		return this.#unavailable === undefined
			? { available: true, ...base }
			: { available: false, unavailable: this.#unavailable, ...base };
	}

	/**
	 * Bring the stack up. NEVER throws: every failure resolves to a typed
	 * `bt_unavailable` and the caller (a `guardNonCritical` boot phase) continues.
	 */
	async start(): Promise<BluetoothStackState> {
		try {
			return await this.#startInner();
		} catch (err) {
			this.#deps.warn(`bluetooth: stack start aborted: ${String(err)}`);
			this.#unavailable = btUnavailable("bluez_unavailable", String(err));
			return this.state();
		}
	}

	async #startInner(): Promise<BluetoothStackState> {
		// (1) The dev/emulated gate. Nothing below it may run on a dev host: no
		// spawn, no bus dial, no file write.
		if (!(await this.#deps.isRealDevice())) {
			this.#unavailable = btUnavailable(
				"emulated",
				"Bluetooth is unavailable on a dev/emulated host",
			);
			this.#deps.log("bluetooth: stack skipped (emulated / not a real device)");
			return this.state();
		}

		// (2) Re-apply the persisted preference to the units, BOTH directions.
		const reconciled = await reconcileBluetoothServices(this.#deps.services);
		if (isBtUnavailable(reconciled)) {
			this.#unavailable = reconciled;
			return this.state();
		}

		const preference = this.#deps.services.preference.read();
		this.#enabled = preference?.enabled ?? false;
		if (!this.#enabled) {
			this.#unavailable = btUnavailable(
				"bluez_unavailable",
				"the operator has Bluetooth switched off",
			);
			this.#deps.log(
				"bluetooth: operator preference is off; not observing BlueZ",
			);
			return this.state();
		}

		// (3) Observe.
		const transport = this.#deps.createTransport();
		this.#transport = transport;
		const client = this.#deps.createClient(transport, this.#registry, () =>
			this.#deps.onChange?.(),
		);
		const connected = await client.connect();
		if (!connected.ok) {
			this.#unavailable = isBtUnavailable(connected)
				? connected
				: btUnavailable("bluez_unavailable", connected.detail);
			return this.state();
		}
		this.#client = client;
		this.#unavailable = undefined;

		// (4) Pairing agent — best effort, never fatal.
		await this.#registerAgent();

		// (5) Boot reconnect, once.
		await this.runBootReconnect();

		return this.state();
	}

	async #registerAgent(): Promise<void> {
		const exporter = this.#deps.agentExporter;
		const transport = this.#transport;
		if (exporter === undefined || transport === undefined) {
			this.#agentState = {
				registered: false,
				isDefaultAgent: false,
				reason: "exporter_unavailable",
			};
			this.#deps.warn(
				"bluetooth: no pairing agent was registered (no D-Bus object server); interactive pairing depends on the host's own agent",
			);
			return;
		}

		const registration = await registerPairingAgent({
			transport,
			exporter,
			context: () => this.#agentContext(),
			log: this.#deps.log,
			warn: this.#deps.warn,
		});
		this.#agent = registration;
		this.#agentState = registration.ok
			? { registered: true, isDefaultAgent: registration.isDefaultAgent }
			: {
					registered: false,
					isDefaultAgent: false,
					reason: registration.reason,
				};
	}

	#agentContext(): AgentPolicyContext {
		const trusted = new Set(
			this.#registry
				.devices()
				.filter((d) => d.trusted)
				.map((d) => d.path),
		);
		return this.#pairingWindow.devicePath === undefined
			? { pairingWindowOpen: this.#pairingWindow.open, trustedPaths: trusted }
			: {
					pairingWindowOpen: this.#pairingWindow.open,
					expectedDevicePath: this.#pairingWindow.devicePath,
					trustedPaths: trusted,
				};
	}

	/**
	 * ONE bounded auto-connect attempt per trusted device (e).
	 *
	 * Sequential on purpose: every attempt takes the same adapter's S5 lock, so
	 * running them in parallel would make all but the first refuse themselves
	 * with `adapter_busy` and report a device as unreachable that was never
	 * tried. Latched to once per process — a headset that is genuinely off must
	 * not turn boot reconnect into a retry loop against a device that is not
	 * there.
	 */
	async runBootReconnect(): Promise<readonly string[]> {
		if (this.#bootReconnectDone) return [];
		this.#bootReconnectDone = true;

		const client = this.#client;
		if (client === undefined) return [];

		const attempted: string[] = [];
		for (const device of this.#registry.reconnectCandidates()) {
			attempted.push(device.path);
			const result = await client.connectDevice(device.path);
			if (!result.ok) {
				// A device that is simply switched off is the ORDINARY case here,
				// so this is a debug line rather than an operator-visible failure.
				logger.debug(
					`bluetooth: boot reconnect did not reach ${device.path}: ${JSON.stringify(result)}`,
				);
			}
		}
		if (attempted.length > 0) {
			this.#deps.log(
				`bluetooth: boot reconnect attempted ${attempted.length} trusted device(s)`,
			);
		}
		return attempted;
	}

	// ─── Operator surface (wired to RPC by a later todo) ───────────────────────

	/** The live client, or the typed unavailability that stands in its place. */
	#requireClient(): BluezClient | BtUnavailable {
		if (this.#client !== undefined) return this.#client;
		return (
			this.#unavailable ??
			btUnavailable("bluez_unavailable", "the Bluetooth stack is not running")
		);
	}

	async setPowered(
		adapterPath: string,
		powered: boolean,
	): Promise<BluetoothResult<boolean>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;
		return client.setPowered(adapterPath, powered);
	}

	/**
	 * Start a BOUNDED discovery. The window stops itself after
	 * {@link DISCOVERY_WINDOW_MS} so a scan an operator walked away from cannot
	 * hold the radio (and the pairing window with it) open indefinitely.
	 */
	async startDiscovery(
		adapterPath: string,
		filter?: DiscoveryFilter,
	): Promise<BluetoothResult<void>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;

		const started = await client.startDiscovery(adapterPath, filter);
		if (started.ok) {
			this.#armDiscoveryStop(adapterPath, client);
		}
		return started;
	}

	async stopDiscovery(adapterPath: string): Promise<BluetoothResult<void>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;
		this.#clearDiscoveryTimer();
		return client.stopDiscovery(adapterPath);
	}

	#armDiscoveryStop(adapterPath: string, client: BluezClient): void {
		this.#clearDiscoveryTimer();
		this.#discoveryTimer = setTimeout(() => {
			this.#discoveryTimer = undefined;
			void client.stopDiscovery(adapterPath).then((res) => {
				if (!res.ok) {
					this.#deps.warn(
						`bluetooth: the bounded discovery window could not stop ${adapterPath}: ${JSON.stringify(res)}`,
					);
				}
			});
		}, DISCOVERY_WINDOW_MS);
		// Never hold the event loop open for a scan window.
		this.#discoveryTimer.unref?.();
	}

	#clearDiscoveryTimer(): void {
		if (this.#discoveryTimer !== undefined) {
			clearTimeout(this.#discoveryTimer);
			this.#discoveryTimer = undefined;
		}
	}

	/**
	 * Pair a device.
	 *
	 * The operator's request IS the pairing window: it is opened for THIS device
	 * only, for the duration of the call, and closed in a `finally`. That is what
	 * lets the `NoInputNoOutput` agent accept a Just Works authorization without
	 * accepting one from an arbitrary peer in radio range.
	 */
	async pair(devicePath: string): Promise<BluetoothResult<void>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;

		this.#pairingWindow = { open: true, devicePath };
		try {
			return await client.pair(devicePath);
		} finally {
			this.#pairingWindow = { open: false };
		}
	}

	async setTrusted(
		devicePath: string,
		trusted: boolean,
	): Promise<BluetoothResult<boolean>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;
		return client.setTrusted(devicePath, trusted);
	}

	async forget(devicePath: string): Promise<BluetoothResult<void>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;
		return client.forget(devicePath);
	}

	async connectDevice(devicePath: string): Promise<BluetoothResult<void>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;
		return client.connectDevice(devicePath);
	}

	async disconnectDevice(devicePath: string): Promise<BluetoothResult<void>> {
		const client = this.#requireClient();
		if (isBtUnavailable(client)) return client;
		return client.disconnectDevice(devicePath);
	}

	/** Tear the stack down: unregister the agent, drop subscriptions, disconnect. */
	async stop(): Promise<void> {
		this.#clearDiscoveryTimer();
		if (this.#agent?.ok === true) {
			await this.#agent.unregister();
		}
		this.#agent = undefined;
		this.#agentState = UNAVAILABLE_AGENT;
		if (this.#client !== undefined) {
			await this.#client.disconnect();
			this.#client = undefined;
		}
		this.#transport = undefined;
		this.#registry.reset();
		this.#unavailable = btUnavailable(
			"bluez_unavailable",
			"the Bluetooth stack was stopped",
		);
	}

	/** The registry, for the wire producer a later todo adds. */
	registry(): BluetoothRegistry {
		return this.#registry;
	}
}
