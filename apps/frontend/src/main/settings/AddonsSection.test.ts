// @vitest-environment jsdom
/**
 * AddonsSection — board gating, conflict warnings, and the docs panel.
 *
 * The server is the authoritative gate (addons.procedure rejects an incompatible
 * or conflicting enable); this surface only REFLECTS that:
 *  1. an add-on whose `compatibleHardware` excludes the detected board renders
 *     disabled WITH a visible reason (never hidden);
 *  2. a structured enable error (addon_conflict / addon_dependency_missing) is
 *     pinned to the card as a visible warning instead of silently reverting;
 *  3. an add-on that ships `docs` / `helpUrl` exposes an expandable help panel
 *     rendering exactly the descriptor text (no invented copy).
 */
import type { AddonDescriptor, AddonState } from "@ceraui/rpc/schemas";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { destroyAsyncOperations } from "$lib/rpc/async-operation.svelte";
import type { AddonOpResult } from "$lib/rpc/client";
import AddonsSection from "./AddonsSection.svelte";

const rpcMocks = vi.hoisted(() => ({
	list: vi.fn(),
	install: vi.fn(),
	uninstall: vi.fn(),
	getMockHardware: vi.fn(),
}));

vi.mock("$lib/rpc/client", () => ({
	rpc: {
		addons: {
			list: rpcMocks.list,
			install: rpcMocks.install,
			uninstall: rpcMocks.uninstall,
		},
		streaming: { getMockHardware: rpcMocks.getMockHardware },
	},
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getAddons: () => ({}),
}));

vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
	const proto = window.Element.prototype as unknown as Record<string, unknown>;
	proto.hasPointerCapture ??= vi.fn(() => false);
	proto.setPointerCapture ??= vi.fn();
	proto.releasePointerCapture ??= vi.fn();
	proto.scrollIntoView ??= vi.fn();
});

const IDLE: AddonState = { enabled: false, phase: "idle", autoDisabled: false };

function makeDescriptor(overrides: Partial<AddonDescriptor>): AddonDescriptor {
	return {
		id: "sample",
		name: "Sample Add-on",
		version: "1.0.0",
		category: "media",
		payload: { type: "sysext" },
		sysextLevel: "1",
		versionId: "12",
		artifact: {
			urlTemplate: "https://example.com/{os_version}/sample.raw",
			sha256: "a".repeat(64),
			gpgSigRef: "sig",
			sizeDownload: 1000,
			sizeInstalled: 2000,
		},
		provides: ["/usr/lib/sample"],
		...overrides,
	} as AddonDescriptor;
}

function seedList(descriptors: AddonDescriptor[], board = "n100"): void {
	rpcMocks.list.mockResolvedValue({
		addons: descriptors.map((descriptor) => ({
			descriptor,
			state: IDLE,
			managerPhase: "disabled",
		})),
	});
	rpcMocks.getMockHardware.mockResolvedValue({
		hardware: null,
		effectiveHardware: board,
		availableHardware: ["jetson", "n100", "rk3588", "generic"],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	// Reset the keyed async-operation singleton so a lingering per-add-on phase
	// never bleeds re-entry state into the next test.
	destroyAsyncOperations();
});

describe("AddonsSection — board gating", () => {
	it("disables an add-on whose compatibleHardware excludes the detected board and shows the reason", async () => {
		const descriptor = makeDescriptor({
			id: "rk-only",
			compatibleHardware: ["rk3588"],
		});
		seedList([descriptor], "n100");

		render(AddonsSection, { props: { open: true } });

		const note = await screen.findByTestId("addon-incompatible-rk-only");
		expect(note.textContent).toContain("rk3588");
		expect(note.textContent).toContain("n100");

		const sw = screen.getByTestId("addon-switch-rk-only") as HTMLButtonElement;
		expect(sw.disabled).toBe(true);
	});

	it("leaves a compatible add-on enabled (no incompatibility note)", async () => {
		const descriptor = makeDescriptor({
			id: "multi",
			compatibleHardware: ["n100", "generic"],
		});
		seedList([descriptor], "n100");

		render(AddonsSection, { props: { open: true } });

		const sw = (await screen.findByTestId(
			"addon-switch-multi",
		)) as HTMLButtonElement;
		expect(sw.disabled).toBe(false);
		expect(screen.queryByTestId("addon-incompatible-multi")).toBeNull();
	});
});

describe("AddonsSection — conflict warning", () => {
	it("pins a visible warning when an enable is blocked by addon_conflict", async () => {
		const descriptor = makeDescriptor({ id: "conflicting" });
		seedList([descriptor], "n100");
		rpcMocks.install.mockResolvedValue({
			success: false,
			error: "addon_conflict",
		} satisfies AddonOpResult);

		render(AddonsSection, { props: { open: true } });

		const sw = (await screen.findByTestId(
			"addon-switch-conflicting",
		)) as HTMLButtonElement;
		await fireEvent.click(sw);

		const warning = await screen.findByTestId("addon-conflict-conflicting");
		expect(warning.getAttribute("role")).toBe("alert");
		expect(warning.textContent?.toLowerCase()).toContain("conflict");
		// The op failed → the toggle reverts to off (pessimistic).
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));
	});
});

