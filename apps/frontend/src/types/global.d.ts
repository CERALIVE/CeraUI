export {};

declare global {
	interface Window {
		stopStreamingWithNotificationClear?: () => void;
		__ceraAppMounted?: boolean;
		__ceraDisplayRefreshCount?: number;
	}
}
