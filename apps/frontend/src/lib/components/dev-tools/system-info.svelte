<script lang="ts">
import { existingLocales, loadLocaleAsync, type Locales } from '@ceraui/i18n';
import { LL, locale, setLocale } from '@ceraui/i18n/svelte';
import { Code } from '@lucide/svelte';

import SystemBrowserPanel from '$lib/components/dev-tools/system-browser-panel.svelte';
import SystemBuildPanel from '$lib/components/dev-tools/system-build-panel.svelte';
import SystemLocalePanel from '$lib/components/dev-tools/system-locale-panel.svelte';
import SystemNetworkPanel from '$lib/components/dev-tools/system-network-panel.svelte';
import SystemPerformancePanel from '$lib/components/dev-tools/system-performance-panel.svelte';
import SystemPreferencesPanel from '$lib/components/dev-tools/system-preferences-panel.svelte';
import SystemTimingPanel from '$lib/components/dev-tools/system-timing-panel.svelte';
import * as Card from '$lib/components/ui/card';
import { BUILD_INFO, getSocketUrl } from '$lib/env';
import { setLocale as setLocaleStore } from '$lib/stores/locale.svelte';
import { CLIENT_VERSION } from '$lib/stores/version-manager';

// Real environment data using runes
const performanceData = $state({
	loadTime: 0,
	memory: 0,
	timing: null as PerformanceNavigationTiming | null,
	loadTimeCalculated: false, // Track if load time has been properly calculated
});

type NetworkConnection = {
	effectiveType?: string;
	downlink?: number;
	rtt?: number;
} | null;

let systemInfo = $state({
	browser: '',
	version: '',
	platform: '',
	cookieEnabled: false,
	onLine: true,
	connection: null as NetworkConnection,
});

let localeInfo = $state({
	currentLocale: '',
	currentLanguageName: '',
	currentLanguageFlag: '',
	browserLanguage: '',
	supportedLocales: [] as Array<{ code: string; name: string; flag?: string }>,
});

let windowInfo = $state({
	width: 0,
	height: 0,
	devicePixelRatio: 1,
	colorScheme: 'light',
	reducedMotion: false,
	screenWidth: 0,
	screenHeight: 0,
});

let buildInfo = $state({
	mode: '',
	nodeEnv: '',
	dev: false,
	socketEndpoint: '',
	socketPort: '',
	clientVersion: '',
	timestamp: '',
});

// Update system information
function updateSystemInfo() {
	// Browser detection
	const { userAgent } = navigator;
	let browser = $LL.devtools.unknown();
	let version = '';

	if (userAgent.includes('Chrome')) {
		browser = 'Chrome';
		version = userAgent.match(/Chrome\/([\d.]+)/)?.[1] || '';
	} else if (userAgent.includes('Firefox')) {
		browser = 'Firefox';
		version = userAgent.match(/Firefox\/([\d.]+)/)?.[1] || '';
	} else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
		browser = 'Safari';
		version = userAgent.match(/Version\/([\d.]+)/)?.[1] || '';
	} else if (userAgent.includes('Edge')) {
		browser = 'Edge';
		version = userAgent.match(/Edge\/([\d.]+)/)?.[1] || '';
	}

	systemInfo = {
		browser,
		version,
		platform: navigator.platform,
		cookieEnabled: navigator.cookieEnabled,
		onLine: navigator.onLine,
		connection: (navigator as Navigator & { connection?: NetworkConnection }).connection || null,
	};
}

// Update window information with NaN safety
function updateWindowInfo() {
	const width = window.innerWidth;
	const height = window.innerHeight;
	const dpr = window.devicePixelRatio;
	const screenW = screen.width;
	const screenH = screen.height;

	windowInfo = {
		width: isFinite(width) ? width : 0,
		height: isFinite(height) ? height : 0,
		devicePixelRatio: isFinite(dpr) ? dpr : 1,
		colorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
		reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
		screenWidth: isFinite(screenW) ? screenW : 0,
		screenHeight: isFinite(screenH) ? screenH : 0,
	};
}

// Language flag mapping (since they're not in the type definition)
const languageFlags: Record<string, string> = {
	en: '🇺🇸',
	es: '🇪🇸',
	'pt-BR': '🇧🇷',
	fr: '🇫🇷',
	de: '🇩🇪',
	zh: '🇨🇳',
	ar: '🇸🇦',
	ja: '🇯🇵',
	ko: '🇰🇷',
	hi: '🇮🇳',
};

// Update locale information using app's i18n system
function updateLocaleInfo() {
	// Get current locale value first
	const unsubscribe = locale.subscribe((currentLocale) => {
		const currentLocaleData = existingLocales.find((l) => l.code === currentLocale);

		localeInfo = {
			currentLocale: currentLocale || 'en',
			currentLanguageName: currentLocaleData?.name || 'English',
			currentLanguageFlag: languageFlags[currentLocale || 'en'] || '🌐',
			browserLanguage: navigator.language,
			supportedLocales: existingLocales.map((l) => ({
				code: l.code,
				name: l.name,
				flag: languageFlags[l.code] || '🌐',
			})),
		};
	});

	// Return unsubscribe function for cleanup
	return unsubscribe;
}

type PerformanceMemory = {
	usedJSHeapSize?: number;
	totalJSHeapSize?: number;
	jsHeapSizeLimit?: number;
};

