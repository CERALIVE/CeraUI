import { AsyncLocalStorage } from "node:async_hooks";
import type { WifiAdapterModeResult } from "@ceraui/rpc/schemas";

export type WifiFrameIncarnation = Readonly<
	Pick<WifiAdapterModeResult, "incarnation">
>;

const dispatches = new AsyncLocalStorage<WifiFrameIncarnation>();

export function getWifiFrameIncarnation(): WifiFrameIncarnation | undefined {
	return dispatches.getStore();
}

export function withWifiFrameIncarnation<T>(
	binding: WifiFrameIncarnation,
	operation: () => T,
): T {
	return dispatches.run(binding, operation);
}
