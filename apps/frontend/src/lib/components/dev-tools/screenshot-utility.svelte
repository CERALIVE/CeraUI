<script lang="ts">
import { LL } from '@ceraui/i18n/svelte';
import { Camera, Download } from '@lucide/svelte';
import { toPng } from 'html-to-image';
import { setMode } from 'mode-watcher';
import { tick } from 'svelte';
import { toast } from 'svelte-sonner';

import * as Button from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { navElements } from '$lib/config';
import { enhancedNavigationStore } from '$lib/stores/navigation.svelte';
import { setIsOnline } from '$lib/stores/pwa.svelte';
import {
	addScreenshot,
	clearScreenshots,
	downloadScreenshotsZip,
	getCaptureProgress,
	getIsCapturing,
	getScreenshotImages,
	type ScreenshotImage,
	setCaptureProgress,
	setIsCapturing,
} from '$lib/stores/screenshot.svelte';

// Reactive state derived from store
const imagesCount = $derived(getScreenshotImages().length);
const currentlyCapturing = $derived(getIsCapturing());
const progressText = $derived(getCaptureProgress());

const tabs = [
	{ key: 'general', name: 'general' },
	{ key: 'network', name: 'network' },
	{ key: 'streaming', name: 'streaming' },
	{ key: 'advanced', name: 'advanced' },
	{ key: 'devtools', name: 'devtools' },
];

// Wait for content to be fully rendered
async function waitForContentReady(): Promise<void> {
	// Wait for animations and transitions to complete
	await new Promise((resolve) => setTimeout(resolve, 100));

	// Wait for any pending DOM updates
	await tick();
	await tick(); // Double tick for complex updates

	// Wait for images to load
	const images = document.querySelectorAll('img');
	const imagePromises = Array.from(images).map((img) => {
		if (img.complete) return Promise.resolve();
		return new Promise((resolve) => {
			img.onload = () => resolve(null);
			img.onerror = () => resolve(null);
			// Timeout after 2 seconds
			setTimeout(() => resolve(null), 2000);
		});
	});
	await Promise.all(imagePromises);

	// Wait for fonts to load
	if (document.fonts) {
		try {
			await document.fonts.ready;
		} catch {
			// Ignore font loading errors
		}
	}

	// Final render wait
	await new Promise((resolve) => setTimeout(resolve, 200));
}

async function navigateToTab(tabKey: string): Promise<void> {
	const navElement = navElements[tabKey];
	if (navElement) {
		enhancedNavigationStore.navigateTo({ [tabKey]: navElement });
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 1000)); // Increased for navigation
		await waitForContentReady();
	}
}

async function switchTheme(theme: 'light' | 'dark'): Promise<void> {
	setMode(theme);
	await tick();
	await new Promise((resolve) => setTimeout(resolve, 600)); // Increased for theme switching
	await waitForContentReady();
}

