// PWA Installation and Offline Status Store using Svelte 5 runes

// iOS Detection
const isIOS =
	typeof navigator !== "undefined" &&
	/iPad|iPhone|iPod/.test(navigator.userAgent) &&
	!(window as unknown as { MSStream?: unknown }).MSStream;
const isIOSSafari =
	isIOS &&
	/Safari/.test(navigator.userAgent) &&
	!/CriOS|FxiOS|OPiOS|mercury/.test(navigator.userAgent);

// State using Svelte 5 runes
let isOnlineState = $state(typeof navigator !== "undefined" ? navigator.onLine : true);
let canInstallState = $state(false);
let isInstalledState = $state(false);
let showIOSInstallPromptState = $state(false);
let isScreenshotModeState = $state(false);

// Install prompt event
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let installEventSetup = false;

// PWA Installation Interface
interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	readonly userChoice: Promise<{
		outcome: "accepted" | "dismissed";
		platform: string;
	}>;
	prompt(): Promise<void>;
}

// Getters
export function getIsOnline(): boolean {
	return isOnlineState;
}

export function getCanInstall(): boolean {
	return canInstallState;
}

export function getIsInstalled(): boolean {
	return isInstalledState;
}

export function getShowIOSInstallPrompt(): boolean {
	return showIOSInstallPromptState;
}

export function getIsScreenshotMode(): boolean {
	return isScreenshotModeState;
}

// Setters
export function setIsOnline(value: boolean): void {
	isOnlineState = value;
}

export function setCanInstall(value: boolean): void {
	canInstallState = value;
}

export function setIsInstalled(value: boolean): void {
	isInstalledState = value;
}

export function setShowIOSInstallPrompt(value: boolean): void {
	showIOSInstallPromptState = value;
}

export function setIsScreenshotMode(value: boolean): void {
	isScreenshotModeState = value;
}

// Online/Offline Detection
function updateOnlineStatus() {
	isOnlineState = navigator.onLine;
}

if (typeof window !== "undefined") {
	window.addEventListener("online", updateOnlineStatus);
	window.addEventListener("offline", updateOnlineStatus);
}

// PWA Install Prompt Handling
function setupInstallPrompt() {
	if (installEventSetup || typeof window === "undefined") return;
	installEventSetup = true;

	window.addEventListener("beforeinstallprompt", (e: Event) => {
		// Prevent the mini-infobar from appearing on mobile
		e.preventDefault();

		// Suppress install prompts during screenshot mode
		// Use getter to read current value (not captured initial value)
		if (getIsScreenshotMode()) {
			return;
		}

		// Stash the event so it can be triggered later
		deferredPrompt = e as BeforeInstallPromptEvent;
		// Update UI to notify the user they can install the PWA
		canInstallState = true;
	});
}

// Initialize the install prompt handling
if (typeof window !== "undefined") {
	setupInstallPrompt();

	// Check if app is already installed
	window.addEventListener("appinstalled", () => {
		// Clear the deferredPrompt so it can be garbage collected
		deferredPrompt = null;
		canInstallState = false;
		isInstalledState = true;
	});

	// Check if running in standalone mode (already installed)
	if (window.matchMedia("(display-mode: standalone)").matches) {
		isInstalledState = true;
	} else {
		// Fallback for desktop browsers
		const isDesktop =
			!/android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
				navigator.userAgent,
			);
		if (isDesktop) {
			const isLocalDomain =
				window.location.hostname === "localhost" ||
				window.location.hostname.endsWith(".local");
			const isHTTP = window.location.protocol === "http:";

			const timeoutDuration = isLocalDomain && isHTTP ? 3000 : 10000;

			setTimeout(() => {
				if (!canInstallState && !isInstalledState) {
					canInstallState = true;
				}
			}, timeoutDuration);
		}
	}

	// iOS PWA Installation Detection
	if (isIOSSafari) {
		// Suppress iOS install prompts during screenshot mode
		// Use getter to read current value (not captured initial value)
		if (!getIsScreenshotMode()) {
			// Check if not in standalone mode and not already installed
			const isStandalone =
				window.matchMedia("(display-mode: standalone)").matches ||
				(window.navigator as unknown as { standalone?: boolean }).standalone;
			if (!isStandalone) {
				showIOSInstallPromptState = true;
			}
		}
	}
}

