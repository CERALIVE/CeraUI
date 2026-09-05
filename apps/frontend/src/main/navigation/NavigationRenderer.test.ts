// @vitest-environment jsdom
/**
 * NavigationRenderer.svelte — behaviour lock for the destination gate and the
 * hash-navigation listener's cleanup.
 *
 * Two contracts are pinned:
 *
 *   · WHAT RENDERS — a destination reaches the DOM only once its lazy i18n
 *     namespaces are in the registry, an already-loaded destination renders
 *     synchronously, and a navigation error replaces the content entirely.
 *   · WHAT IS TORN DOWN — `setupHashNavigation` registers a `hashchange`
 *     listener, and the renderer's `$effect` must return that removal so the
 *     listener does not outlive the component. The spy compares handler
 *     IDENTITY, so returning a different function would not satisfy it.
 *
 * Green on the pre-change tree — refactor lock for the `showContent` effect,
 * not a bug fix.
 */
import { render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	publishNavigation,
	resetNavigationFeed,
} from "./__fixtures__/navigation-feed.svelte";
import NavigationRenderer from "./NavigationRenderer.svelte";

const nav = vi.hoisted(() => ({
	transitioning: false,
	error: null as string | null,
}));

const namespaces = vi.hoisted(() => ({
	loaded: new Set<string>(),
	pending: [] as Array<() => void>,
}));

const hashHandlers = vi.hoisted(() => ({
	added: [] as EventListener[],
}));

// jsdom implements no Web Animations API, so Svelte's css transitions would
// throw on `element.animate`. Zero-duration stand-ins keep the render path
// intact without pinning anything about the transition itself.
vi.mock("$lib/transitions", () => ({
	einkGatedFade: () => ({ duration: 0 }),
	einkGatedFly: () => ({ duration: 0 }),
}));

vi.mock("$lib/helpers/NavigationHelper", () => ({
	// Faithful to the production shape: it registers a `hashchange` listener on
	// `window` and hands back the removal. The component's contract is that it
	// CALLS that removal on teardown.
	setupHashNavigation: () => {
		const handler: EventListener = () => {};
		hashHandlers.added.push(handler);
		window.addEventListener("hashchange", handler);
		return () => window.removeEventListener("hashchange", handler);
	},
}));

vi.mock("$lib/i18n/namespace-activation", () => ({
	areDestinationNamespacesLoaded: (key: string) => namespaces.loaded.has(key),
	ensureDestinationNamespaces: (key: string) =>
		new Promise<void>((resolve) => {
			namespaces.pending.push(() => {
				namespaces.loaded.add(key);
				resolve();
			});
		}),
}));

vi.mock("$lib/stores/navigation.svelte", async () => {
	const feed = await import("./__fixtures__/navigation-feed.svelte");
	const readable = <T>(read: () => T) => ({
		subscribe: (run: (value: T) => void) => {
			run(read());
			return () => {};
		},
	});
	return {
		getCurrentNavigation: feed.getCurrentNavigationFeed,
		navigationStore: { set: vi.fn(), subscribe: () => () => {} },
		enhancedNavigationStore: { setError: vi.fn() },
		isNavigationTransitioning: readable(() => nav.transitioning),
		navigationError: readable(() => nav.error),
		transitionDirection: readable(() => "forward" as const),
	};
});

const Stub = await import("../../tests/fixtures/Noop.svelte");

const content = () => screen.queryByTestId("destination-content");

function settlePendingNamespaces(): void {
	const queued = namespaces.pending.splice(0);
	for (const resolve of queued) resolve();
}

