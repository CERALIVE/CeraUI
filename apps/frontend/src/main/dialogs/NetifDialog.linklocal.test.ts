// @vitest-environment jsdom
/**
 * NetifDialog — link-local (169.254/16) clarity (plan Todo 52).
 *
 * On a CeraLive device the wired port always carries an automatic 169.254.x.x
 * link-local address. It used to be REMOVED from the dialog's "Static IP" field,
 * because echoing it into an input made it read as a saved static config the
 * operator set and "can't clear". Todo 47 retired that input — it had no apply
 * path on any interface — so the address is now REPORTED rather than offered,
 * and hiding it would be its own dishonesty: the address really is on the
 * interface. The clarity requirement is unchanged and moves to the source line
 * plus the existing notice. This suite proves:
 *  - a link-local address is shown, attributed to the OS, and keeps its notice;
 *  - a routable address is shown, attributed to DHCP, and shows no notice.
 */
import { m } from "@ceraui/i18n/svelte";
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { render, screen, waitFor } from "@testing-library/svelte";
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

import NetifDialog from "./NetifDialog.svelte";

// Hermetic RPC: NetifDialog imports the `rpc` barrel, so mock `$lib/rpc`.
vi.mock("$lib/rpc", () => ({
	rpc: { network: { configure: vi.fn() } },
}));
vi.mock("svelte-sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}));

function iface(overrides: Partial<NetifEntry> = {}): NetifEntry {
	return { ip: "", tp: 0, enabled: true, ...overrides };
}

const address = () => screen.getByTestId("netif-address").textContent ?? "";
const addressSource = () =>
	screen.getByTestId("netif-address-source").textContent?.trim() ?? "";

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

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	destroyAsyncOperations();
});

describe("NetifDialog — link-local address clarity (Todo 52)", () => {
	it("attributes a link-local address to the OS and keeps the notice", async () => {
		render(NetifDialog, {
			props: {
				open: true,
				name: "eth0",
				iface: iface({ ip: "169.254.149.160" }),
			},
		});

		await waitFor(() => expect(address()).toContain("169.254.149.160"));
		expect(addressSource()).toBe(m["settings.dialogs.addressLinkLocal"]());
		expect(screen.getByTestId("netif-link-local-notice")).toBeTruthy();
		// No input can present it as a saved static config any more.
		expect(document.querySelector("input:not([type='checkbox'])")).toBeNull();
	});

	it("attributes a routable address to DHCP and shows no notice", async () => {
		render(NetifDialog, {
			props: {
				open: true,
				name: "eth0",
				iface: iface({ ip: "192.168.78.131" }),
			},
		});

		await waitFor(() => expect(address()).toContain("192.168.78.131"));
		expect(addressSource()).toBe(m["settings.dialogs.addressFromDhcp"]());
		expect(screen.queryByTestId("netif-link-local-notice")).toBeNull();
	});
});
