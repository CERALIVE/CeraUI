// PWA Installation and Offline Status Store using pure Svelte 5 runes
// Simplified version without legacy store compatibility

// ============================================
// Device Detection
// ============================================
const isIOS =
	typeof navigator !== "undefined" &&
	/iPad|iPhone|iPod/.test(navigator.userAgent) &&
	!(window as unknown as { MSStream?: unknown }).MSStream;

const isIOSSafari =
	isIOS &&
	/Safari/.test(navigator.userAgent) &&
	!/CriOS|FxiOS|OPiOS|mercury/.test(navigator.userAgent);

// ============================================
// PWA Installation Interface
// ============================================
interface BeforeInstallPromptEvent extends Event {
	readonly platforms: string[];
	readonly userChoice: Promise<{
		outcome: "accepted" | "dismissed";
		platform: string;
	}>;
	prompt(): Promise<void>;
}

// ============================================
// Reactive State (Svelte 5 runes)
// ============================================
let isOnlineState = $state(typeof navigator !== "undefined" ? navigator.onLine : true);
let canInstallState = $state(false);
let isInstalledState = $state(false);
let showIOSInstallPromptState = $state(false);
let isScreenshotModeState = $state(false);

// Install prompt event (not reactive, just storage)
let deferredPrompt: BeforeInstallPromptEvent | null = null;

// ============================================
// Getters (for use in non-reactive contexts)
// ============================================
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

// ============================================
// Setters
// ============================================
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

// ============================================
// Browser Event Listeners
// ============================================
if (typeof window !== "undefined") {
	// Online/Offline detection
	window.addEventListener("online", () => {
		isOnlineState = navigator.onLine;
	});
	window.addEventListener("offline", () => {
		isOnlineState = navigator.onLine;
	});

	// PWA Install Prompt handling
	window.addEventListener("beforeinstallprompt", (e: Event) => {
		e.preventDefault();

		// Suppress install prompts during screenshot mode
		if (isScreenshotModeState) return;

		deferredPrompt = e as BeforeInstallPromptEvent;
		canInstallState = true;
	});

	// App installed event
	window.addEventListener("appinstalled", () => {
		deferredPrompt = null;
		canInstallState = false;
		isInstalledState = true;
	});

	// Check if running in standalone mode (already installed)
	if (window.matchMedia("(display-mode: standalone)").matches) {
		isInstalledState = true;
	} else {
		// Desktop fallback: show install option after timeout if no native prompt
		const isDesktop = !/android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini/i.test(
			navigator.userAgent,
		);
		if (isDesktop) {
			const isLocal =
				window.location.hostname === "localhost" ||
				window.location.hostname.endsWith(".local");
			const timeoutDuration = isLocal && window.location.protocol === "http:" ? 3000 : 10000;

			setTimeout(() => {
				if (!canInstallState && !isInstalledState) {
					canInstallState = true;
				}
			}, timeoutDuration);
		}
	}

	// iOS Safari: Show install instructions
	// Delayed via queueMicrotask to allow screenshot mode to be set before checking
	if (isIOSSafari) {
		queueMicrotask(() => {
			// Check screenshot mode at execution time, not at module load
			if (getIsScreenshotMode()) return;

			const isStandalone =
				window.matchMedia("(display-mode: standalone)").matches ||
				(window.navigator as unknown as { standalone?: boolean }).standalone;
			if (!isStandalone) {
				showIOSInstallPromptState = true;
			}
		});
	}
}

// ============================================
// Install App Function
// ============================================
export async function installApp(): Promise<boolean> {
	if (!deferredPrompt) {
		// No native prompt available, show manual instructions
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
		await deferredPrompt.prompt();
		const { outcome } = await deferredPrompt.userChoice;

		// Clear prompt (can only be used once)
		deferredPrompt = null;
		canInstallState = false;

		return outcome === "accepted";
	} catch (error) {
		console.error("Error during app installation:", error);
		deferredPrompt = null;
		canInstallState = false;
		return false;
	}
}

// ============================================
// Utility Functions
// ============================================
export function testInstallPrompt() {
	return { canInstall: !!deferredPrompt, hasEvent: !!deferredPrompt };
}

export function getNetworkInfo() {
	if (typeof navigator === "undefined") return null;

	type NavigatorWithConnection = typeof navigator & {
		connection?: NetworkInformation;
		mozConnection?: NetworkInformation;
		webkitConnection?: NetworkInformation;
	};

	interface NetworkInformation {
		effectiveType?: string;
		downlink?: number;
		rtt?: number;
		saveData?: boolean;
	}

	const nav = navigator as NavigatorWithConnection;
	const connection = nav.connection || nav.mozConnection || nav.webkitConnection;

	if (connection) {
		return {
			effectiveType: connection.effectiveType,
			downlink: connection.downlink,
			rtt: connection.rtt,
			saveData: connection.saveData,
		};
	}

	return null;
}
