// @vitest-environment jsdom
/**
 * NetifDialog — the interface address is REPORTED with its provenance, and the
 * editable "Static IP address" field that used to sit here stays gone.
 *
 * This supersedes `NetifDialog.placeholder.test.ts`, which asserted the
 * placeholder of an input that has been removed. Measured on a Rock 5B+
 * (2026-08-16): saving a different address through that field toasted "Saved"
 * and changed nothing — `ip -br addr` byte-identical, the NetworkManager profile
 * still `ipv4.method: auto` with an empty `ipv4.addresses`, and no journal line.
 * The backend has no apply path at all (`handleNetif` reads `msg.ip` only as an
 * echo guard), so the control could not work on ANY interface. Its presence was
 * also destructive: a save that ALSO flipped the bond toggle was discarded
 * whole, because the edited address no longer matched the observed one.
 */
import { m } from "@ceraui/i18n/svelte";
import type { NetifEntry } from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import NetifDialog from "./NetifDialog.svelte";

vi.mock("$lib/helpers/NetworkHelper", () => ({ setNetif: vi.fn() }));

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
});

const wired = (over: Partial<NetifEntry> = {}): NetifEntry =>
	({ tp: 0, enabled: true, ip: "192.168.78.132", ...over }) as NetifEntry;

const routerCellular = (ip: string): NetifEntry =>
	wired({
		ip,
		router_cellular: {
			vendor: "Huawei",
			model: "E3372 LTE/UMTS/GSM HiLink Modem/Networkcard",
			vid_pid: "12d1:14dc",
			kind: "router-cellular",
			duplicate_model: true,
		},
	} as Partial<NetifEntry>);

function open(name: string, iface: NetifEntry | undefined) {
	render(NetifDialog, { props: { open: true, name, iface } });
}

const source = () =>
	document
		.querySelector('[data-testid="netif-address-source"]')
		?.textContent?.trim() ?? "";

describe("NetifDialog — the address is reported, never edited", () => {
	// The regression lock. A control that cannot act must not be re-offered on
	// ANY row — a dongle leases its address from its own NAT, and a real NIC has
	// no apply path behind the field either.
	it("offers no editable address control on any interface", () => {
		open("eth0", wired());

		expect(document.getElementById("netif-ip")).toBeNull();
		const editable = [
			...document.querySelectorAll<HTMLInputElement>("input"),
		].filter((el) => el.type !== "checkbox" && el.type !== "radio");
		expect(editable).toHaveLength(0);
	});

	it("shows the observed address", () => {
		open("eth0", wired());

		expect(
			document.querySelector('[data-testid="netif-address"]')?.textContent,
		).toContain("192.168.78.132");
	});

	it("says so plainly when the interface carries no address", () => {
		open("eth0", wired({ ip: undefined }));

		expect(
			document.querySelector('[data-testid="netif-address"]')?.textContent,
		).toContain(m["settings.dialogs.addressNone"]());
	});

	// Todo 43's classifier verdict is the capability signal, read off the SAME
	// netif field the row badge reads — never a second classification.
	it("names the dongle's own DHCP server on a router-cellular row", () => {
		open("enx0c5b8f279a64", routerCellular("192.168.8.100"));

		expect(source()).toBe(m["network.routerCellular.addressNote"]());
	});

	it("names DHCP on a real NIC", () => {
		open("eth0", wired());

		expect(source()).toBe(m["settings.dialogs.addressFromDhcp"]());
		expect(source()).not.toBe(m["network.routerCellular.addressNote"]());
	});

	// A 169.254/16 address is an automatic OS fallback. The existing notice is
	// retained; only the field it used to qualify is gone.
	it("keeps the link-local explanation and gives it its own source line", () => {
		open("eth0", wired({ ip: "169.254.12.9" }));

		expect(source()).toBe(m["settings.dialogs.addressLinkLocal"]());
		expect(
			document.querySelector('[data-testid="netif-link-local-notice"]'),
		).toBeTruthy();
	});

	// Guard against the tautology where a missing key resolves to its own path.
	it("resolves every source line from the catalog", () => {
		for (const resolved of [
			m["settings.dialogs.address"](),
			m["settings.dialogs.addressNone"](),
			m["settings.dialogs.addressFromDhcp"](),
			m["settings.dialogs.addressLinkLocal"](),
		]) {
			expect(resolved.startsWith("settings.dialogs.")).toBe(false);
		}
	});
});
