/** Publication edges only. This leaf must never import the application graph. */
export interface WifiAdapterModeRestoreSource {
	readonly hasDiscovery: () => boolean;
	readonly subscribe: (listener: () => Promise<void>) => () => void;
}

let discoveryPublished = false;
const listeners = new Set<() => Promise<void>>();

export const wifiAdapterModeRestoreSource: WifiAdapterModeRestoreSource = {
	hasDiscovery: () => discoveryPublished,
	subscribe: (listener) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	},
};

export async function notifyWifiAdapterModeEdge(): Promise<void> {
	await Promise.all([...listeners].map((listener) => listener()));
}

export function notifyWifiAdapterModeDiscovery(): Promise<void> {
	discoveryPublished = true;
	return notifyWifiAdapterModeEdge();
}
