import { AsyncLocalStorage } from "node:async_hooks";
import { getWifiInterfacesByMacAddress } from "./wifi-connections.ts";
import {
	type BaseWifiInterface,
	getMacAddressForWifiInterface,
} from "./wifi-interfaces.ts";
import type { WifiOperationBinding } from "./wifi-operation-binding.ts";
import { wifiAdapterKeyMac, wifiAdapterKeyPort } from "./wifi-permanent-mac.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "./wifi-radio-identity.ts";
import { wifiRadioObservation } from "./wifi-radio-observation.ts";
import { projectWifiRadioIncarnation } from "./wifi-radio-publication.ts";
import { sampleRadio } from "./wifi-radio-read-budget.ts";

export type WifiBindingRefusal = {
	readonly success: false;
	readonly error:
		| "binding-required"
		| "radio-changed"
		| "radio-unverified"
		| "no-device"
		| "DEVICE_BUSY";
	readonly reason?: string;
};

export function resolveMockWifiBinding(
	device: string | number,
	expected: string | undefined,
): WifiBindingRefusal | undefined {
	const radio = resolveMockWifiDevice(String(device));
	if (!radio) return { success: false, error: "no-device" };
	if (isMockWifiLimited(radio))
		return { success: false, error: "radio-unverified" };
	if (expected === undefined)
		return { success: false, error: "binding-required" };
	return expected === getMockWifiIncarnation(radio)
		? undefined
		: { success: false, error: "radio-changed" };
}

type WifiRequestBinding = {
	readonly device: string;
	readonly expected: string | undefined;
	readonly kind: "config" | "mode";
};

/** One incoming guarded request, consumed at lock entry or retired on exit. */
type WifiRequestAdmission = WifiRequestBinding & {
	consumed: boolean;
	lockEntry?: Promise<void>;
};

const requests = new AsyncLocalStorage<WifiRequestAdmission>();

export function withWifiRequestBinding<T>(
	binding: WifiRequestBinding,
	operation: (admission: WifiRequestAdmission) => T,
): T {
	const admission = { ...binding, consumed: false };
	return requests.run(admission, () => operation(admission));
}

/**
 * Detached work a request schedules or triggers (confirmation polls, restore
 * edges) must never act under that request's admission.
 */
export function withoutWifiRequestBinding<T>(operation: () => T): T {
	return requests.exit(operation);
}

/**
 * Configure acknowledges dispatch before its transaction finishes. Keep its
 * request alive until the lock callback enters or the lock attempt exits.
 */
export function registerWifiRequestLockEntry(
	row: BaseWifiInterface,
): (() => void) | undefined {
	const request = requests.getStore();
	if (!request || request.consumed || Number(request.device) !== row.id) return;
	const entered = Promise.withResolvers<void>();
	request.lockEntry = entered.promise;
	return entered.resolve;
}

/**
 * The transaction lock entry of a guarded operation. Only an incoming guarded
 * request carries this authority requirement; internal callers run
 * `transaction` unchanged. The admission is one-shot and ends here, admitted or
 * refused: nothing that runs afterwards, in the transaction, its caller's
 * publications or any work either schedules, reads it again.
 */
export function admitWifiRequest<T>(
	row: BaseWifiInterface,
	transaction: (binding?: WifiOperationBinding) => Promise<T>,
	refused: (refusal: WifiBindingRefusal) => T,
): Promise<T> {
	const request = requests.getStore();
	if (!request || request.consumed || Number(request.device) !== row.id)
		return transaction();
	request.consumed = true;
	const { device, expected, kind } = request;
	return resolveWifiBinding(device, expected, kind).then((binding) => {
		if (!binding.success) return refused(binding);
		if (binding.row !== row)
			return refused({ success: false, error: "radio-changed" });
		return transaction(binding.operation);
	});
}

/**
 * The caller owns the adapter lock. A wire projection alone is never admission:
 * compare a new bracketed physical sample with the producer's current witness.
 */