describe("AddonsSection — docs panel", () => {
	it("renders the descriptor docs and helpUrl behind the help affordance", async () => {
		const descriptor = makeDescriptor({
			id: "documented",
			docs: "Streams the secondary HDMI input as a picture-in-picture overlay.",
			helpUrl: "https://docs.example.com/pip",
		});
		seedList([descriptor], "n100");

		render(AddonsSection, { props: { open: true } });

		const toggle = await screen.findByTestId("addon-docs-toggle-documented");
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByTestId("addon-docs-documented")).toBeNull();

		await fireEvent.click(toggle);

		const panel = await screen.findByTestId("addon-docs-documented");
		expect(panel.textContent).toContain("picture-in-picture overlay");

		const link = screen.getByTestId(
			"addon-helpurl-documented",
		) as HTMLAnchorElement;
		expect(link.getAttribute("href")).toBe("https://docs.example.com/pip");
		expect(link.getAttribute("target")).toBe("_blank");
	});

	it("omits the help affordance for an add-on with no docs or helpUrl", async () => {
		const descriptor = makeDescriptor({ id: "bare" });
		seedList([descriptor], "n100");

		render(AddonsSection, { props: { open: true } });

		await screen.findByTestId("addon-card-bare");
		expect(screen.queryByTestId("addon-docs-toggle-bare")).toBeNull();
	});
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("AddonsSection — async state (osCommand)", () => {
	it("shows in-flight (switch disabled), blocks re-entry, then settles on success", async () => {
		const descriptor = makeDescriptor({ id: "media-pack" });
		seedList([descriptor], "n100");
		const d = deferred<AddonOpResult>();
		rpcMocks.install.mockReturnValueOnce(d.promise);

		render(AddonsSection, { props: { open: true } });
		const sw = (await screen.findByTestId(
			"addon-switch-media-pack",
		)) as HTMLButtonElement;
		expect(sw.disabled).toBe(false);

		await fireEvent.click(sw); // dispatch 1 → in flight
		await Promise.resolve();
		expect(rpcMocks.install).toHaveBeenCalledOnce();
		await waitFor(() => expect(sw.disabled).toBe(true));

		// A re-entrant toggle while pending must not dispatch a second install.
		await fireEvent.click(sw);
		await Promise.resolve();
		expect(rpcMocks.install).toHaveBeenCalledOnce();

		d.resolve({ success: true } satisfies AddonOpResult);
		await waitFor(() => expect(sw.disabled).toBe(false));
		expect(screen.queryByTestId("addons-unavailable")).toBeNull();
	});

	it("surfaces the calm unavailable banner, reverts, and releases re-entry in emulated mode", async () => {
		const descriptor = makeDescriptor({ id: "emu" });
		seedList([descriptor], "n100");
		rpcMocks.install.mockResolvedValue({
			success: false,
			error: "addon_unavailable_in_emulated_mode",
		} satisfies AddonOpResult);

		render(AddonsSection, { props: { open: true } });
		const sw = (await screen.findByTestId(
			"addon-switch-emu",
		)) as HTMLButtonElement;

		await fireEvent.click(sw);
		await screen.findByTestId("addons-unavailable");
		await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("false"));

		// Re-entry released → a second toggle dispatches again.
		await fireEvent.click(sw);
		await waitFor(() => expect(rpcMocks.install).toHaveBeenCalledTimes(2));
	});
});