// Update performance data
function updatePerformanceData() {
	// Memory usage (always update - this should change over time)
	// performance.memory is Chrome-specific and not in standard types
	const perfWithMemory = performance as Performance & { memory?: PerformanceMemory };
	if (perfWithMemory.memory) {
		const memoryData = perfWithMemory.memory;
		const usedHeapSize = memoryData.usedJSHeapSize || 0;
		performanceData.memory = Math.round(usedHeapSize / 1024 / 1024);
	}

	// Navigation timing (only calculate load time once)
	if (!performanceData.loadTimeCalculated && performance.getEntriesByType) {
		const navTiming = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
		if (navTiming && navTiming.loadEventEnd && navTiming.startTime !== undefined) {
			performanceData.timing = navTiming;
			const loadTime = navTiming.loadEventEnd - navTiming.startTime;
			// Only set if we have a valid positive number
			if (loadTime > 0 && isFinite(loadTime)) {
				performanceData.loadTime = Math.round(loadTime);
				performanceData.loadTimeCalculated = true; // Mark as calculated
			}
		} else if (document.readyState === 'complete') {
			// Only use performance.now() fallback when page is fully loaded
			// This represents time since page start, not ideal but better than increasing value
			const loadTime = performance.now();
			if (loadTime > 0 && isFinite(loadTime)) {
				performanceData.loadTime = Math.round(loadTime);
				performanceData.loadTimeCalculated = true; // Mark as calculated to prevent further updates
			}
		}
		// If page isn't complete yet, keep load time at 0 until we can calculate it properly
	}
}

// Update build information
function updateBuildInfo() {
	const socketUrl = getSocketUrl();
	const parsed = socketUrl ? new URL(socketUrl) : null;
	buildInfo = {
		mode: BUILD_INFO.MODE,
		nodeEnv: BUILD_INFO.NODE_ENV,
		dev: BUILD_INFO.IS_DEV,
		socketEndpoint: parsed ? `${parsed.protocol}//${parsed.hostname}` : socketUrl,
		socketPort: parsed ? parsed.port || '—' : '—',
		clientVersion: CLIENT_VERSION,
		timestamp: new Date().toISOString(),
	};
}

// Real-time updates using runes
let updateInterval: ReturnType<typeof setInterval>;

// Initialize data and set up reactive updates
$effect(() => {
	// Initial updates
	updateSystemInfo();
	updateWindowInfo();
	updatePerformanceData();
	updateBuildInfo();
	const unsubscribeLocale = updateLocaleInfo();

	// Set up event listeners for dynamic updates
	const handleResize = () => updateWindowInfo();
	const handleOnlineStatus = () => updateSystemInfo();

	window.addEventListener('resize', handleResize);
	window.addEventListener('online', handleOnlineStatus);
	window.addEventListener('offline', handleOnlineStatus);

	const handleVisibilityChange = () => {
		if (!document.hidden) {
			updatePerformanceData();
			updateWindowInfo();
		}
	};
	document.addEventListener('visibilitychange', handleVisibilityChange);

	// Update performance data every 5 seconds
	updateInterval = setInterval(() => {
		if (!document.hidden) {
			updatePerformanceData();
		}
	}, 5000);

	// Cleanup function
	return () => {
		window.removeEventListener('resize', handleResize);
		window.removeEventListener('online', handleOnlineStatus);
		window.removeEventListener('offline', handleOnlineStatus);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		if (updateInterval) {
			clearInterval(updateInterval);
		}
		// Clean up locale subscription
		if (unsubscribeLocale) {
			unsubscribeLocale();
		}
	};
});

// Format milliseconds
function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// Handle language switching from Dev Tools
async function handleLanguageClick(languageCode: Locales) {
	try {
		await loadLocaleAsync(languageCode);
		setLocale(languageCode);
		setLocaleStore(existingLocales.find((l) => l.code === languageCode)!);
	} catch (error) {
		console.error('Failed to load locale:', error);
	}
}
</script>

<!-- Environment Information Card -->
<Card.Root>
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<Code class="h-5 w-5" />
			{$LL.devtools.systemInfo()}
		</Card.Title>
		<Card.Description>
			{$LL.devtools.systemInfoDescription()}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-6">
		<!-- Build Information -->
		<SystemBuildPanel {buildInfo} />

		<!-- Browser Information -->
		<SystemBrowserPanel {systemInfo} {windowInfo} />

		<!-- Locale & Language Information -->
		<SystemLocalePanel {localeInfo} onLanguageClick={handleLanguageClick} />

		<!-- Performance Metrics -->
		<SystemPerformancePanel {performanceData} {windowInfo} {formatMs} />

		<!-- User Preferences -->
		<SystemPreferencesPanel {windowInfo} />

		<!-- Network Information -->
		<SystemNetworkPanel connection={systemInfo.connection} />

		<!-- Performance Timing Details -->
		<SystemTimingPanel {performanceData} {formatMs} />

		<!-- Live Timestamp -->
		<div class="text-muted-foreground bg-muted/30 rounded-md p-2 text-xs" role="status">
			<span class="font-medium">{$LL.devtools.lastUpdated()}:</span>
			{new Date().toLocaleString()}
			<span class="ml-2">• {$LL.devtools.autoRefresh()}</span>
		</div>
	</Card.Content>
</Card.Root>
