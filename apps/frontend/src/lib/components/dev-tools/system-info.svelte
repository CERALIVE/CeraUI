<style>
/* Real-time data highlighting */
:global(.live-data) {
	animation: live-pulse 2s ease-in-out infinite;
}

@keyframes live-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.8;
	}
}
</style>

<script lang="ts">
import { Activity, Clock, Code, Globe, Monitor, Wifi } from '@lucide/svelte';

import * as Card from '$lib/components/ui/card';
import { BUILD_INFO, ENV_VARIABLES } from '$lib/env';
import { localeStore } from '$lib/stores/locale';
import { CLIENT_VERSION } from '$lib/stores/version-manager';

import { LL, locale, setLocale } from '@ceraui/i18n/svelte';
import { existingLocales, loadLocaleAsync, type Locales } from '@ceraui/i18n';

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
	if (performance.memory) {
		const memoryData = performance.memory as PerformanceMemory;
		const usedHeapSize = memoryData.usedJSHeapSize || 0;
		performanceData.memory = Math.round(usedHeapSize / 1024 / 1024);
	}

	// Navigation timing (only calculate load time once)
	if (!performanceData.loadTimeCalculated && performance.getEntriesByType) {
		const navTiming = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
		if (navTiming && navTiming.loadEventEnd && navTiming.navigationStart) {
			performanceData.timing = navTiming;
			const loadTime = navTiming.loadEventEnd - navTiming.navigationStart;
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
	buildInfo = {
		mode: BUILD_INFO.MODE,
		nodeEnv: BUILD_INFO.NODE_ENV,
		dev: BUILD_INFO.IS_DEV,
		socketEndpoint: ENV_VARIABLES.SOCKET_ENDPOINT,
		socketPort: ENV_VARIABLES.SOCKET_PORT,
		clientVersion: CLIENT_VERSION,
		timestamp: new Date().toISOString(),
	};
}

// Real-time updates using runes
let updateInterval: number;

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

	// Update performance data every 5 seconds
	updateInterval = setInterval(() => {
		updatePerformanceData();
	}, 5000);

	// Cleanup function
	return () => {
		window.removeEventListener('resize', handleResize);
		window.removeEventListener('online', handleOnlineStatus);
		window.removeEventListener('offline', handleOnlineStatus);
		if (updateInterval) {
			clearInterval(updateInterval);
		}
		// Clean up locale subscription
		if (unsubscribeLocale) {
			unsubscribeLocale();
		}
	};
});

// Format bytes
function _formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const k = 1024;
	const sizes = ['B', 'KB', 'MB', 'GB'];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// Format milliseconds
function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// Handle language switching from Dev Tools
async function handleLanguageClick(languageCode: Locales) {
	try {
		console.log(`🔧 Dev Tools: Loading locale ${languageCode}`);
		// Load the locale first
		await loadLocaleAsync(languageCode);
		// Then set it as active
		setLocale(languageCode);
		// Update the locale store
		localeStore.set(existingLocales.find((l) => l.code === languageCode)!);
		console.log(`✅ Dev Tools: Successfully switched to ${languageCode}`);
	} catch (error) {
		console.error(`❌ Dev Tools: Failed to load locale ${languageCode}:`, error);
	}
}
</script>

<!-- Environment Information Card -->
<Card.Root
	class="border-dashed border-purple-200 bg-purple-50/50 dark:border-purple-800 dark:bg-purple-950/20"
