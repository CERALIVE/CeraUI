import type {
	HotspotToggleInput,
	SetWifiAdapterModeInput,
} from "@ceraui/rpc/schemas";
import { os } from "@orpc/server";
import { shouldUseMocks } from "../../mocks/mock-service.ts";
import { getMockWifiFaults } from "../../mocks/providers/wifi.ts";
import {
	getMockWifiIncarnation,
	resolveMockWifiDevice,
} from "../../mocks/providers/wifi-incarnation.ts";
import {
	wifiAdapterLockKeyForDeviceId,
	withWifiAdapterLock,
} from "../../modules/wifi/wifi-adapter-lock.ts";
import { buildAdapterModeOutcome } from "../../modules/wifi/wifi-adapter-mode-outcome.ts";
import {
	resolveMockWifiBinding,
	resolveWifiBinding,
	type WifiBindingRefusal,
	withWifiRequestBinding,
} from "../../modules/wifi/wifi-binding.ts";
import { captureWifiFrameIncarnation } from "../../modules/wifi/wifi-frame-binding.ts";
import {
	getWifiFrameIncarnation,
	withWifiFrameIncarnation,
} from "../../modules/wifi/wifi-frame-incarnation.ts";
import type { RPCContext } from "../types.ts";

type Action = "prepare" | "start" | "configure" | "mode";
type Input = HotspotToggleInput &
	Partial<Pick<SetWifiAdapterModeInput, "mode">>;

async function probe(
	input: Input,
	kind: "config" | "mode",
): Promise<WifiBindingRefusal | undefined> {
	const key = wifiAdapterLockKeyForDeviceId(input.device);
	if (!key) return { success: false, error: "no-device" };
	const lock = await withWifiAdapterLock(key, () =>
		resolveWifiBinding(input.device, input.incarnation, kind),
	);
	if (!lock.success) return { success: false, error: lock.error };
	return lock.result.success ? undefined : lock.result;
}

export const wifiRequestAdmissionMiddleware = os
	.$context<RPCContext>()
	.middleware(async function wifiRequestAdmission(
		{ context, next },
		input: Input & { readonly action: Action },
		done,
	) {
		const { action } = input;
		const kind = action === "mode" ? "mode" : "config";
		const operation = () => {
			if (action === "mode" && input.mode === "station") return next();
			return withWifiRequestBinding(
				{ device: input.device, expected: input.incarnation, kind },
				async (admission) => {
					let refusal: WifiBindingRefusal | undefined;
					try {
						const mocked = shouldUseMocks();
						refusal = mocked
							? getMockWifiFaults().deviceBusy
								? ({ success: false, error: "DEVICE_BUSY" } as const)
								: resolveMockWifiBinding(input.device, input.incarnation)
							: await probe(input, kind);
						if (!refusal) {
							// Mock effects follow this synchronous check without a lock.
							if (mocked) admission.consumed = true;
							return await next();
						}
					} finally {
						await admission.lockEntry;
						admission.consumed = true;
					}
					const error = {
						error: refusal.error,
						...(refusal.reason === undefined ? {} : { reason: refusal.reason }),
					};
					// Entry refusal frames belong only to this requesting socket.
					switch (action) {
						case "prepare":
							break;
						case "start":
							context.ws.send(
								JSON.stringify({
									wifi: {
										hotspot: {
											start: { device: Number(input.device), ...error },
										},
									},
								}),
							);
							break;
						case "mode":
							context.ws.send(
								JSON.stringify({
									wifi: {
										adapter_mode: buildAdapterModeOutcome(
											input.device,
											refusal,
										),
									},
								}),
							);
							break;
						case "configure":
							context.ws.send(
								JSON.stringify({
									wifi: {
										hotspot: {
											config: {
												device: Number(input.device),
												...error,
												...getWifiFrameIncarnation(),
											},
										},
									},
								}),
							);
							break;
					}
					return done({ output: refusal });
				},
			);
		};
		if (action !== "configure" && action !== "mode") return operation();
		const radio = shouldUseMocks()
			? resolveMockWifiDevice(input.device)
			: undefined;
		const frame =
			input.incarnation !== undefined
				? { incarnation: input.incarnation }
				: shouldUseMocks()
					? radio === undefined
						? {}
						: { incarnation: getMockWifiIncarnation(radio) }
					: captureWifiFrameIncarnation(input.device, kind);
		return withWifiFrameIncarnation(frame, operation);
	});

export function wifiRequestAdmission(action: Action) {
	return wifiRequestAdmissionMiddleware.adaptInput((input: Input) => ({
		...input,
		action,
	}));
}
