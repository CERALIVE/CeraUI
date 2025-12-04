import type { ConfigMessage } from "@ceraui/rpc/schemas";

declare global {
	interface Window {
		startStreamingWithNotificationClear?: (
			config: Partial<ConfigMessage>,
		) => void;
		stopStreamingWithNotificationClear?: () => void;
	}
}