beforeEach(() => {
	resetNavigationFeed();
	nav.transitioning = false;
	nav.error = null;
	namespaces.loaded.clear();
	namespaces.pending.length = 0;
	hashHandlers.added.length = 0;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("NavigationRenderer — the destination gate", () => {
	it("renders an already-loaded destination synchronously", () => {
		namespaces.loaded.add("live");
		publishNavigation({ live: { component: Stub.default } });

		render(NavigationRenderer);

		expect(content()).not.toBeNull();
		expect(content()?.getAttribute("data-destination")).toBe("live");
	});

	it("withholds a destination whose namespaces have not resolved", async () => {
		publishNavigation({ network: { component: Stub.default } });

		render(NavigationRenderer);
		expect(content()).toBeNull();

		settlePendingNamespaces();
		await waitFor(() => expect(content()).not.toBeNull());
		expect(content()?.getAttribute("data-destination")).toBe("network");
	});

	it("re-keys the rendered destination on navigation", async () => {
		namespaces.loaded.add("live");
		namespaces.loaded.add("settings");
		publishNavigation({ live: { component: Stub.default } });

		render(NavigationRenderer);
		expect(content()?.getAttribute("data-destination")).toBe("live");

		publishNavigation({ settings: { component: Stub.default } });
		await waitFor(() =>
			expect(content()?.getAttribute("data-destination")).toBe("settings"),
		);
	});

	it("renders nothing for a navigation that resolves no component", () => {
		namespaces.loaded.add("live");
		publishNavigation({ live: {} });

		render(NavigationRenderer);
		expect(content()).toBeNull();
	});

	it("replaces the content with the error branch", async () => {
		namespaces.loaded.add("live");
		publishNavigation({ live: { component: Stub.default } });
		nav.error = "Navigation exploded";

		render(NavigationRenderer);

		await waitFor(() =>
			expect(screen.queryByText("Navigation exploded")).not.toBeNull(),
		);
		expect(content()).toBeNull();
	});
});

describe("NavigationRenderer — hash-navigation listener lifecycle", () => {
	it("registers a hashchange listener at mount and removes it at unmount", () => {
		const add = vi.spyOn(window, "addEventListener");
		const remove = vi.spyOn(window, "removeEventListener");

		namespaces.loaded.add("live");
		publishNavigation({ live: { component: Stub.default } });
		const view = render(NavigationRenderer);

		const added = add.mock.calls.filter(([type]) => type === "hashchange");
		expect(added).toHaveLength(1);
		expect(
			remove.mock.calls.filter(([type]) => type === "hashchange"),
		).toHaveLength(0);

		view.unmount();

		const removed = remove.mock.calls.filter(([type]) => type === "hashchange");
		expect(removed).toHaveLength(1);
		// Same handler reference — a removal of some OTHER function would leave
		// the real listener attached and still satisfy a count-only assertion.
		expect(removed[0]?.[1]).toBe(added[0]?.[1]);

		add.mockRestore();
		remove.mockRestore();
	});

	// The transition spinner is the ONE animated node on this surface, and it is
	// unreachable from a browser: `setTransitioning` has no caller in shipped
	// source, so `tests/e2e/touch-targets.spec.ts` cannot render it and read its
	// computed style the way it does for the shell's other two. Driving the store
	// double is therefore the only place its motion gate can be pinned at all.
	it("declares its transition spinner motion-safe, never a bare animation", () => {
		nav.transitioning = true;
		namespaces.loaded.add("live");
		publishNavigation({ live: { component: Stub.default } });

		render(NavigationRenderer);

		const spinner = screen.getByTestId("navigation-transition-spinner");
		expect(spinner.classList.contains("motion-safe:animate-spin")).toBe(true);
		expect(spinner.classList.contains("animate-spin")).toBe(false);
	});

	it("does not re-register the listener when the destination changes", async () => {
		namespaces.loaded.add("live");
		namespaces.loaded.add("settings");
		publishNavigation({ live: { component: Stub.default } });

		render(NavigationRenderer);
		expect(hashHandlers.added).toHaveLength(1);

		publishNavigation({ settings: { component: Stub.default } });
		await waitFor(() =>
			expect(content()?.getAttribute("data-destination")).toBe("settings"),
		);

		expect(hashHandlers.added).toHaveLength(1);
	});
});