>
	<Card.Header>
		<Card.Title class="flex items-center gap-2 text-purple-700 dark:text-purple-300">
			<Code class="h-5 w-5" />
			🔍 {$LL.devtools.systemInfo()}
		</Card.Title>
		<Card.Description class="text-purple-600 dark:text-purple-400">
			{$LL.devtools.systemInfoDescription()}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-6">
		<!-- Build Information -->
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Code class="h-4 w-4" />
				{$LL.devtools.buildInformation()}
			</div>
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.mode()}</div>
					<div class="font-mono text-sm font-medium">{buildInfo.mode}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.nodeEnv()}</div>
					<div class="font-mono text-sm font-medium">{buildInfo.nodeEnv}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.devMode()}</div>
					<div
						class="font-mono text-sm font-medium {buildInfo.dev
							? 'text-green-600'
							: 'text-red-600'}"
					>
						{buildInfo.dev ? $LL.devtools.yes() : $LL.devtools.no()}
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.clientVersion()}</div>
					<div class="font-mono text-sm font-medium">{buildInfo.clientVersion}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.socketEndpoint()}</div>
					<div class="truncate font-mono text-xs font-medium">{buildInfo.socketEndpoint}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.socketPort()}</div>
					<div class="font-mono text-sm font-medium">{buildInfo.socketPort}</div>
				</div>
			</div>
		</div>

		<!-- Browser Information -->
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Monitor class="h-4 w-4" />
				{$LL.devtools.browserInformation()}
			</div>
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.browser()}</div>
					<div class="font-mono text-sm font-medium">{systemInfo.browser} {systemInfo.version}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.platform()}</div>
					<div class="font-mono text-sm font-medium">{systemInfo.platform}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.userAgent()}</div>
					<div class="truncate font-mono text-xs" title={navigator.userAgent}>
						{navigator.userAgent.slice(0, 25)}...
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.onlineStatus()}</div>
					<div
						class="font-mono text-sm font-medium {systemInfo.onLine
							? 'text-green-600'
							: 'text-red-600'}"
					>
						{systemInfo.onLine ? $LL.devtools.online() : $LL.devtools.offline()}
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.cookies()}</div>
					<div
						class="font-mono text-sm font-medium {systemInfo.cookieEnabled
							? 'text-green-600'
							: 'text-red-600'}"
					>
						{systemInfo.cookieEnabled ? $LL.devtools.enabled() : $LL.devtools.disabled()}
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.pixelRatio()}</div>
					<div class="font-mono text-sm font-medium">{windowInfo.devicePixelRatio}x</div>
				</div>
			</div>
		</div>

		<!-- Locale & Language Information -->
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Globe class="h-4 w-4" />
				App Locale & Language
			</div>
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.currentLanguage()}</div>
					<div class="flex items-center gap-2 text-sm font-medium">
						<span class="text-lg">{localeInfo.currentLanguageFlag}</span>
						{localeInfo.currentLanguageName}
						<span class="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs"
							>{$LL.devtools.active()}</span
						>
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.localeCode()}</div>
					<div class="font-mono text-sm font-medium text-blue-600">{localeInfo.currentLocale}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.browserLanguage()}</div>
					<div class="font-mono text-sm font-medium text-gray-600">
						{localeInfo.browserLanguage}
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3 md:col-span-3">
					<div class="text-muted-foreground mb-2 text-xs">
						{$LL.devtools.supportedLanguagesClick({
							count: localeInfo.supportedLocales.length,
						})}
					</div>
					<div class="flex flex-wrap gap-1">
						{#each localeInfo.supportedLocales as supportedLocale}
							<button
								class="bg-background flex cursor-pointer items-center gap-1 rounded border px-2 py-1 text-xs transition-all duration-200 hover:scale-105 hover:shadow-md {supportedLocale.code ===
								localeInfo.currentLocale
									? 'bg-primary/10 border-primary/30 text-primary ring-primary/20 ring-1'
									: 'hover:bg-primary/5 hover:border-primary/20'}"
								onclick={() => handleLanguageClick(supportedLocale.code)}
								title="Switch to {supportedLocale.name}"
								type="button"
							>
								<span class="text-base">{supportedLocale.flag || '🌐'}</span>
								<span class="font-medium">{supportedLocale.code.toUpperCase()}</span>
							</button>
						{/each}
					</div>
				</div>
			</div>
		</div>

		<!-- Performance Metrics -->
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Activity class="h-4 w-4" />
				{$LL.devtools.livePerformanceMetrics()}
			</div>
			<div class="grid grid-cols-2 gap-3 md:grid-cols-4">
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.pageLoad()}</div>
					<div
						class="text-lg font-bold {performanceData.loadTime < 1000
							? 'text-green-600'
							: performanceData.loadTime < 3000
								? 'text-amber-600'
								: 'text-red-600'}"
					>
						{formatMs(performanceData.loadTime)}
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.jsMemory()}</div>
					<div
						class="text-lg font-bold {performanceData.memory < 50
							? 'text-green-600'
							: performanceData.memory < 100
								? 'text-amber-600'
								: 'text-red-600'}"
					>
						{performanceData.memory}MB
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.viewport()}</div>
					<div class="text-lg font-bold text-blue-600">
						{windowInfo.width}×{windowInfo.height}
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.screen()}</div>
					<div class="text-lg font-bold text-purple-600">
						{windowInfo.screenWidth}×{windowInfo.screenHeight}
					</div>
				</div>
			</div>
		</div>

		<!-- User Preferences -->
		<div class="space-y-3">
			<div class="flex items-center gap-2 text-sm font-medium">
				<Wifi class="h-4 w-4" />
				{$LL.devtools.userPreferencesAccessibility()}
			</div>
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.colorScheme()}</div>
					<div class="font-mono text-sm font-medium">{windowInfo.colorScheme}</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.reducedMotion()}</div>
					<div
						class="font-mono text-sm font-medium {windowInfo.reducedMotion
							? 'text-amber-600'
							: 'text-green-600'}"
					>
						{windowInfo.reducedMotion ? $LL.devtools.enabled() : $LL.devtools.disabled()}
					</div>
				</div>
				<div class="bg-background/50 rounded-lg border p-3">
					<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.browserLanguages()}</div>
					<div
						class="truncate font-mono text-xs font-medium"
						title={navigator.languages ? navigator.languages.join(', ') : navigator.language}
					>
						{navigator.languages ? navigator.languages.slice(0, 2).join(', ') : navigator.language}
						{navigator.languages && navigator.languages.length > 2
							? `... (+${navigator.languages.length - 2})`
							: ''}
					</div>
				</div>
			</div>
		</div>

		<!-- Network Information -->
		{#if systemInfo.connection}
			<div class="space-y-3">
				<div class="flex items-center gap-2 text-sm font-medium">
					<Wifi class="h-4 w-4" />
					Network Connection
				</div>
				<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
					<div class="bg-background/50 rounded-lg border p-3">
						<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.type()}</div>
						<div class="font-mono text-sm font-medium">
							{systemInfo.connection.effectiveType || $LL.devtools.unknown()}
						</div>
					</div>
					<div class="bg-background/50 rounded-lg border p-3">
						<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.downlink()}</div>
						<div class="font-mono text-sm font-medium">
							{systemInfo.connection.downlink || $LL.devtools.unknown()}
							{$LL.devtools.mbps()}
						</div>
					</div>
					<div class="bg-background/50 rounded-lg border p-3">
						<div class="text-muted-foreground mb-1 text-xs">{$LL.devtools.rtt()}</div>
						<div class="font-mono text-sm font-medium">
							{systemInfo.connection.rtt || $LL.devtools.unknown()}{$LL.devtools.ms()}
						</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Performance Timing Details -->
		{#if performanceData.timing}
			<div class="space-y-3">
				<div class="flex items-center gap-2 text-sm font-medium">
					<Clock class="h-4 w-4" />
					Detailed Timing (Navigation API)
				</div>
				<div class="grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.dnsLookup()}</div>
						<div class="font-mono">
							{Math.round(
								performanceData.timing.domainLookupEnd - performanceData.timing.domainLookupStart,
							)}ms
						</div>
					</div>
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.connect()}</div>
						<div class="font-mono">
							{Math.round(
								performanceData.timing.connectEnd - performanceData.timing.connectStart,
							)}ms
						</div>
					</div>
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.request()}</div>
						<div class="font-mono">
							{Math.round(
								performanceData.timing.responseStart - performanceData.timing.requestStart,
							)}ms
						</div>
					</div>
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.response()}</div>
						<div class="font-mono">
							{Math.round(
								performanceData.timing.responseEnd - performanceData.timing.responseStart,
							)}ms
						</div>
					</div>
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.domContent()}</div>
						<div class="font-mono">
							{Math.round(
								performanceData.timing.domContentLoadedEventEnd -
									performanceData.timing.domContentLoadedEventStart,
							)}ms
						</div>
					</div>
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.domComplete()}</div>
						<div class="font-mono">
							{Math.round(
								performanceData.timing.domComplete -
									performanceData.timing.domContentLoadedEventEnd,
							)}ms
						</div>
					</div>
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.loadEvent()}</div>
						<div class="font-mono">
							{Math.round(
								performanceData.timing.loadEventEnd - performanceData.timing.loadEventStart,
							)}ms
						</div>
					</div>
					<div class="bg-background/50 rounded border p-2">
						<div class="text-muted-foreground mb-1">{$LL.devtools.total()}</div>
						<div class="font-mono font-bold">{formatMs(performanceData.loadTime)}</div>
					</div>
				</div>
			</div>
		{/if}

		<!-- Live Timestamp -->
		<div class="text-muted-foreground bg-muted/30 rounded-md p-2 text-xs">
			<span class="font-medium">{$LL.devtools.lastUpdated()}:</span>
			{new Date().toLocaleString()}
			<span class="ml-2">• {$LL.devtools.autoRefresh()}</span>
		</div>
	</Card.Content>
</Card.Root>
