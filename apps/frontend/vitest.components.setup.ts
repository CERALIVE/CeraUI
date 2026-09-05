import { registerAllNamespaces } from "@ceraui/i18n/eager";
import { afterAll } from "vitest";

/**
 * jsdom does not implement matchMedia. Most component suites install a tailored
 * mock, but source-only imports such as NavigationHelper still evaluate PWA code
 * before their own hooks run. Supply the inert browser default at project setup;
 * a test remains free to replace it with a query-aware mock.
 */
if (typeof window.matchMedia !== "function") {
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		writable: true,
		value: (query: string): MediaQueryList => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => undefined,
			removeListener: () => undefined,
			addEventListener: () => undefined,
			removeEventListener: () => undefined,
			dispatchEvent: () => false,
		}),
	});
}

/**
 * bits-ui body-scroll-lock teardown guard.
 *
 * Every Dialog/Sheet surface installs a `BodyScrollLock`. When the final lock in
 * a test file unmounts during Testing Library cleanup, bits-ui schedules
 * `resetBodyStyle()` after 24 ms. Waiting once per component file keeps jsdom's
 * `document` alive until that timer has fired; pure files never pay this cost.
 */
afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 50));
});

/**
 * Component tests mount below `main.ts`, so they do not run the application's
 * namespace activation. Register the full generated catalog before rendering.
 */
registerAllNamespaces();