// Install App Function
export async function installApp(): Promise<boolean> {
	if (!deferredPrompt) {
		// Import toast dynamically to avoid circular dependencies
		void import("svelte-sonner").then(({ toast }) => {
			toast.info("Install App", {
				description:
					'Use your browser\'s "Install" or "Add to Home Screen" option in the menu.',
				duration: 5000,
			});
		});

		return false;
	}

	try {
		// Show the install prompt
		await deferredPrompt.prompt();

		// Wait for the user to respond to the prompt
		const { outcome } = await deferredPrompt.userChoice;

		// Clear the saved prompt since it can't be used again
		deferredPrompt = null;
		canInstallState = false;

		return outcome === "accepted";
	} catch (error) {
		console.error("Error during app installation:", error);
		// Clear the prompt on error
		deferredPrompt = null;
		canInstallState = false;
		return false;
	}
}

// Network Status Helper
export function testInstallPrompt() {
	return { canInstall: !!deferredPrompt, hasEvent: !!deferredPrompt };
}

export function getNetworkInfo() {
	if (typeof navigator === "undefined") return null;

	const connection =
		(
			navigator as typeof navigator & {
				connection?: unknown;
				mozConnection?: unknown;
				webkitConnection?: unknown;
			}
		).connection ||
		(
			navigator as typeof navigator & {
				connection?: unknown;
				mozConnection?: unknown;
				webkitConnection?: unknown;
			}
		).mozConnection ||
		(
			navigator as typeof navigator & {
				connection?: unknown;
				mozConnection?: unknown;
				webkitConnection?: unknown;
			}
		).webkitConnection;

	if (connection) {
		const networkConnection = connection as {
			effectiveType?: string;
			downlink?: number;
			rtt?: number;
			saveData?: boolean;
		};
		return {
			effectiveType: networkConnection.effectiveType,
			downlink: networkConnection.downlink,
			rtt: networkConnection.rtt,
			saveData: networkConnection.saveData,
		};
	}

	return null;
}

// Store subscriber management for legacy store compatibility
type Subscriber<T> = (value: T) => void;

const isOnlineSubscribers = new Set<Subscriber<boolean>>();
const canInstallSubscribers = new Set<Subscriber<boolean>>();

function notifyIsOnlineSubscribers() {
	for (const subscriber of isOnlineSubscribers) {
		subscriber(isOnlineState);
	}
}

function notifyCanInstallSubscribers() {
	for (const subscriber of canInstallSubscribers) {
		subscriber(canInstallState);
	}
}

// Override setters to notify subscribers
const originalSetIsOnline = setIsOnline;
export function setIsOnlineWithNotify(value: boolean): void {
	isOnlineState = value;
	notifyIsOnlineSubscribers();
}

const originalSetCanInstall = setCanInstall;
export function setCanInstallWithNotify(value: boolean): void {
	canInstallState = value;
	notifyCanInstallSubscribers();
}

// Update the online status handler to notify subscribers
function updateOnlineStatusWithNotify() {
	isOnlineState = navigator.onLine;
	notifyIsOnlineSubscribers();
}

// Re-register event listeners to use the notifying version
if (typeof window !== "undefined") {
	window.removeEventListener("online", updateOnlineStatus);
	window.removeEventListener("offline", updateOnlineStatus);
	window.addEventListener("online", updateOnlineStatusWithNotify);
	window.addEventListener("offline", updateOnlineStatusWithNotify);
}

// Legacy-compatible store-like objects for components that use $store syntax
export const isOnline = {
	get value() {
		return isOnlineState;
	},
	set(value: boolean) {
		isOnlineState = value;
		notifyIsOnlineSubscribers();
	},
	subscribe(callback: Subscriber<boolean>): () => void {
		isOnlineSubscribers.add(callback);
		// Call immediately with current value (standard store behavior)
		callback(isOnlineState);
		// Return unsubscribe function
		return () => {
			isOnlineSubscribers.delete(callback);
		};
	},
};

export const canInstall = {
	get value() {
		return canInstallState;
	},
	set(value: boolean) {
		canInstallState = value;
		notifyCanInstallSubscribers();
	},
	subscribe(callback: Subscriber<boolean>): () => void {
		canInstallSubscribers.add(callback);
		// Call immediately with current value (standard store behavior)
		callback(canInstallState);
		// Return unsubscribe function
		return () => {
			canInstallSubscribers.delete(callback);
		};
	},
};

export const isInstalled = {
	get value() {
		return isInstalledState;
	},
	set: setIsInstalled,
};

export const showIOSInstallPrompt = {
	get value() {
		return showIOSInstallPromptState;
	},
	set: setShowIOSInstallPrompt,
};

export const isScreenshotMode = {
	get value() {
		return isScreenshotModeState;
	},
	set: setIsScreenshotMode,
};