export async function resolveWifiBinding(
	device: number | string,
	expected: string | undefined,
	kind: "config" | "mode",
): Promise<
	| WifiBindingRefusal
	| {
			readonly success: true;
			readonly row: BaseWifiInterface;
			readonly macAddress: string;
			readonly operation?: WifiOperationBinding;
	  }
> {
	const interfaces = getWifiInterfacesByMacAddress();
	const mac =
		kind === "config"
			? getMacAddressForWifiInterface(Number(device))
			: Object.keys(interfaces).find(
					(key) => interfaces[key]?.id === Number(device),
				);
	const row = mac === undefined ? undefined : interfaces[mac];
	if (mac === undefined || !row) return { success: false, error: "no-device" };
	if (
		!wifiAdapterKeyMac(mac) ||
		row.degradedReason === "permanent-mac-unresolved"
	)
		return { success: false, error: "radio-unverified" };
	if (shouldUseMocks()) {
		return (
			resolveMockWifiBinding(device, expected) ?? {
				success: true,
				row,
				macAddress: mac,
			}
		);
	}
	if (expected === undefined)
		return { success: false, error: "binding-required" };

	const unobserved: WifiBindingRefusal = {
		success: false,
		error: "radio-changed",
		reason: "current-unobserved",
	};
	const changed: WifiBindingRefusal = {
		success: false,
		error: "radio-changed",
	};
	const controller = new AbortController();
	const expired = Promise.withResolvers<WifiBindingRefusal>();
	const timer = setTimeout(() => {
		controller.abort();
		expired.resolve(unobserved);
	}, 2000);
	try {
		const sample = async () => {
			let identity = wifiRadioIdentity.state.rows.get(row.ifname);
			if (projectWifiRadioIncarnation(row, identity) === undefined) {
				await wifiRadioObservation.settled;
				if (controller.signal.aborted) return unobserved;
				identity = wifiRadioIdentity.state.rows.get(row.ifname);
			}
			const token = projectWifiRadioIncarnation(row, identity);
			if (token === undefined || !identity?.lifetime) return unobserved;
			if (
				token !== expected ||
				identity.classification !== "verified" ||
				identity.degradedReason
			)
				return changed;
			const fresh = await sampleRadio(
				row.ifname,
				radioIdentityReaders,
				controller.signal,
			);
			if (controller.signal.aborted) return unobserved;
			const current = wifiRadioIdentity.state.rows.get(row.ifname);
			if (getWifiInterfacesByMacAddress()[mac] !== row) return changed;
			const currentToken = projectWifiRadioIncarnation(row, current);
			if (currentToken === undefined) return unobserved;
			if (
				!fresh ||
				!current?.lifetime ||
				currentToken !== expected ||
				current.key !== mac ||
				current.classification !== "verified" ||
				current.degradedReason ||
				fresh.lifetime.ifindex !== current.lifetime.ifindex ||
				fresh.lifetime.wiphy !== current.lifetime.wiphy ||
				fresh.lifetime.phyPath !== current.lifetime.phyPath ||
				(wifiAdapterKeyPort(mac) && fresh.devicePath !== current.devicePath) ||
				(!fresh.macReadFailed && fresh.permanentMac !== current.permanentMac)
			)
				return changed;
			return {
				success: true,
				row,
				macAddress: mac,
				operation: {
					row,
					key: mac,
					ifname: current.ifname,
					token: currentToken,
					mac: current.permanentMac,
					...(current.devicePath && fresh.devicePath === current.devicePath
						? { devicePath: current.devicePath }
						: {}),
					lifetime: fresh.lifetime,
				},
			} as const;
		};
		return await Promise.race([sample(), expired.promise]);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { isMockWifiLimited } from "../../mocks/providers/wifi.ts";
import {
	getMockWifiIncarnation,
	resolveMockWifiDevice,
} from "../../mocks/providers/wifi-incarnation.ts";