async function enableMobileView(): Promise<void> {
	const iframe = document.createElement('iframe');
	iframe.id = 'mobile-iframe';
	iframe.style.cssText = `position: fixed; top: 0; left: 0; width: 430px; height: 932px; border: none; z-index: 9999;`;
	document.body.appendChild(iframe);

	await new Promise((resolve) => {
		iframe.onload = resolve;
		iframe.srcdoc = 'about:blank';
	});

	if (iframe.contentDocument) {
		const mainElement = document.querySelector('main');
		if (mainElement) {
			const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
				.map((el) => el.outerHTML)
				.join('\n');
			const htmlClasses = document.documentElement.className || '';
			const bodyClasses = document.body.className || '';

			iframe.srcdoc = `<!DOCTYPE html>
        <html class="${htmlClasses}" style="width: 430px; height: 932px;">
          <head><meta charset="utf-8"><meta name="viewport" content="width=430, height=932">${styles}</head>
          <body class="${bodyClasses}" style="width: 430px; min-height: 932px; margin: 0;">${mainElement.outerHTML}</body>
        </html>`;

			// Wait for iframe content to load and render
			await new Promise((resolve) => setTimeout(resolve, 2000)); // Increased wait time

			// Wait for iframe content to be ready
			if (iframe.contentDocument) {
				// Wait for iframe fonts and images
				const iframeImages = iframe.contentDocument.querySelectorAll('img');
				const iframeImagePromises = Array.from(iframeImages).map((img) => {
					if (img.complete) return Promise.resolve();
					return new Promise((resolve) => {
						img.onload = () => resolve(null);
						img.onerror = () => resolve(null);
						setTimeout(() => resolve(null), 1500);
					});
				});
				await Promise.all(iframeImagePromises);

				// Wait for iframe fonts
				if (iframe.contentDocument.fonts) {
					try {
						await iframe.contentDocument.fonts.ready;
					} catch {
						// Ignore errors
					}
				}
			}

			// Final wait for mobile rendering
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
	}
}

function disableMobileView(): void {
	const iframe = document.getElementById('mobile-iframe');
	if (iframe) iframe.remove();
}

// Theme-aware screenshot capture
async function captureScreenshotWithTheme(
	filename: string,
	theme: 'dark' | 'light',
	useIframe = false,
): Promise<Blob> {
	let element = document.body;

	if (useIframe) {
		const iframe = document.getElementById('mobile-iframe') as HTMLIFrameElement;
		if (iframe?.contentDocument) {
			element = iframe.contentDocument.body;
		}
	}

	// Theme-aware background color
	const backgroundColor = theme === 'dark' ? '#0a0a0a' : '#ffffff';

	// Enhanced quality settings
	const options = {
		quality: 1.0,
		pixelRatio: 2, // Higher pixel ratio for better quality (retina)
		backgroundColor, // Theme-appropriate background
		skipFonts: false, // Include custom fonts
		allowTaint: true, // Allow cross-origin images
		useCORS: true, // Better cross-origin handling
		imagePlaceholder: '', // Handle missing images gracefully
		...(useIframe
			? {
					// Mobile-specific settings
					width: 430,
					height: 932,
				}
			: {
					// Desktop-specific settings - capture viewport only
					width: window.innerWidth,
					height: window.innerHeight,
				}),
	};

	// Final pre-capture wait to ensure everything is settled
	await new Promise((resolve) => setTimeout(resolve, 300));

	const dataUrl = await toPng(element, options);
	const response = await fetch(dataUrl);
	const blob = await response.blob();
	return blob;
}

// Reusable capture function to eliminate redundancy
async function captureTabScreenshots(
	tabs: Array<{ key: string; name: string }>,
	themes: Array<'dark' | 'light'>,
	type: 'desktop' | 'mobile',
	useMobile = false,
): Promise<void> {
	for (const theme of themes) {
		await switchTheme(theme);

		for (const tab of tabs) {
			setCaptureProgress(`${type} ${theme} ${tab.name}`);
			await navigateToTab(tab.key);

			if (useMobile) {
				disableMobileView();
				await enableMobileView();
			}

			// Additional wait for content stability - especially important for complex tabs
			if (tab.key === 'streaming' || tab.key === 'advanced' || tab.key === 'devtools') {
				await new Promise((resolve) => setTimeout(resolve, 800)); // Extra time for complex tabs
			} else {
				await new Promise((resolve) => setTimeout(resolve, 400)); // Standard wait
			}

			// Final content readiness check
			await waitForContentReady();

			const blob = await captureScreenshotWithTheme(`${tab.name}.png`, theme, useMobile);
			const image: ScreenshotImage = {
				filename: `${tab.name}.png`,
				blob,
				theme,
				type,
			};

			addScreenshot(image);
			toast.success(`Captured ${tab.name} (${theme})`, { duration: 300 });
		}
	}
}

// Main capture function - SIMPLIFIED & CLEAN
async function captureAll(): Promise<void> {
	if (currentlyCapturing) return;

	try {
		setIsCapturing(true);
		clearScreenshots();

		const themes: Array<'dark' | 'light'> = ['dark', 'light'];

		// Desktop captures (10 images)
		setCaptureProgress('Desktop screenshots...');
		await captureTabScreenshots(tabs, themes, 'desktop', false);

		// Mobile captures (10 images)
		setCaptureProgress('Mobile screenshots...');
		await captureTabScreenshots(tabs, themes, 'mobile', true);
		disableMobileView();

		// Offline captures (2 images)
		setCaptureProgress('Offline screenshots...');
		setIsOnline(false);
		await navigateToTab('general');

		// Extra wait for offline state to fully apply
		await new Promise((resolve) => setTimeout(resolve, 1000));

		for (const theme of themes) {
			await switchTheme(theme);

			// Extended wait for offline rendering - this is complex state
			await new Promise((resolve) => setTimeout(resolve, 2000));
			await waitForContentReady();

			const blob = await captureScreenshotWithTheme(`offline-${theme}.png`, theme);

			const image: ScreenshotImage = {
				filename: `offline-${theme}.png`,
				blob,
				theme,
				type: 'offline',
			};

			addScreenshot(image);
		}

		setIsOnline(true);
		toast.success(`All done! ${imagesCount} screenshots captured`);

		// Auto-trigger download
		setCaptureProgress('Downloading ZIP...');
		await downloadScreenshotsZip();
	} catch (error) {
		console.error('Capture failed:', error);
		toast.error('Capture failed');
	} finally {
		setIsCapturing(false);
		setCaptureProgress('');
		disableMobileView();
		setIsOnline(true);

		// Final cleanup wait to ensure everything is reset
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
}

// Download function - now just calls the global store function
async function downloadZip(): Promise<void> {
	await downloadScreenshotsZip();
}

function clearImages(): void {
	if (imagesCount === 0) return;
	clearScreenshots();
	toast.info('Cleared');
}
</script>

<Card.Root class="overflow-hidden">
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<Camera class="h-5 w-5 text-primary" />
			{$LL.devtools.screenshotUtility()}
		</Card.Title>
		<Card.Description>
			{$LL.devtools.screenshotUtilityDescription()}
		</Card.Description>
	</Card.Header>

	<Card.Content class="space-y-4 pb-6">
		{#if currentlyCapturing}
			<div class="rounded-lg border border-primary/30 bg-primary/10 p-3" aria-live="polite" role="status">
				<div class="text-sm font-medium text-primary">
					{progressText}
				</div>
				<div class="text-muted-foreground mt-1 text-xs">
					Images: {imagesCount}
				</div>
			</div>
		{/if}

		<div class="space-y-3">
			<Button.Root
				class="w-full"
				disabled={currentlyCapturing}
				onclick={captureAll}
				aria-label={currentlyCapturing
					? 'Capturing screenshots...'
					: 'Capture all screenshots in dark and light themes'}
			>
				<Camera class="mr-2 h-4 w-4" />
				{currentlyCapturing ? $LL.devtools.capturing() : $LL.devtools.captureAllScreenshots()}
			</Button.Root>

			<div class="text-muted-foreground text-center text-xs">
				{$LL.devtools.screenshotCount()}
				<br />
				<span class="text-muted-foreground">{$LL.devtools.enhancedTiming()}</span>
			</div>
		</div>

		<div class="flex gap-2 border-t pt-3">
			<Button.Root
				class="flex-1"
				disabled={imagesCount === 0}
				onclick={downloadZip}
				aria-label={`Download ${imagesCount} screenshots as ZIP`}
			>
				<Download class="mr-2 h-4 w-4" />
				{$LL.devtools.downloadZip({ count: imagesCount })}
			</Button.Root>

			<Button.Root
				disabled={imagesCount === 0}
				onclick={clearImages}
				size="sm"
				variant="outline"
				aria-label="Clear all captured screenshots"
			>
				{$LL.devtools.clear()}
			</Button.Root>
		</div>
	</Card.Content>
</Card.Root>
