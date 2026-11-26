export {};

declare global {
	interface Window {
		stopStreamingWithNotificationClear?: (
			prepareDispatch?: () => boolean,
		) => void;
		__ceraAppMounted?: boolean;
		__ceraDisplayRefreshCount?: number;
	}
}
