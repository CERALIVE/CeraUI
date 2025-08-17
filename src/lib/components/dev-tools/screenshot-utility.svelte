<style>
/* Enhanced mobile screenshot simulation styles using CSS containment */
:global(.mobile-screenshot-mode) {
  /* Force mobile viewport */
  width: 375px !important;
  max-width: 375px !important;
  container-type: inline-size !important;
  overflow-x: hidden !important;
}

:global(.mobile-screenshot-mode *) {
  /* Ensure all elements respect the container */
  max-width: 100% !important;
  box-sizing: border-box !important;
}

:global(.mobile-screenshot-mode main) {
  /* Main content area adjustments */
  width: 100% !important;
  max-width: 375px !important;
  padding: 0.75rem !important;
  margin: 0 auto !important;
}

:global(.mobile-screenshot-mode .container) {
  /* Container adjustments */
  width: 100% !important;
  max-width: 375px !important;
  padding: 0.5rem !important;
}

/* Mobile-specific layout adjustments */
:global(.mobile-screenshot-mode .grid) {
  /* Convert grids to single column on mobile */
  grid-template-columns: 1fr !important;
  gap: 0.5rem !important;
}

:global(.mobile-screenshot-mode .grid-cols-2),
:global(.mobile-screenshot-mode .grid-cols-3),
:global(.mobile-screenshot-mode .grid-cols-4) {
  grid-template-columns: 1fr !important;
}

:global(.mobile-screenshot-mode .flex) {
  /* Ensure flex items wrap and stack */
  flex-direction: column !important;
  align-items: stretch !important;
  gap: 0.5rem !important;
}

/* Card and component adjustments */
:global(.mobile-screenshot-mode .card),
:global(.mobile-screenshot-mode [role='card']) {
  width: 100% !important;
  margin: 0.25rem 0 !important;
}

/* Button and interactive element adjustments */
:global(.mobile-screenshot-mode button) {
  min-height: 44px !important; /* Touch target size */
  width: 100% !important;
}

:global(.mobile-screenshot-mode .button-group) {
  flex-direction: column !important;
  gap: 0.5rem !important;
}

/* Navigation adjustments */
:global(.mobile-screenshot-mode nav) {
  flex-direction: column !important;
}

/* Hide elements that don't work well on mobile */
:global(.mobile-screenshot-mode .desktop-only) {
  display: none !important;
}

/* Font size adjustments for mobile readability */
:global(.mobile-screenshot-mode) {
  font-size: 14px !important;
  line-height: 1.4 !important;
}

:global(.mobile-screenshot-mode h1) {
  font-size: 1.5rem !important;
}

:global(.mobile-screenshot-mode h2) {
  font-size: 1.25rem !important;
}

:global(.mobile-screenshot-mode h3) {
  font-size: 1.125rem !important;
}
</style>

<script lang="ts">
import { Archive, Camera, Download, Eye, Image, Monitor, Play, Smartphone, Zap } from '@lucide/svelte';
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { toPng } from 'html-to-image';
import { setMode } from 'mode-watcher';
import { tick } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';
import { _ } from 'svelte-i18n';
import { toast } from 'svelte-sonner';

import * as Button from '$lib/components/ui/button';
import * as Card from '$lib/components/ui/card';
import { navElements } from '$lib/config';
import { enhancedNavigationStore } from '$lib/stores/navigation';
import { isOnline, isScreenshotMode } from '$lib/stores/pwa';
import { themeStore } from '$lib/stores/theme';

// Screenshot configuration
interface ScreenshotConfig {
  quality?: number;
  cacheBust?: boolean;
  backgroundColor?: string;
  pixelRatio?: number;
}

let isCapturing = $state(false);
let captureProgress = $state('');
let capturedImages: { filename: string; blob: Blob; theme: string; type: string }[] = $state([]);
let totalProgress = $state(0);
let maxProgress = $state(100);

// Svelte 5 MediaQuery for mobile detection
const isMobileViewport = new MediaQuery('(max-width: 768px)');

// Get current theme for proper filename (Svelte 5 runes compatible)
const getCurrentTheme = () => {
  // In Svelte 5, access store value directly with $
  const theme = $themeStore;
  return theme === 'system' ? 'dark' : theme; // Default to dark if system
};

// Get current navigation route for filename from navigation store
const getCurrentRoute = () => {
  // Get current navigation from store
  let currentNav = { general: navElements.general };
  const unsubscribe = enhancedNavigationStore.subscribe(nav => {
    if (nav?.current) {
      currentNav = nav.current;
    }
  });
  unsubscribe();

  const currentKey = Object.keys(currentNav)[0];
  return currentKey || 'general';
};

// Navigate programmatically using navigation store AND hash as backup
async function navigateToTab(tabKey: string): Promise<void> {
  try {
    console.log(`🧭 Navigating to ${tabKey} tab using dual approach...`);

    // Get the nav element for this tab
    const navElement = navElements[tabKey];
    if (!navElement) {
      console.error(`❌ No navigation element found for: ${tabKey}`);
      return;
    }

    // DUAL APPROACH: Use both navigation store AND hash for maximum reliability
    console.log(`📍 Step 1: Setting hash to #${navElement.label}`);
    window.location.hash = `#${navElement.label}`;

    console.log(`📍 Step 2: Using navigation store`);
    const navigation = { [tabKey]: navElement };
    enhancedNavigationStore.navigateTo(navigation);

    // Wait longer for navigation to complete and verify it worked
    await tick();
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify navigation worked by checking the hash
    const currentHash = window.location.hash.replace('#', '');
    if (currentHash === navElement.label) {
      console.log(`✅ Navigation to ${tabKey} completed and verified (hash: ${currentHash})`);
    } else {
      console.warn(
        `⚠️ Navigation to ${tabKey} may not have worked (expected: ${navElement.label}, actual: ${currentHash})`,
      );
    }
  } catch (error) {
    console.error(`❌ Navigation to ${tabKey} failed:`, error);
  }
}

// Switch theme programmatically using mode-watcher
async function switchTheme(targetTheme: 'light' | 'dark') {
  try {
    console.log(`🎨 Switching theme to ${targetTheme}...`);

    // Use mode-watcher to actually change the theme
    setMode(targetTheme);
    themeStore.set(targetTheme);

    // Wait for theme to actually apply by checking DOM classes AND computed styles
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 100));

      const isDark = document.documentElement.classList.contains('dark');
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      const themeApplied = (targetTheme === 'dark' && isDark) || (targetTheme === 'light' && !isDark);

      console.log(`🔍 Attempt ${attempts}: isDark=${isDark}, bodyBg=${bodyBg}, themeApplied=${themeApplied}`);

      if (themeApplied) {
        console.log(`✅ Theme ${targetTheme} applied successfully!`);
        break;
      }
      attempts++;
    }

    if (attempts >= maxAttempts) {
      console.warn(`⚠️ Theme switching timeout after ${maxAttempts} attempts`);
    }

    // Force style recalculation
    getComputedStyle(document.documentElement);
    getComputedStyle(document.body);

    // Additional wait for theme transition to complete
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.error('Theme switching failed:', error);
    toast.error('Theme switching failed', {
      description: 'Continuing with current theme',
    });
  }
}

