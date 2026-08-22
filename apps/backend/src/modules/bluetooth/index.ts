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
 * Bluetooth foundation — public surface.
 *
 * The module is DELIBERATELY not wired into `main.ts`, any RPC procedure, or
 * `CAPABILITY_MODULES` here. It is the drivable foundation; the operator surface
 * is a separate change, so that change is a wiring review rather than a wiring
 * review plus a BlueZ review.
 */

export {
	ADAPTER_BUSY,
	type AdapterLockResult,
	pendingOnAdapter,
	resetAdapterLocks,
	setAdapterLockClockForTest,
	withAdapterLock,
} from "./adapter-lock.ts";
export {
	BT_UNAVAILABLE,
	BT_UNAVAILABLE_CAUSES,
	type BtUnavailable,
	type BtUnavailableCause,
	btUnavailable,
	isBtUnavailable,
} from "./bluetooth-availability.ts";
export {
	BLUETOOTH_DEVICE_CLASSES,
	type BluetoothCapability,
	type BluetoothDeviceClass,
	deriveCapability,
	isPlaybackOnly,
	normalizeUuids,
	shortUuid,
} from "./bluetooth-classes.ts";
export {
	AGENT_CAPABILITY_NO_IO,
	BLUEALSA_DROPIN_PATH,
	BLUEALSA_PROFILES,
	BLUEALSA_UNIT,
	BLUETOOTH_UNIT,
	BLUETOOTH_UNITS,
	CERALIVE_AGENT_PATH,
	DISCOVERY_WINDOW_MS,
} from "./bluetooth-constants.ts";
export {
	adapterPathOf,
	asBatteryPercentage,
	asBoolean,
	asStringArray,
	isObjectPath,
	isPersistentlyEnabled,
	isRunning,
	type ParseFailure,
	type ParseResult,
	parseBluealsaHelp,
	parseUnitActiveState,
	parseUnitEnabledState,
} from "./bluetooth-parsers.ts";
export {
	type BluetoothPreference,
	type BluetoothPreferenceStore,
	createMemoryPreferenceStore,
	defaultBluetoothPreferenceStore,
	initBluetoothPreferenceStore,
	resetBluetoothPreferenceStore,
} from "./bluetooth-preference.ts";
export {
	type BluetoothAdapterRow,
	type BluetoothDeviceRow,
	type BluetoothMutation,
	BluetoothRegistry,
	type PendingMutation,
} from "./bluetooth-registry.ts";
export {
	type BluetoothServicesDeps,
	type BluetoothServicesOutcome,
	buildBluealsaDropIn,
	defaultBluetoothServicesDeps,
	ensureBluealsaDropIn,
	reconcileBluetoothServices,
	resetBluetoothServiceReconcileForTest,
	setBluetoothEnabled,
	type UnitApplyRecord,
} from "./bluetooth-services.ts";
export {
	BluetoothStack,
	type BluetoothStackDeps,
	type BluetoothStackState,
	defaultBluetoothStackDeps,
} from "./bluetooth-stack.ts";
export {
	AGENT_METHODS,
	type AgentDecision,
	type AgentPolicyContext,
	type AgentRegistration,
	type BluezAgentExporter,
	noInputNoOutputPolicy,
	registerPairingAgent,
} from "./bluez-agent.ts";
export {
	type BluezAgentExporterDeps,
	createBluezAgentExporter,
} from "./bluez-agent-exporter.ts";
export {
	type BluetoothRefusal,
	type BluetoothRefusalCode,
	type BluetoothResult,
	type BluezClient,
	createBluezClient,
	type DiscoveryFilter,
	parseBluezErrorName,
} from "./bluez-dbus.ts";