// SIMPLIFIED mobile simulation using direct viewport manipulation (like professional tools)
async function enableMobileView(): Promise<{
  originalWindowDimensions: { width: number; height: number };
  originalViewport: string;
  resizeMethod: 'window' | 'iframe' | 'fallback';
}> {
  try {
    console.log('📱 Starting DIRECT mobile simulation - iPhone 14 Pro Max (430x932)...');

    // iPhone 14 Pro Max specs: 430x932 logical pixels
    const MOBILE_WIDTH = 430;
    const MOBILE_HEIGHT = 932;

    // Store original state
    const originalWindowDimensions = {
      width: window.innerWidth,
      height: window.innerHeight,
    };

    const viewport = document.querySelector('meta[name="viewport"]') as HTMLMetaElement;
    const originalViewport = viewport?.content || '';

    // METHOD 1: Direct window resizing (most reliable - like Playwright)
    console.log('🎯 Attempting direct window resize (like Chrome DevTools)...');

    try {
      // Set mobile viewport first
      if (viewport) {
        viewport.content = `width=${MOBILE_WIDTH}, initial-scale=1.0, user-scalable=no`;
      }

      // Calculate total window size needed (viewport + browser chrome)
      const windowWidth = MOBILE_WIDTH + 100; // Extra space for browser chrome
      const windowHeight = MOBILE_HEIGHT + 150; // Extra space for browser chrome

      console.log(
        `📐 Resizing window from ${window.outerWidth}x${window.outerHeight} to ${windowWidth}x${windowHeight}`,
      );

      // Resize the actual browser window
      window.resizeTo(windowWidth, windowHeight);

      // Wait for resize to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Check if resize worked (within reasonable tolerance)
      const actualWidth = window.innerWidth;
      const actualHeight = window.innerHeight;

      console.log(`📊 Resize result: target=${MOBILE_WIDTH}x${MOBILE_HEIGHT}, actual=${actualWidth}x${actualHeight}`);

      if (Math.abs(actualWidth - MOBILE_WIDTH) < 150) {
        console.log('✅ Window resize successful - using natural mobile viewport');

        // Trigger natural responsive behavior
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('orientationchange'));
        await tick();

        // Wait for all CSS frameworks to update
        await new Promise(resolve => setTimeout(resolve, 2000));

        console.log(`📱 Direct mobile simulation active: ${window.innerWidth}x${window.innerHeight}`);

        return {
          originalWindowDimensions,
          originalViewport,
          resizeMethod: 'window',
        };
      } else {
        console.log('⚠️ Window resize was blocked/limited by browser - trying iframe method');
      }
    } catch (windowError) {
      console.log('⚠️ Window resize failed:', windowError);
    }

    // METHOD 2: Iframe isolation (fallback - works well)
    console.log('🖼️ Using iframe isolation method...');

    // Create iframe with exact mobile dimensions
    const iframe = document.createElement('iframe');
    iframe.id = 'mobile-simulation-iframe';
    iframe.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: ${MOBILE_WIDTH}px !important;
      height: ${MOBILE_HEIGHT}px !important;
      border: none !important;
      z-index: 9999 !important;
      background: white !important;
    `;

    document.body.appendChild(iframe);

    // Wait for iframe to load
    await new Promise(resolve => {
      iframe.onload = () => resolve(undefined);
      iframe.src = 'about:blank';
    });

    if (iframe.contentDocument && iframe.contentWindow) {
      console.log('🔧 Setting up clean iframe content...');
      const iframeDoc = iframe.contentDocument;

      try {
        // Prepare clean CSS (filter out problematic styles)
        const cleanStyles = Array.from(document.head.querySelectorAll('style, link[rel="stylesheet"]'))
          .filter(el => {
            try {
              const href = el.getAttribute('href') || '';
              const id = el.getAttribute('id') || '';
              const content = el.textContent || '';

              // Skip Vite, HMR, and development-specific styles
              if (href.includes('/@vite/') || href.includes('/@id/')) return false;
              if (id.includes('vite') || id.includes('hmr')) return false;
              if (content.includes('svelte-inspector') || content.includes('vite-error-overlay')) return false;

              return true;
            } catch (e) {
              console.warn('Error filtering style element:', e);
              return false; // Skip problematic elements
            }
          })
          .map(el => el.outerHTML)
          .join('\n          ');

        // Prepare clean body content
        let cleanBodyContent = '';
        try {
          const mainElement = document.querySelector('main');
          if (mainElement) {
            // Clone the main element and clean it
            const clone = mainElement.cloneNode(true) as HTMLElement;

            // Remove any problematic elements from the clone
            const problematicSelectors = [
              'script',
              '[id*="inspector"]',
              '[class*="inspector"]',
              '[id*="vite"]',
              '[class*="vite"]',
              '[id*="autofill"]',
              '[class*="autofill"]',
              '[data-vite-dev-id]',
            ];

            problematicSelectors.forEach(selector => {
              try {
                clone.querySelectorAll(selector).forEach(el => el.remove());
              } catch (e) {
                console.warn(`Error removing ${selector}:`, e);
              }
            });

            cleanBodyContent = clone.outerHTML;
          } else {
            console.warn('Main element not found, using simplified fallback');
            cleanBodyContent = '<div>Content not available</div>';
          }
        } catch (e) {
          console.error('Error preparing body content:', e);
          cleanBodyContent = '<div>Error loading content</div>';
        }

        // Copy theme state from parent document
        const parentHtmlClasses = document.documentElement.className || '';
        const parentBodyClasses = document.body.className || '';

        console.log('🎨 Copying theme state to iframe:', {
          htmlClasses: parentHtmlClasses,
          bodyClasses: parentBodyClasses,
        });

        // Create clean HTML structure with theme inheritance
        const cleanHTML = `<!DOCTYPE html>
<html lang="en" class="${parentHtmlClasses}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${MOBILE_WIDTH}, initial-scale=1.0, user-scalable=no">
  <title>Mobile Simulation</title>
  ${cleanStyles}
</head>
<body class="${parentBodyClasses}">
  ${cleanBodyContent}
</body>
</html>`;

        // Write clean content to iframe
        iframeDoc.open();
        iframeDoc.write(cleanHTML);
        iframeDoc.close();

        // Wait for iframe content to fully load and render completely
        console.log('⏳ Waiting for iframe content to load and render...');

        await new Promise(resolve => {
          let resolved = false;

          const finishLoading = () => {
            if (!resolved) {
              resolved = true;
              console.log('📱 Iframe content fully loaded and rendered');
              resolve(undefined);
            }
          };

          // Enhanced loading detection with content verification
          if (iframe.contentWindow && iframe.contentDocument) {
            const checkContentReady = () => {
              try {
                const doc = iframe.contentDocument;
                const main = doc?.querySelector('main');
                const body = doc?.body;

                // Check if content is actually rendered (not just loaded)
                const hasContent = main && main.children.length > 0;
                const hasStyles = doc && getComputedStyle(doc.body).backgroundColor !== 'rgba(0, 0, 0, 0)';

                console.log('🔍 Iframe content check:', {
                  readyState: doc?.readyState,
                  hasMain: !!main,
                  mainChildren: main?.children.length || 0,
                  hasStyles,
                  bodyBgColor: doc ? getComputedStyle(doc.body).backgroundColor : 'unknown',
                });

                if (doc?.readyState === 'complete' && hasContent) {
                  console.log('✅ Iframe content is ready and rendered');
                  setTimeout(finishLoading, 1500); // Extra time for full rendering
                } else {
                  setTimeout(checkContentReady, 200);
                }
              } catch (e) {
                console.warn('Error checking iframe content:', e);
                setTimeout(checkContentReady, 200);
              }
            };

            // Start checking after a brief delay
            setTimeout(checkContentReady, 300);
          }

          // Fallback timeout (increased for better rendering)
          setTimeout(() => {
            console.log('⏰ Iframe loading timeout - proceeding with capture');
            finishLoading();
          }, 8000);
        });

        // Verify iframe content is properly themed and ready
        if (iframe.contentDocument) {
          const iframeHtml = iframe.contentDocument.documentElement;
          const iframeBody = iframe.contentDocument.body;
          console.log('🔍 Iframe verification:', {
            htmlClasses: iframeHtml.className,
            bodyClasses: iframeBody.className,
            mainElement: !!iframe.contentDocument.querySelector('main'),
            viewportWidth: iframe.contentWindow?.innerWidth || 'unknown',
          });
        }

        console.log('✅ Clean iframe mobile simulation ready (theme inherited, no script conflicts)');

        return {
          originalWindowDimensions,
          originalViewport,
          resizeMethod: 'iframe',
        };
      } catch (iframeError) {
        console.error('❌ Iframe setup failed:', iframeError);
        // Clean up the iframe if it was created
        if (iframe && iframe.parentNode) {
          iframe.remove();
        }
      }
    } else {
      console.log('❌ Iframe method failed - iframe document not accessible');
    }

    // METHOD 3: CSS fallback (last resort)
    console.log('💾 Using CSS fallback method...');

    if (viewport) {
      viewport.content = `width=${MOBILE_WIDTH}, initial-scale=1.0, user-scalable=no`;
    }

    const mobileCSS = document.createElement('style');
    mobileCSS.id = 'simple-mobile-simulation';
    mobileCSS.innerHTML = `
      /* Simple, effective mobile simulation */
      html, body {
        width: ${MOBILE_WIDTH}px !important;
        max-width: ${MOBILE_WIDTH}px !important;
        overflow-x: hidden !important;
        margin: 0 auto !important;
      }
      
      .container, [class*="container"], main {
        max-width: ${MOBILE_WIDTH}px !important;
        padding-left: 1rem !important;
        padding-right: 1rem !important;
      }
      
      /* Force mobile responsive classes */
      .sm\\:block { display: block !important; }
      .md\\:block, .lg\\:block { display: none !important; }
      .md\\:grid-cols-2, .lg\\:grid-cols-2 { 
        grid-template-columns: repeat(1, minmax(0, 1fr)) !important; 
      }
    `;

    document.head.appendChild(mobileCSS);

    // Trigger responsive updates
    window.dispatchEvent(new Event('resize'));
    await tick();
    await new Promise(resolve => setTimeout(resolve, 1500));

    return {
      originalWindowDimensions,
      originalViewport,
      resizeMethod: 'fallback',
    };
  } catch (error) {
    console.error('❌ Advanced mobile simulation failed:', error);
    return {
      originalWindowDimensions: { width: window.innerWidth, height: window.innerHeight },
      originalViewport: '',
      resizeMethod: 'fallback',
    };
  }
}

async function disableMobileView(restoreData: {
  originalWindowDimensions: { width: number; height: number };
  originalViewport: string;
  resizeMethod: 'window' | 'iframe' | 'fallback';
}) {
  try {
    console.log('💻 Disabling mobile simulation...');
    const { originalWindowDimensions, originalViewport, resizeMethod } = restoreData;

    // RESTORE BASED ON METHOD USED
    if (resizeMethod === 'window') {
      console.log('🔄 Restoring browser window size...');

      // Restore original window size
      window.resizeTo(originalWindowDimensions.width + 50, originalWindowDimensions.height + 100);

      // Wait for resize to take effect
      await new Promise(resolve => setTimeout(resolve, 500));

      // Trigger responsive components to react to restored size
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('orientationchange'));
      await tick();

      console.log(`✅ Window restored to: ${window.innerWidth}x${window.innerHeight}`);
    } else if (resizeMethod === 'iframe') {
      console.log('🖼️ Removing iframe mobile simulation...');

      // Remove the iframe
      const iframe = document.getElementById('mobile-simulation-iframe');
      if (iframe) {
        iframe.remove();
        console.log('✅ Iframe removed successfully');
      }
    } else if (resizeMethod === 'fallback') {
      console.log('🎯 Removing CSS viewport simulation...');

      // Remove all injected CSS elements
      const mobileCSS = document.getElementById('simple-mobile-simulation');
      if (mobileCSS) {
        mobileCSS.remove();
      }

      const mediaQueryCSS = document.getElementById('force-mobile-media-queries');
      if (mediaQueryCSS) {
        mediaQueryCSS.remove();
      }

      console.log('✅ All CSS viewport simulations removed');
    }

    // RESTORE VIEWPORT META TAG
    const viewport = document.querySelector('meta[name="viewport"]') as HTMLMetaElement;
    if (viewport && originalViewport) {
      viewport.content = originalViewport;
      console.log('✅ Restored original viewport meta tag');
    }

    // FORCE LAYOUT RECALCULATION
    await tick();
    window.dispatchEvent(new Event('resize'));

    // Wait for DOM to settle
    await new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            console.log(`📐 Final restored dimensions: ${window.innerWidth}x${window.innerHeight}`);
            resolve(undefined);
          });
        });
      });
    });

    console.log('✅ REAL mobile simulation disabled - desktop restored!');
  } catch (error) {
    console.error('❌ Mobile simulation disable failed:', error);
  }
}

// Helper function to find button by text content
function findButtonByText(searchTexts: string[]): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll('button'));

  for (const button of buttons) {
    const text = button.textContent?.trim().toLowerCase() || '';
    const ariaLabel = button.getAttribute('aria-label')?.toLowerCase() || '';

    for (const searchText of searchTexts) {
      if (text.includes(searchText.toLowerCase()) || ariaLabel.includes(searchText.toLowerCase())) {
        return button;
      }
    }
  }

  return null;
}

// Trigger and capture modals (fixed CSS selectors)
async function captureModal(modalType: string): Promise<{ filename: string; blob: Blob } | null> {
  try {
    let modalElement: Element | null = null;

    switch (modalType) {
      case 'wifi-networks':
        // Navigate to network tab first
        await navigateToTab('network');

        // Find WiFi networks button using proper text search
        const wifiButton =
          findButtonByText([
            'view available networks',
            'available networks',
            'networks',
            'wifi networks',
            'scan networks',
          ]) || document.querySelector('[data-testid="view-networks-button"]');

        if (wifiButton) {
          wifiButton.click();
          await new Promise(resolve => setTimeout(resolve, 1500));
          modalElement =
            document.querySelector('[role="dialog"]') ||
            document.querySelector('.modal') ||
            document.querySelector('[data-state="open"]') ||
            document.querySelector('dialog[open]');
        }
        break;

      case 'hotspot-config':
        // Navigate to network tab
        await navigateToTab('network');

        // Find hotspot configuration button
        const hotspotButton =
          findButtonByText([
            'configure hotspot',
            'hotspot settings',
            'hotspot config',
            'create hotspot',
            'setup hotspot',
          ]) || document.querySelector('[data-testid="hotspot-config-button"]');

        if (hotspotButton) {
          hotspotButton.click();
          await new Promise(resolve => setTimeout(resolve, 1500));
          modalElement =
            document.querySelector('[role="dialog"]') ||
            document.querySelector('.modal') ||
            document.querySelector('[data-state="open"]') ||
            document.querySelector('dialog[open]');
        }
        break;

      case 'language-selector':
        // Find language selector button/dropdown
        const langButton =
          findButtonByText(['english', 'language', 'select language', 'choose language']) ||
          document.querySelector('[data-testid="language-selector"]') ||
          document.querySelector('button[aria-haspopup="listbox"]');

        if (langButton) {
          langButton.click();
          await new Promise(resolve => setTimeout(resolve, 500));
          modalElement =
            document.querySelector('[role="listbox"]') ||
            document.querySelector('[role="menu"]') ||
            document.querySelector('.dropdown-content') ||
            document.querySelector('[data-state="open"]') ||
            document.querySelector('ul[role="menu"]');
        }
        break;
    }

    if (modalElement) {
      const dataUrl = await toPng(modalElement as HTMLElement, {
        quality: 1.0,
        cacheBust: true,
        backgroundColor: 'transparent',
      });

      // Convert to blob
      const response = await fetch(dataUrl);
      const blob = await response.blob();

      return {
        filename: `${modalType}.png`,
        blob,
      };
    }

    return null;
  } catch (error) {
    console.error(`Failed to capture ${modalType} modal:`, error);
    return null;
  }
}

// Get current theme background color
function getCurrentBackgroundColor(): string {
  const isDark = document.documentElement.classList.contains('dark');
  const bodyStyle = getComputedStyle(document.body);
  const backgroundColor = bodyStyle.backgroundColor;

  console.log(`🎨 Current theme: ${isDark ? 'dark' : 'light'}, backgroundColor: ${backgroundColor}`);

  // If computed style doesn't give us a proper color, use CSS variable values
  if (backgroundColor === 'rgba(0, 0, 0, 0)' || backgroundColor === 'transparent') {
    if (isDark) {
      return 'hsl(0, 0%, 3.9%)'; // Dark theme background
    } else {
      return 'hsl(0, 0%, 100%)'; // Light theme background
    }
  }

  return backgroundColor;
}

// Enhanced screenshot capture function with proper background handling
async function captureScreenshot(
  element: HTMLElement = document.body,
  filename?: string,
  config: ScreenshotConfig = {},
): Promise<{ dataUrl: string; blob: Blob }> {
  try {
    console.log('📸 Starting screenshot capture...');

    // Get the current background color
    const backgroundColor = getCurrentBackgroundColor();
    console.log(`🎨 Using backgroundColor: ${backgroundColor}`);

    const defaultConfig: ScreenshotConfig = {
      quality: 1.0,
      cacheBust: true,
      backgroundColor: backgroundColor,
      pixelRatio: 2, // Higher quality
      width: element.scrollWidth,
      height: element.scrollHeight,
      filter: (node: Element) => {
        // Filter out autofill overlays and other problematic elements
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as Element;
          // Convert className to string safely (it might be DOMTokenList)
          const className = String(el.className || '');
          const id = String(el.id || '');

          // Skip autofill overlays and browser extension elements
          if (
            className.includes('autofill') ||
            className.includes('extension') ||
            id.includes('autofill') ||
            id.includes('extension')
          ) {
            return false;
          }
        }
        return true;
      },
      ...config,
    };

    // Force style recalculation before capture
    getComputedStyle(element);

    // Wait for any animations/transitions to settle
    await new Promise(resolve => setTimeout(resolve, 200));

    console.log('📸 Capturing with html-to-image...');
    const dataUrl = await toPng(element, defaultConfig);
    console.log('✅ Screenshot captured successfully');

    // Convert to blob for storage
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    console.log(`📊 Screenshot blob size: ${(blob.size / 1024).toFixed(2)} KB`);

    // Note: Individual downloads removed - only ZIP download should trigger saves
    if (filename) {
      console.log(`📸 Screenshot captured for: ${filename} (no individual download)`);
    }

    return { dataUrl, blob };
  } catch (error) {
    console.error('Screenshot capture failed:', error);
    throw error;
  }
}

// Create and download ZIP file with COMPREHENSIVE debugging
async function downloadZipFile() {
  console.log('🚀 ===== STARTING ZIP DOWNLOAD FUNCTION =====');
  console.log('📦 Function called - downloadZipFile()');
  console.log('📊 Current capturedImages:', capturedImages);
  console.log(`📊 Captured images count: ${capturedImages.length}`);

  // Check if @zip.js/zip.js is available
  try {
    console.log('🔍 Checking @zip.js/zip.js availability...');
    console.log('ZipWriter:', typeof ZipWriter);
    console.log('BlobWriter:', typeof BlobWriter);
    console.log('BlobReader:', typeof BlobReader);

    if (typeof ZipWriter === 'undefined') {
      throw new Error('@zip.js/zip.js ZipWriter not available');
    }
    if (typeof BlobWriter === 'undefined') {
      throw new Error('@zip.js/zip.js BlobWriter not available');
    }
    if (typeof BlobReader === 'undefined') {
      throw new Error('@zip.js/zip.js BlobReader not available');
    }
    console.log('✅ All @zip.js/zip.js components available');
  } catch (importError) {
    console.error('❌ @zip.js/zip.js import error:', importError);
    toast.error('ZIP library not available', {
      description: 'Failed to load @zip.js/zip.js library',
    });
    return;
  }

  if (capturedImages.length === 0) {
    console.warn('❌ No screenshots captured');
    toast.error('No screenshots captured', {
      description: 'Capture some screenshots first before downloading',
    });
    return;
  }

  // Log each captured image for debugging
  capturedImages.forEach((img, index) => {
    console.log(`📷 Image ${index + 1}:`, {
      filename: img.filename,
      type: img.type,
      theme: img.theme,
      blobSize: img.blob?.size || 'NO BLOB',
      blobType: img.blob?.type || 'NO TYPE',
    });
  });

  try {
    console.log('🔄 Setting capture progress...');
    captureProgress = 'Creating ZIP file...';

    console.log('📦 Initializing @zip.js/zip.js...');

    // Create a blob writer for the ZIP file
    console.log('📝 Creating BlobWriter...');
    const blobWriter = new BlobWriter('application/zip');
    console.log('✅ BlobWriter created:', blobWriter);

    console.log('📝 Creating ZipWriter...');
    const zipWriter = new ZipWriter(blobWriter);
    console.log('✅ ZipWriter created:', zipWriter);

    console.log('✅ ZIP writer initialized successfully');

    // Add files to ZIP with proper folder structure
    let addedCount = 0;
    console.log('📄 Starting to add files to ZIP...');

    for (const [index, image] of capturedImages.entries()) {
      try {
        console.log(`\n📎 === Processing image ${index + 1}/${capturedImages.length} ===`);
        console.log(`📷 Image details:`, {
          filename: image.filename,
          type: image.type,
          theme: image.theme,
          hasBlobdata: !!image.blob,
          blobSize: image.blob?.size,
        });

        let folderPath = '';

        if (image.type === 'desktop' && image.theme === 'dark') {
          folderPath = 'desktop/dark-theme';
        } else if (image.type === 'desktop' && image.theme === 'light') {
          folderPath = 'desktop/light-theme';
        } else if (image.type === 'mobile' && image.theme === 'dark') {
          folderPath = 'mobile/dark-theme';
        } else if (image.type === 'mobile' && image.theme === 'light') {
          folderPath = 'mobile/light-theme';
        } else if (image.type === 'modal') {
          folderPath = `features/modals/${image.theme}-theme`;
        } else if (image.type === 'ui-state') {
          folderPath = `features/ui-states/${image.theme}-theme`;
        } else if (image.type === 'demo') {
          folderPath = `features/demos/${image.theme}-theme`;
        } else if (image.type === 'pwa-state') {
          folderPath = `features/pwa-states/${image.theme}-theme`;
        }

        console.log(`📁 Determined folder path: "${folderPath}"`);

        if (folderPath && image.blob) {
          const fullPath = `${folderPath}/${image.filename}`;
          console.log(`📁 Full path: "${fullPath}"`);
          console.log(`📊 File size: ${(image.blob.size / 1024).toFixed(2)} KB`);

          // Create blob reader for the image
          console.log('📖 Creating BlobReader...');
          const blobReader = new BlobReader(image.blob);
          console.log('✅ BlobReader created:', blobReader);

          // Add file to ZIP
          console.log(`🔄 Adding file to ZIP: ${fullPath}`);
          await zipWriter.add(fullPath, blobReader);
          addedCount++;
          console.log(`✅ Successfully added ${fullPath} to ZIP`);
        } else {
          console.warn(`⚠️ Skipping ${image.filename}:`);
          console.warn(`   - Folder path: "${folderPath}"`);
          console.warn(`   - Has blob: ${!!image.blob}`);
        }
      } catch (fileError) {
        console.error(`❌ Failed to add ${image.filename} to ZIP:`, fileError);
        console.error('Error details:', {
          name: fileError?.name,
          message: fileError?.message,
          stack: fileError?.stack,
        });
      }
    }

    console.log(`\n📊 === ZIP ADDITION SUMMARY ===`);
    console.log(`📊 Successfully added ${addedCount}/${capturedImages.length} files to ZIP`);

    if (addedCount === 0) {
      throw new Error('No files could be added to ZIP');
    }

    console.log('🔄 Setting finalize progress...');
    captureProgress = 'Finalizing ZIP file...';
    console.log('🔄 Finalizing ZIP...');

    // Close the ZIP writer and get the blob
    console.log('🔄 Calling zipWriter.close()...');
    const zipBlob = await zipWriter.close();
    console.log('✅ ZIP finalized successfully');
    console.log(`📊 ZIP blob created:`, {
      size: zipBlob.size,
      type: zipBlob.type,
      sizeMB: (zipBlob.size / 1024 / 1024).toFixed(2),
    });

    console.log('🔄 Setting download progress...');
    captureProgress = 'Downloading ZIP file...';

    // Create download link with proper error handling
    console.log('🔗 Creating download URL...');
    const url = URL.createObjectURL(zipBlob);
    console.log('✅ Download URL created:', url);

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `ceraui-screenshots-${timestamp}.zip`;
    console.log(`📝 Filename: ${filename}`);

    console.log('🔗 Creating download link element...');
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';

    console.log('📎 Appending link to document body...');
    document.body.appendChild(link);
    console.log('✅ Link appended to body');

    // Force click with a small delay to ensure DOM attachment
    console.log('⏰ Setting download trigger timeout...');
    setTimeout(() => {
      console.log('🖱️ ===== TRIGGERING DOWNLOAD =====');
      try {
        link.click();
        console.log('✅ Download click triggered successfully');

        // Clean up after download
        setTimeout(() => {
          console.log('🧹 Cleaning up...');
          if (link.parentNode) {
            document.body.removeChild(link);
            console.log('✅ Link removed from DOM');
          }
          URL.revokeObjectURL(url);
          console.log('✅ URL revoked');
          console.log('🧹 Cleanup completed');
        }, 1000);
      } catch (clickError) {
        console.error('❌ Download click failed:', clickError);
      }
    }, 100);

    console.log('🎉 ZIP download process initiated successfully!');

    toast.success(`ZIP download started!`, {
      description: `${addedCount} screenshots packaged as ${filename}`,
    });
  } catch (error) {
    console.error('❌ ===== ZIP CREATION FAILED =====');
    console.error('❌ ZIP creation failed:', error);
    console.error('Error type:', typeof error);
    console.error('Error name:', error?.name);
    console.error('Error message:', error?.message);
    console.error('Error stack:', error?.stack);
    console.error('Full error object:', error);

    toast.error('ZIP creation failed', {
      description: error instanceof Error ? error.message : 'Unknown error occurred',
    });
  } finally {
    console.log('🔄 Clearing capture progress...');
    captureProgress = '';
    console.log('🏁 ===== ZIP DOWNLOAD PROCESS FINISHED =====');
  }
}

// Capture current tab
async function captureCurrentTab() {
  if (isCapturing) return;

  try {
    isCapturing = true;
    captureProgress = 'Capturing current tab...';

    const theme = getCurrentTheme();
    const route = getCurrentRoute();
    const filename = `${route}.png`;

    // Target the main content area (exclude dev tools panel if open)
    const mainElement = document.querySelector('main') || document.body;

    const result = await captureScreenshot(mainElement as HTMLElement, filename);

    // Store for ZIP download
    capturedImages.push({
      filename,
      blob: result.blob,
      theme,
      type: 'desktop',
    });

    toast.success(`Screenshot captured: ${filename}`, {
      description: `Current tab (${route}) captured successfully`,
    });

    captureProgress = 'Capture complete!';
  } catch (error) {
    toast.error('Screenshot failed', {
      description: error instanceof Error ? error.message : 'Unknown error',
    });
    captureProgress = 'Capture failed';
  } finally {
    isCapturing = false;
    setTimeout(() => (captureProgress = ''), 3000);
  }
}

// Comprehensive capture function - captures everything!
async function captureEverything() {
  if (isCapturing) return;

  // Store original state BEFORE try block to ensure it's available in finally
  const originalOnlineStatus = $isOnline;

  try {
    isCapturing = true;
    capturedImages.length = 0; // Clear previous captures
    totalProgress = 0;
    // Enable screenshot mode to suppress PWA install prompts
    isScreenshotMode.set(true);

    // Clean up any leftover iframes that might cause navigation issues
    const existingIframes = document.querySelectorAll('iframe[id*="mobile"], iframe[id*="simulation"]');
    existingIframes.forEach(iframe => {
      console.log('🧹 Removing leftover iframe:', iframe.id);
      iframe.remove();
    });

    // Calculate new progress: 5 tabs × 4 captures per tab + 4 modals + 1 offline + 1 overlay demo = 20 + 4 + 1 + 1 = 26
    maxProgress = 26;

    const originalTheme = getCurrentTheme();
    const tabs = [
      { name: 'general', hash: 'general' },
      { name: 'network', hash: 'network' },
      { name: 'streaming', hash: 'settings' },
      { name: 'advanced', hash: 'advanced' },
      { name: 'devtools', hash: 'devtools' },
    ];

    toast.info('Starting comprehensive capture...', {
      description: 'Tab-by-tab capture: desktop dark/light + mobile dark/light per tab',
    });

    // PHASE 1: Tab-by-tab capture (desktop dark, desktop light, mobile dark, mobile light per tab)
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];

      // Navigate to tab once
      captureProgress = `🧭 Navigating to ${tab.name} tab...`;
      await navigateToTab(tab.hash);

      // Capture desktop versions (dark then light)
      for (const theme of ['dark', 'light'] as const) {
        totalProgress++;
        captureProgress = `🖥️ Capturing ${tab.name} desktop (${theme}) [${totalProgress}/${maxProgress}]`;

        await switchTheme(theme);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Theme settling

        const mainElement = document.querySelector('main') || document.body;

        // Desktop capture: constrain to viewport dimensions only (not full document)
        const desktopOptions = {
          width: window.innerWidth,
          height: window.innerHeight, // Viewport height, not document height
          pixelRatio: 1,
          quality: 1.0,
        };

        console.log(`🖥️ Desktop capture options:`, desktopOptions);
        const result = await captureScreenshot(mainElement as HTMLElement, undefined, desktopOptions);

        capturedImages.push({
          filename: `${tab.name}.png`,
          blob: result.blob,
          theme,
          type: 'desktop',
        });

        toast.success(`${tab.name} desktop (${theme}) captured`, { duration: 800 });
      }

      // Capture mobile versions (dark then light)
      for (const theme of ['dark', 'light'] as const) {
        totalProgress++;
        captureProgress = `📱 Capturing ${tab.name} mobile (${theme}) [${totalProgress}/${maxProgress}]`;

        await switchTheme(theme);
        await new Promise(resolve => setTimeout(resolve, 1500));

        // Enable mobile view with ENHANCED error handling and debugging
        console.log(`📱 [${tab.name}-${theme}] Starting mobile view simulation...`);
        const restoreData = await enableMobileView();

        if (!restoreData || !restoreData.resizeMethod) {
          console.error(`❌ [${tab.name}-${theme}] Mobile simulation failed - restoreData is invalid:`, restoreData);
          throw new Error('Mobile simulation failed to return valid data');
        }

        console.log(`📱 [${tab.name}-${theme}] Mobile simulation completed with method: ${restoreData.resizeMethod}`);

        // Extra wait for mobile styles to settle
        await new Promise(resolve => setTimeout(resolve, 2000));

        // DEBUG: Check current layout state
        const bodyElement = document.body;
        const bodyStyles = getComputedStyle(bodyElement);
        const currentViewport = window.innerWidth;
        console.log(`📱 [${tab.name}-${theme}] Mobile state verification:`, {
          windowWidth: window.innerWidth,
          windowHeight: window.innerHeight,
          bodyWidth: bodyStyles.width,
          bodyMaxWidth: bodyStyles.maxWidth,
          resizeMethod: restoreData.resizeMethod,
        });

        // INTELLIGENT mobile capture based on simulation method
        console.log(
          `📱 [${tab.name}-${theme}] Capturing mobile viewport (430x932) using ${restoreData.resizeMethod} method...`,
        );

        let captureElement: HTMLElement;
        let captureOptions: any = {
          width: 430, // iPhone 14 Pro Max width
          height: 932, // iPhone 14 Pro Max height - VIEWPORT, not full height
          pixelRatio: 2,
          quality: 1.0,
        };

        if (restoreData.resizeMethod === 'iframe') {
          // Capture from iframe content
          console.log('🎯 Looking for iframe for capture...');
          const iframe = document.getElementById('mobile-simulation-iframe') as HTMLIFrameElement;

          if (iframe && iframe.contentDocument) {
            const iframeMain = iframe.contentDocument.querySelector('main');
            const iframeBody = iframe.contentDocument.body;
            captureElement = iframeMain || iframeBody;

            console.log('📱 Iframe capture setup:', {
              iframeFound: !!iframe,
              contentDocumentFound: !!iframe.contentDocument,
              mainElementFound: !!iframeMain,
              bodyElementFound: !!iframeBody,
              selectedElement: captureElement.tagName,
              elementClasses: captureElement.className,
              iframeSize: {
                width: iframe.offsetWidth,
                height: iframe.offsetHeight,
              },
            });

            console.log('📱 Capturing from iframe content for authentic mobile layout');
          } else {
            console.log('⚠️ Iframe or iframe content not found:', {
              iframeExists: !!iframe,
              contentDocExists: iframe ? !!iframe.contentDocument : false,
            });
            console.log('⚠️ Falling back to main element');
            captureElement = document.querySelector('main') || document.body;
          }
        } else {
          // Capture from main window (window or fallback methods)
          captureElement = document.querySelector('main') || document.body;
          console.log(`📱 Capturing from main window using ${restoreData.resizeMethod} method`);
        }

        console.log(`📸 Starting capture for ${tab.name}-mobile-${theme}...`);

        let mobileResult: any;
        try {
          mobileResult = await captureScreenshot(
            captureElement as HTMLElement,
            `${tab.name}-mobile-${theme}`,
            captureOptions,
          );

          if (mobileResult && mobileResult.blob) {
            console.log(`✅ [${tab.name}-${theme}] Mobile screenshot captured successfully:`, {
              blobSize: mobileResult.blob.size,
              blobType: mobileResult.blob.type,
              dataUrlLength: mobileResult.dataUrl.length,
            });
          } else {
            console.error(`❌ [${tab.name}-${theme}] Mobile screenshot failed - no result`);
          }
        } catch (captureError) {
          console.error(`❌ [${tab.name}-${theme}] Mobile screenshot failed:`, captureError);
          throw captureError; // Re-throw to maintain error handling
        }

        capturedImages.push({
          filename: `${tab.name}.png`,
          blob: mobileResult.blob,
          theme,
          type: 'mobile',
        });

        await disableMobileView(restoreData);
        await new Promise(resolve => setTimeout(resolve, 1000));

        toast.success(`${tab.name} mobile (${theme}) captured`, { duration: 800 });
      }
    }

    // PHASE 2: Capture actual modals by triggering them properly
    // Navigate to network tab for WiFi and hotspot modals
    captureProgress = `🧭 Navigating to network tab for modal capture...`;
    await navigateToTab('network');

    // Capture WiFi networks modal (dark theme only to avoid duplicates)
    try {
      totalProgress++;
      captureProgress = `📶 Capturing WiFi networks modal [${totalProgress}/${maxProgress}]`;

      await switchTheme('dark');
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Find and click WiFi selector button to open modal
      const wifiButton = findButtonByText([
        'View Available Networks',
        'Available Networks',
        'WiFi Networks',
        'Select Network',
      ]);
      if (wifiButton) {
        console.log('🔍 Found WiFi selector button, clicking...');
        wifiButton.click();

        // Wait for modal to open AND be fully animated/visible
        console.log('⏳ Waiting for WiFi modal to open and animate...');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Initial wait for modal to start opening

        // Enhanced modal dialog detection with visibility verification
        console.log('🔍 Searching for fully visible WiFi modal dialog...');

        const modalSelectors = [
          // AlertDialog specific (bits-ui/shadcn) - targeting the portal content
          '[data-bits-alert-dialog-content]',
          '[data-bits-alert-dialog-content][data-state="open"]',
          // Look for fixed positioned elements with modal styling
          '.fixed.left-1\\/2.top-1\\/2',
          'div[class*="fixed"][class*="z-"]',
          // Standard modal selectors
          '[role="dialog"]',
          '.modal',
          '[data-state="open"]',
          '[data-testid*="modal"]',
          '[data-testid*="dialog"]',
          '.dialog',
          '.popover',
          '[aria-modal="true"]',
          '.sheet',
          '.drawer',
          '.overlay-content',
          // Shadcn-specific selectors
          '[data-radix-collection-item]',
          '[data-radix-popper-content-wrapper]',
          '[cmdk-dialog]',
          '.command',
        ];

        let modalDialog: HTMLElement | null = null;

        // Poll for modal to be visible and fully rendered (up to 10 seconds)
        const maxWaitTime = 10000; // 10 seconds max
        const pollInterval = 200; // Check every 200ms
        let elapsed = 0;

        while (!modalDialog && elapsed < maxWaitTime) {
          console.log(`🔄 Polling for WiFi modal... (${elapsed}ms/${maxWaitTime}ms)`);

          for (const selector of modalSelectors) {
            const element = document.querySelector(selector) as HTMLElement;
            if (element && element.offsetParent !== null) {
              // Additional visibility checks
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const isVisible =
                rect.width > 0 &&
                rect.height > 0 &&
                style.opacity !== '0' &&
                style.visibility !== 'hidden' &&
                style.display !== 'none';

              if (isVisible) {
                modalDialog = element;
                console.log(`✅ Found fully visible WiFi modal using selector: ${selector}`);
                console.log(`📐 Modal dimensions: ${rect.width}x${rect.height}, opacity: ${style.opacity}`);
                break;
              } else {
                console.log(`⏳ Modal found but not fully visible yet: ${selector}`);
              }
            }
          }

          if (!modalDialog) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            elapsed += pollInterval;
          }
        }

        // If no modal found, try getting the topmost visible overlay
        if (!modalDialog) {
          const allElements = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          const visibleOverlays = allElements.filter(el => {
            const style = getComputedStyle(el);
            const zIndex = parseInt(style.zIndex);
            return (
              el.offsetParent !== null &&
              (zIndex > 999 || style.position === 'fixed' || style.position === 'absolute') &&
              el.getBoundingClientRect().width > 200 &&
              el.getBoundingClientRect().height > 100
            );
          });

          // Get the element with highest z-index
          modalDialog = visibleOverlays.sort((a, b) => {
            const aZ = parseInt(getComputedStyle(a).zIndex) || 0;
            const bZ = parseInt(getComputedStyle(b).zIndex) || 0;
            return bZ - aZ;
          })[0];

          if (modalDialog) {
            console.log('✅ Found WiFi modal by z-index detection');
          }
        }

        if (modalDialog) {
          console.log('📊 Modal element details:', {
            tagName: modalDialog.tagName,
            className: modalDialog.className,
            id: modalDialog.id,
            role: modalDialog.getAttribute('role'),
            ariaModal: modalDialog.getAttribute('aria-modal'),
            isVisible: modalDialog.offsetParent !== null,
            dimensions: {
              width: modalDialog.offsetWidth,
              height: modalDialog.offsetHeight,
            },
          });

          // Extra wait for WiFi modal animation to completely finish and content to load
          console.log('🎬 Waiting for WiFi modal animation and content to fully settle...');
          await new Promise(resolve => setTimeout(resolve, 1500)); // Longer wait for complete animation

          // Capture the entire viewport with modal visible (not just the modal element)
          console.log('📸 Capturing viewport with WiFi modal visible...');
          const mainElement = document.querySelector('main') || document.body;
          const wifiResult = await captureScreenshot(mainElement as HTMLElement);
          if (wifiResult) {
            capturedImages.push({
              filename: 'wifi-networks-modal.png',
              blob: wifiResult.blob,
              theme: 'dark',
              type: 'modal',
            });
            console.log('✅ WiFi modal screenshot captured successfully');
          }

          // Enhanced modal closing logic
          console.log('🚪 Attempting to close WiFi modal...');

          // Try multiple close methods
          const closeButton = modalDialog.querySelector(
            '[aria-label*="Close"], [aria-label*="close"], .close-button, [data-close]',
          );
          if (closeButton) {
            console.log('Closing modal via close button');
            (closeButton as HTMLElement).click();
          } else {
            // Try backdrop click
            const backdrop = document.querySelector(
              '[data-overlay], .backdrop, .modal-backdrop, [data-radix-dialog-overlay]',
            );
            if (backdrop) {
              console.log('Closing modal via backdrop click');
              (backdrop as HTMLElement).click();
            } else {
              // Try escape key
              console.log('Closing modal via escape key');
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
          }

          await new Promise(resolve => setTimeout(resolve, 1000));
          toast.success('WiFi networks modal captured', { duration: 800 });
        } else {
          console.warn('❌ WiFi modal not found with any selector');
          console.log(
            '🔍 Available elements with high z-index:',
            Array.from(document.querySelectorAll('*'))
              .filter(el => parseInt(getComputedStyle(el).zIndex) > 100)
              .map(el => ({
                tag: el.tagName,
                class: el.className,
                zIndex: getComputedStyle(el).zIndex,
              })),
          );
        }
      } else {
        console.warn('WiFi selector button not found');
      }
    } catch (error) {
      console.error('Failed to capture WiFi modal:', error);
      toast.error('Failed to capture WiFi modal', { duration: 800 });
    }

    // Capture hotspot configurator modal
    try {
      totalProgress++;
      captureProgress = `🔥 Capturing hotspot configurator modal [${totalProgress}/${maxProgress}]`;

      // Find and click hotspot configurator button
      const hotspotButton = findButtonByText([
        'Configure Hotspot',
        'Hotspot Config',
        'Setup Hotspot',
        'Hotspot Settings',
      ]);
      if (hotspotButton) {
        console.log('🔍 Found hotspot configurator button, clicking...');
        hotspotButton.click();

        // Wait for modal to open AND be fully animated/visible
        console.log('⏳ Waiting for hotspot modal to open and animate...');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Initial wait for modal to start opening

        // Enhanced hotspot modal dialog detection with visibility verification
        console.log('🔍 Searching for fully visible hotspot configurator modal dialog...');

        const modalSelectors = [
          // AlertDialog specific (bits-ui/shadcn) - targeting the portal content
          '[data-bits-alert-dialog-content]',
          '[data-bits-alert-dialog-content][data-state="open"]',
          // Look for fixed positioned elements with modal styling
          '.fixed.left-1\\/2.top-1\\/2',
          'div[class*="fixed"][class*="z-"]',
          // Standard modal selectors
          '[role="dialog"]',
          '.modal',
          '[data-state="open"]',
          '[data-testid*="modal"]',
          '[data-testid*="dialog"]',
          '.dialog',
          '.popover',
          '[aria-modal="true"]',
          '.sheet',
          '.drawer',
          '.overlay-content',
          // Shadcn-specific selectors
          '[data-radix-collection-item]',
          '[data-radix-popper-content-wrapper]',
          '[cmdk-dialog]',
          '.command',
        ];

        let modalDialog: HTMLElement | null = null;

        // Poll for modal to be visible and fully rendered (up to 10 seconds)
        const maxWaitTime = 10000; // 10 seconds max
        const pollInterval = 200; // Check every 200ms
        let elapsed = 0;

        while (!modalDialog && elapsed < maxWaitTime) {
          console.log(`🔄 Polling for hotspot modal... (${elapsed}ms/${maxWaitTime}ms)`);

          for (const selector of modalSelectors) {
            const element = document.querySelector(selector) as HTMLElement;
            if (element && element.offsetParent !== null) {
              // Additional visibility checks
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              const isVisible =
                rect.width > 0 &&
                rect.height > 0 &&
                style.opacity !== '0' &&
                style.visibility !== 'hidden' &&
                style.display !== 'none';

              if (isVisible) {
                modalDialog = element;
                console.log(`✅ Found fully visible hotspot modal using selector: ${selector}`);
                console.log(`📐 Modal dimensions: ${rect.width}x${rect.height}, opacity: ${style.opacity}`);
                break;
              } else {
                console.log(`⏳ Modal found but not fully visible yet: ${selector}`);
              }
            }
          }

          if (!modalDialog) {
            await new Promise(resolve => setTimeout(resolve, pollInterval));
            elapsed += pollInterval;
          }
        }

        // If no modal found, try getting the topmost visible overlay
        if (!modalDialog) {
          const allElements = Array.from(document.querySelectorAll('*')) as HTMLElement[];
          const visibleOverlays = allElements.filter(el => {
            const style = getComputedStyle(el);
            const zIndex = parseInt(style.zIndex);
            const rect = el.getBoundingClientRect();
            const isVisible =
              el.offsetParent !== null &&
              rect.width > 0 &&
              rect.height > 0 &&
              style.opacity !== '0' &&
              style.visibility !== 'hidden' &&
              style.display !== 'none' &&
              (zIndex > 999 || style.position === 'fixed' || style.position === 'absolute') &&
              rect.width > 200 &&
              rect.height > 100;
            return isVisible;
          });

          // Get the element with highest z-index
          modalDialog = visibleOverlays.sort((a, b) => {
            const aZ = parseInt(getComputedStyle(a).zIndex) || 0;
            const bZ = parseInt(getComputedStyle(b).zIndex) || 0;
            return bZ - aZ;
          })[0];

          if (modalDialog) {
            console.log('✅ Found hotspot modal by enhanced z-index detection');
          }
        }

        if (modalDialog) {
          console.log('📊 Hotspot modal element details:', {
            tagName: modalDialog.tagName,
            className: modalDialog.className,
            id: modalDialog.id,
            role: modalDialog.getAttribute('role'),
            ariaModal: modalDialog.getAttribute('aria-modal'),
            isVisible: modalDialog.offsetParent !== null,
            dimensions: {
              width: modalDialog.offsetWidth,
              height: modalDialog.offsetHeight,
            },
          });

          // Extra wait for hotspot modal animation to completely finish and content to load
          console.log('🎬 Waiting for hotspot modal animation and content to fully settle...');
          await new Promise(resolve => setTimeout(resolve, 1500)); // Longer wait for complete animation

          // Capture the entire viewport with hotspot modal visible (not just the modal element)
          console.log('📸 Capturing viewport with hotspot modal visible...');
          const mainElement = document.querySelector('main') || document.body;
          const hotspotResult = await captureScreenshot(mainElement as HTMLElement);
          if (hotspotResult) {
            capturedImages.push({
              filename: 'hotspot-configurator-modal.png',
              blob: hotspotResult.blob,
              theme: 'dark',
              type: 'modal',
            });
            console.log('✅ Hotspot modal screenshot captured successfully');
          }

          // Enhanced modal closing logic
          console.log('🚪 Attempting to close hotspot modal...');

          // Try multiple close methods
          const closeButton = modalDialog.querySelector(
            '[aria-label*="Close"], [aria-label*="close"], .close-button, [data-close]',
          );
          if (closeButton) {
            console.log('Closing modal via close button');
            (closeButton as HTMLElement).click();
          } else {
            // Try backdrop click
            const backdrop = document.querySelector(
              '[data-overlay], .backdrop, .modal-backdrop, [data-radix-dialog-overlay]',
            );
            if (backdrop) {
              console.log('Closing modal via backdrop click');
              (backdrop as HTMLElement).click();
            } else {
              // Try escape key
              console.log('Closing modal via escape key');
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
          }

          await new Promise(resolve => setTimeout(resolve, 1000));
          toast.success('Hotspot configurator modal captured', { duration: 800 });
        } else {
          console.warn('❌ Hotspot modal not found with any selector');
          console.log(
            '🔍 Available elements with high z-index:',
            Array.from(document.querySelectorAll('*'))
              .filter(el => parseInt(getComputedStyle(el).zIndex) > 100)
              .map(el => ({
                tag: el.tagName,
                class: el.className,
                zIndex: getComputedStyle(el).zIndex,
              })),
          );
        }
      } else {
        console.warn('Hotspot configurator button not found');
      }
    } catch (error) {
      console.error('Failed to capture hotspot modal:', error);
      toast.error('Failed to capture hotspot modal', { duration: 800 });
    }

    // PHASE 3: Capture the actual updating overlay (not devtools view)
    try {
      totalProgress++;
      captureProgress = `🎬 Capturing updating overlay demo [${totalProgress}/${maxProgress}]`;

      // Navigate to dev tools tab
      await navigateToTab('devtools');

      await switchTheme('dark');
      await new Promise(resolve => setTimeout(resolve, 1500));

      const demoButton = findButtonByText(['Start Demo', 'Demo Start', 'Start']);
      if (demoButton) {
        console.log('🔍 Found demo button, starting overlay...');
        demoButton.click();

        // Wait for the updating overlay to appear and animate
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Look for the updating overlay element (not the devtools page)
        const overlayElement =
          document.querySelector('[data-vaul-drawer]') ||
          document.querySelector('.updating-overlay') ||
          document.querySelector('[role="dialog"]') ||
          document.querySelector('.drawer-content');

        if (overlayElement) {
          console.log('📸 Found updating overlay element, capturing viewport with overlay visible...');
          // Capture entire viewport with overlay visible (not just the overlay element)
          const mainElement = document.querySelector('main') || document.body;
          const demoResult = await captureScreenshot(mainElement as HTMLElement, undefined, {
            width: window.innerWidth,
            height: window.innerHeight,
            pixelRatio: 1,
            quality: 1.0,
          });
          if (demoResult) {
            capturedImages.push({
              filename: 'updating-overlay-demo.png',
              blob: demoResult.blob,
              theme: 'dark',
              type: 'demo',
            });
          }

          toast.success('Updating overlay captured', { duration: 800 });
        } else {
          console.warn('Updating overlay element not found, capturing viewport anyway...');
          // Fallback to viewport capture with proper constraints
          const mainElement = document.querySelector('main') || document.body;
          const fullScreenResult = await captureScreenshot(mainElement as HTMLElement, undefined, {
            width: window.innerWidth,
            height: window.innerHeight,
            pixelRatio: 1,
            quality: 1.0,
          });
          if (fullScreenResult) {
            capturedImages.push({
              filename: 'updating-overlay-demo.png',
              blob: fullScreenResult.blob,
              theme: 'dark',
              type: 'demo',
            });
          }

          toast.success('Overlay demo captured (full screen)', { duration: 800 });
        }

        // Stop demo
        const stopButton = findButtonByText(['Stop Demo', 'Demo Stop', 'Stop']);
        if (stopButton) {
          stopButton.click();
        }

        // Wait for overlay to close
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        console.warn('Demo button not found');
      }
    } catch (error) {
      console.error('Failed to capture overlay demo:', error);
      toast.error('Failed to capture overlay demo', { duration: 800 });
    }

    // Capture offline mode
    try {
      totalProgress++;
      captureProgress = `📴 Capturing offline mode [${totalProgress}/${maxProgress}]`;

      // Simulate offline mode
      isOnline.set(false);

      // Navigate to general tab to show offline state
      await navigateToTab('general');
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for offline UI to appear

      const mainElement = document.querySelector('main') || document.body;
      const offlineResult = await captureScreenshot(mainElement as HTMLElement);
      if (offlineResult) {
        capturedImages.push({
          filename: 'offline-mode.png',
          blob: offlineResult.blob,
          theme: 'dark',
          type: 'pwa-state',
        });
      }

      // Restore online status
      isOnline.set(originalOnlineStatus);
      await new Promise(resolve => setTimeout(resolve, 1000));

      toast.success('Offline mode captured', { duration: 800 });
    } catch (error) {
      console.error('Failed to capture offline mode:', error);
      toast.error('Failed to capture offline mode', { duration: 800 });
    }

    // Restore original theme
    await switchTheme(originalTheme);

    toast.success($_('devtools.screenshotComplete'), {
      description: `${capturedImages.length} screenshots captured across both themes`,
    });

    captureProgress = `Capture complete! Auto-downloading ZIP...`;

    // 🎯 FIX: Automatically download ZIP after capturing everything
    console.log('🎯 Auto-triggering ZIP download after comprehensive capture...');
    setTimeout(() => {
      downloadZipFile();
    }, 1000); // Small delay to ensure UI updates
  } catch (error) {
    toast.error('Comprehensive capture failed', {
      description: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    // Always restore screenshot mode and online status
    isScreenshotMode.set(false);
    isOnline.set(originalOnlineStatus);
    isCapturing = false;
  }
}

// Capture all tabs in current theme only
async function captureAllTabs() {
  if (isCapturing) return;

  try {
    isCapturing = true;
    const theme = getCurrentTheme();
    const tabs = [
      { name: 'general', hash: 'general' },
      { name: 'network', hash: 'network' },
      { name: 'streaming', hash: 'settings' },
      { name: 'advanced', hash: 'advanced' },
      { name: 'devtools', hash: 'devtools' },
    ];

    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      captureProgress = `Capturing ${tab.name} (${i + 1}/${tabs.length})...`;

      // Navigate to tab programmatically
      await navigateToTab(tab.hash);

      // Wait for navigation and rendering
      await new Promise(resolve => setTimeout(resolve, 1500));

      const mainElement = document.querySelector('main') || document.body;
      const result = await captureScreenshot(mainElement as HTMLElement, `${tab.name}.png`);

      // Store for ZIP download
      capturedImages.push({
        filename: `${tab.name}.png`,
        blob: result.blob,
        theme,
        type: 'desktop',
      });

      toast.success(`${tab.name} tab captured`, { duration: 2000 });
    }

    toast.success(`All ${tabs.length} tabs captured!`, {
      description: `Screenshots saved and ready for ZIP download`,
    });
  } catch (error) {
    toast.error('Batch capture failed', {
      description: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    isCapturing = false;
    captureProgress = '';
  }
}

// Capture mobile view (improved)
async function captureMobileView() {
  if (isCapturing) return;

  try {
    isCapturing = true;
    captureProgress = 'Switching to mobile view...';

    const theme = getCurrentTheme();
    const route = getCurrentRoute();
    const restoreData = await enableMobileView();

    if (!restoreData || !restoreData.resizeMethod) {
      console.error(`❌ Mobile simulation failed - restoreData is invalid:`, restoreData);
      throw new Error('Mobile simulation failed to return valid data');
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const filename = `${route}.png`; // No -mobile suffix since it's in mobile folder
    const mainElement = document.querySelector('main') || document.body;

    const result = await captureScreenshot(mainElement as HTMLElement, filename);

    // Store for ZIP download
    capturedImages.push({
      filename,
      blob: result.blob,
      theme,
      type: 'mobile',
    });

    toast.success(`Mobile screenshot captured`, {
      description: `${filename} captured at 375px width`,
    });

    await disableMobileView(restoreData);
  } catch (error) {
    toast.error('Mobile capture failed', {
      description: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    isCapturing = false;
    captureProgress = '';
  }
}

// Clear captured images
function clearCapturedImages() {
  capturedImages.length = 0;
  toast.info('Screenshots cleared', {
    description: 'All captured screenshots have been cleared from memory',
  });
}

// Capture overlay demo function
async function captureOverlayDemo() {
  if (isCapturing) return;

  try {
    isCapturing = true;
    captureProgress = 'Starting overlay demo capture...';

    console.log('🎬 Starting overlay demo capture...');

    // Try to find and trigger the demo overlay
    const demoButton = findButtonByText(['Start Demo', 'Demo Start', 'Start']);
    if (!demoButton) {
      toast.error('Demo button not found', {
        description: 'Please ensure you are on the Dev Tools tab',
      });
      return;
    }

    console.log('✅ Found demo button, starting demo...');

    // Click the demo button to start the overlay
    demoButton.click();

    // Wait for the overlay to appear and animate
    captureProgress = 'Waiting for overlay to appear...';
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Capture the overlay in action
    captureProgress = 'Capturing overlay demo...';
    const mainElement = document.querySelector('main') || document.body;
    const result = await captureScreenshot(mainElement as HTMLElement, 'overlay-demo.png');

    if (result) {
      capturedImages.push({
        filename: 'overlay-demo.png',
        blob: result.blob,
        theme: getCurrentTheme(),
        type: 'demo',
      });

      toast.success('Overlay demo captured!', {
        description: 'Demo overlay screenshot added to collection',
      });
    }

    // Try to stop the demo (find stop button)
    setTimeout(() => {
      const stopButton = findButtonByText(['Stop Demo', 'Demo Stop', 'Stop']);
      if (stopButton) {
        stopButton.click();
        console.log('✅ Demo stopped');
      }
    }, 1000);
  } catch (error) {
    console.error('❌ Overlay demo capture failed:', error);
    toast.error('Overlay demo capture failed', {
      description: error instanceof Error ? error.message : 'Unknown error',
    });
  } finally {
    isCapturing = false;
    captureProgress = '';
  }
}
</script>

<!-- Screenshot Utility Card - Mobile First -->
<Card.Root class="border-dashed border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20">
  <Card.Header class="pb-3 sm:pb-6">
    <Card.Title class="flex items-center gap-2 text-sm text-blue-700 sm:text-base dark:text-blue-300">
      <Camera class="h-4 w-4 flex-shrink-0 sm:h-5 sm:w-5" />
      <span class="truncate">📸 {$_('devtools.screenshotUtility')}</span>
    </Card.Title>
    <Card.Description class="text-xs text-blue-600 sm:text-sm dark:text-blue-400">
      {$_('devtools.screenshotUtilityDescription')}
    </Card.Description>
  </Card.Header>

  <Card.Content class="space-y-3 sm:space-y-4">
    <!-- Progress indicator -->
    {#if isCapturing}
      <div class="rounded-md bg-blue-100 p-3 dark:bg-blue-900/30">
        <div class="mb-2 flex items-center gap-2">
          <div class="h-4 w-4 animate-spin rounded-full border-2 border-blue-600 border-t-transparent"></div>
          <span class="text-sm font-medium text-blue-700 dark:text-blue-300">{captureProgress}</span>
        </div>
        {#if maxProgress > 0}
          <div class="h-2 w-full rounded-full bg-blue-200 dark:bg-blue-800">
            <div
              class="h-2 rounded-full bg-blue-600 transition-all duration-300"
              style="width: {(totalProgress / maxProgress) * 100}%">
            </div>
          </div>
          <div class="mt-1 text-xs text-blue-600 dark:text-blue-400">{totalProgress}/{maxProgress} operations</div>
        {/if}
      </div>
    {/if}

    <!-- Capture Status -->
    {#if capturedImages.length > 0}
      <div class="rounded-md bg-green-100 p-3 dark:bg-green-900/30">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Archive class="h-4 w-4 text-green-600 dark:text-green-400" />
            <span class="text-sm font-medium text-green-700 dark:text-green-300">
              {capturedImages.length}
              {$_('devtools.screenshotZipReady')}
            </span>
          </div>
          <Button.Root onclick={clearCapturedImages} size="sm" variant="ghost" class="h-6 px-2 text-xs">
            {$_('devtools.screenshotClear')}
          </Button.Root>
        </div>
      </div>
    {/if}

    <!-- Main Actions - Mobile Optimized -->
    <div class="space-y-2 sm:space-y-3">
      <div class="text-muted-foreground text-xs font-medium">🚀 Comprehensive Capture</div>
      <Button.Root
        onclick={captureEverything}
        disabled={isCapturing}
        size="sm"
        class="flex h-auto min-h-[2.5rem] w-full items-center justify-center gap-1 bg-gradient-to-r from-blue-600 to-purple-600 px-2 py-2 text-xs hover:from-blue-700 hover:to-purple-700 sm:gap-2 sm:px-4 sm:py-3 sm:text-sm">
        <Zap class="h-3 w-3 flex-shrink-0 sm:h-4 sm:w-4" />
        <span class="text-center leading-tight">
          <span class="block sm:hidden">{$_('devtools.screenshotComprehensive')}</span>
          <span class="hidden sm:block">{$_('devtools.screenshotComprehensive')} (All Themes + Mobile + Modals)</span>
        </span>
      </Button.Root>
      <div class="text-muted-foreground px-2 text-center text-xs">
        {$_('devtools.screenshotComprehensiveDesc')}
      </div>
    </div>

    <!-- Quick Actions - Mobile Optimized -->
    <div class="space-y-2 sm:space-y-3">
      <div class="text-muted-foreground text-xs font-medium">Quick Capture</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button.Root
          onclick={captureCurrentTab}
          disabled={isCapturing}
          size="sm"
          class="flex h-8 items-center gap-1 text-xs sm:h-9 sm:gap-2 sm:text-sm">
          <Eye class="h-3 w-3 flex-shrink-0 sm:h-4 sm:w-4" />
          <span class="truncate">{$_('devtools.screenshotCurrentTab')}</span>
        </Button.Root>

        <Button.Root
          onclick={captureAllTabs}
          disabled={isCapturing}
          size="sm"
          variant="secondary"
          class="flex h-8 items-center gap-1 text-xs sm:h-9 sm:gap-2 sm:text-sm">
          <Monitor class="h-3 w-3 flex-shrink-0 sm:h-4 sm:w-4" />
          <span class="truncate">{$_('devtools.screenshotAllTabs')}</span>
        </Button.Root>
      </div>
    </div>

    <!-- Advanced Options - Mobile Optimized -->
    <div class="space-y-2 sm:space-y-3">
      <div class="text-muted-foreground text-xs font-medium">Individual Capture</div>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button.Root
          onclick={captureMobileView}
          disabled={isCapturing}
          size="sm"
          variant="outline"
          class="flex h-8 items-center gap-1 text-xs sm:h-9 sm:gap-2 sm:text-sm">
          <Smartphone class="h-3 w-3 flex-shrink-0 sm:h-4 sm:w-4" />
          <span class="truncate">{$_('devtools.screenshotMobileView')}</span>
        </Button.Root>

        <Button.Root
          onclick={() => captureModal('wifi-networks')}
          disabled={isCapturing}
          size="sm"
          variant="outline"
          class="flex h-8 items-center gap-1 text-xs sm:h-9 sm:gap-2 sm:text-sm">
          <Image class="h-3 w-3 flex-shrink-0 sm:h-4 sm:w-4" />
          <span class="truncate">WiFi Modal</span>
        </Button.Root>
      </div>
    </div>

    <!-- Download Actions - Mobile Optimized -->
    <div class="space-y-2 border-t pt-2 sm:pt-3">
      <Button.Root
        onclick={() => {
          console.log('🖱️ ZIP DOWNLOAD BUTTON CLICKED!');
          console.log('📊 capturedImages.length:', capturedImages.length);
          downloadZipFile();
        }}
        disabled={capturedImages.length === 0}
        size="sm"
        variant={capturedImages.length > 0 ? 'default' : 'ghost'}
        class="flex h-8 w-full items-center gap-1 text-xs sm:h-9 sm:gap-2 sm:text-sm">
        <Download class="h-3 w-3 flex-shrink-0 sm:h-4 sm:w-4" />
        <span class="truncate">{$_('devtools.screenshotZipDownload')} ({capturedImages.length} files)</span>
      </Button.Root>

      <!-- Overlay Demo Capture -->
      <Button.Root
        onclick={captureOverlayDemo}
        disabled={isCapturing}
        size="sm"
        variant="outline"
        class="flex h-8 w-full items-center gap-1 text-xs sm:h-9 sm:gap-2 sm:text-sm">
        <Play class="h-3 w-3 flex-shrink-0 sm:h-4 sm:w-4" />
        <span class="truncate">Capture Overlay Demo</span>
      </Button.Root>
    </div>

    <!-- Info - Mobile Optimized -->
    <div class="bg-muted/30 text-muted-foreground rounded-md p-2 text-xs sm:p-3">
      <div class="mb-1 flex flex-wrap items-center gap-1 font-medium sm:gap-2">
        <span class="flex-shrink-0">💡 Enhanced Features</span>
        {#if isMobileViewport.current}
          <span class="text-xs font-semibold text-orange-600 dark:text-orange-400">(Mobile Detected)</span>
        {/if}
      </div>
      <ul class="space-y-0.5 sm:space-y-1">
        <li class="break-words">• <strong>Tab-by-Tab Order:</strong> Desktop dark/light + mobile dark/light per tab</li>
        <li class="break-words">• <strong>Real Modal Triggers:</strong> Actually clicks WiFi/hotspot buttons</li>
        <li class="break-words">• <strong>Updating Overlay:</strong> Captures actual overlay animation</li>
        <li class="break-words">
          • <strong>setViewportSize Approach:</strong> Primary window.resizeTo (like Playwright)
        </li>
        <li class="break-words">• <strong>Viewport-Based Capture:</strong> Exact 430x932 mobile dimensions</li>
        <li class="break-words">• <strong>Authentic Mobile Styles:</strong> Real responsive behavior, no CSS hacks</li>
        <li class="break-words">• <strong>PWA Features:</strong> Offline mode + install banner suppression</li>
      </ul>
    </div>
  </Card.Content>
</Card.Root>
