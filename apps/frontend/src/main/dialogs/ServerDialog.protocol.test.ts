// @vitest-environment jsdom
/**
 * ServerDialog — transport-protocol selector behind the Advanced disclosure.
 *
 * The destination-first rewrite (T9) demotes the transport-protocol radiogroup
 * out of the always-visible top level: it now lives inside the TransportBadge
 * (T8) "Advanced" disclosure and is mounted only while expanded ({#if expanded},
 * not CSS-hidden). On open there is therefore NO transport radiogroup in the DOM
 * at all — only the destination radiogroup. Expanding Advanced mounts it.
 *
 * Inside that group: SRTLA is always selectable; RIST is capability-gated
 * (disabled-with-reason until the engine advertises the `rist` transport); and
 * plain-SRT is a calm, INERT ComingSoon affordance — never a fake-interactive
 * radio (the old reserved disabled-button treatment is replaced).
 *
 * Coverage:
 *  1. (Requirement i) On open the transport radiogroup is absent — by testid AND
 *     by a role-agnostic named-role backstop — and present after expanding.
 *  2. The Advanced trigger toggles aria-expanded false→true on open.
 *  3. SRTLA always enabled; SRT is an inert ComingSoon cell (not a button/radio).
 *  4. RIST disabled-with-reason without the rist transport; enabled with it.
 *  5. Protocol persistence: picking RIST persists relay_protocol=rist; the
 *     untouched SRTLA default persists relay_protocol=srtla.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import ServerDialog from "./ServerDialog.svelte";

const state = vi.hoisted(() => ({
	config: undefined as { relay_protocol?: string } | undefined,
	relays: undefined as
		| {
				accounts: Record<string, { name: string }>;
				servers: Record<string, { name: string; rtt?: number; default?: true }>;
		  }
		| undefined,
	isStreaming: false,
	capabilities: undefined as { transports?: string[] } | undefined,
}));

const setConfig = vi.hoisted(() => vi.fn());

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
	getRelays: () => state.relays,
	getIsStreaming: () => state.isStreaming,
	getCapabilities: () => state.capabilities,
	getManagedIngestAccounts: () => [],
	getSelectedIngestEndpoint: () => undefined,
}));

// Protocol behaviour is tested with a paired managed device; the pairing gate
// itself lives in pairing.svelte.test.ts.
vi.mock("$lib/stores/pairing.svelte", () => ({
	isPairedToManagedCloud: () => true,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig }, relay: { validate: vi.fn() } },
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending: vi.fn(),
	onRpcResolved: vi.fn(),
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
});

// The transport radiogroup's accessible name (aria-label) — distinct from the
// destination radiogroup, so a named-role query targets ONLY the transport one
// without depending on its data-testid (the role-agnostic backstop).
const TRANSPORT_GROUP = "Transport Protocol";

// The Advanced disclosure trigger drives the radiogroup mount; target it by the
// aria-controls relationship so the test never depends on its label copy.
const advancedTrigger = () =>
	document.querySelector(
		'[aria-controls="transport-protocol"]',
	) as HTMLButtonElement;

async function expandAdvanced() {
	await fireEvent.click(advancedTrigger());
	await waitFor(() =>
		expect(screen.getByTestId("transport-protocol")).toBeTruthy(),
	);
}

const ristButton = () =>
	screen.getByTestId("protocol-rist") as HTMLButtonElement;
const srtlaButton = () =>
	screen.getByTestId("protocol-srtla") as HTMLButtonElement;

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} });
});

describe("ServerDialog — transport protocol behind Advanced (T10)", () => {
	it("hides the transport radiogroup on open and mounts it only after expanding Advanced", async () => {
		render(ServerDialog, { props: { open: true } });

		// Requirement (i): the transport radiogroup is absent on open — proven by
		// its testid AND by a role-agnostic named-role backstop. The destination
		// radiogroup is the only radiogroup present (sanity).
		expect(screen.queryByTestId("transport-protocol")).toBeNull();
		expect(
			screen.queryByRole("radiogroup", { name: TRANSPORT_GROUP }),
		).toBeNull();
		expect(
			screen.getByRole("radiogroup", { name: "Destination" }),
		).toBeTruthy();

		// The Advanced trigger starts collapsed.
		expect(advancedTrigger().getAttribute("aria-expanded")).toBe("false");

		await expandAdvanced();

		// Expanding mounts the group — visible by both testid and role.
		expect(screen.getByTestId("transport-protocol")).toBeTruthy();
		expect(
			screen.getByRole("radiogroup", { name: TRANSPORT_GROUP }),
		).toBeTruthy();
		expect(advancedTrigger().getAttribute("aria-expanded")).toBe("true");
	});

	it("renders SRTLA enabled and SRT as an inert ComingSoon affordance (not a radio)", async () => {
		render(ServerDialog, { props: { open: true } });
		await expandAdvanced();

		// SRTLA is always selectable.
		expect(srtlaButton().disabled).toBe(false);
		expect(srtlaButton().getAttribute("role")).toBe("radio");

		// SRT is no longer a disabled button — it is a calm ComingSoon cell that
		// performs no action: not a <button>, no radio role, and carrying the
		// roadmap data-debt-id its ComingSoon pill renders.
		const srt = screen.getByTestId("protocol-srt");
		expect(srt.tagName).not.toBe("BUTTON");
		expect(srt.getAttribute("role")).not.toBe("radio");
		expect(srt.querySelector("[data-debt-id]")).not.toBeNull();
		expect(
			srt.querySelector('[data-debt-id="TD-plain-srt-egress"]'),
		).not.toBeNull();
	});

	it("disables RIST with a reason when the engine advertises no rist transport", async () => {
		state.capabilities = { transports: ["srtla"] };

		render(ServerDialog, { props: { open: true } });
		await expandAdvanced();

		expect(ristButton().disabled).toBe(true);
		expect(ristButton().getAttribute("title")).toBe(
			"RIST is not available on this device",
		);
	});

	it("enables RIST when the engine advertises the rist transport", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };

		render(ServerDialog, { props: { open: true } });
		await expandAdvanced();

		expect(ristButton().disabled).toBe(false);
		expect(ristButton().getAttribute("title")).toBeNull();
	});

	it("selects RIST and persists relay_protocol=rist on save when available", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };
		state.config = { relay_protocol: "srtla" };

		render(ServerDialog, { props: { open: true } });
		await expandAdvanced();

		await fireEvent.click(ristButton());
		expect(ristButton().getAttribute("aria-checked")).toBe("true");

		const addr = document.getElementById("srtla-addr") as HTMLInputElement;
		const port = document.getElementById("srtla-port") as HTMLInputElement;
		await fireEvent.input(addr, { target: { value: "rist.example.com" } });
		await fireEvent.input(port, { target: { value: "5000" } });

		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() =>
			expect((save as HTMLButtonElement).disabled).toBe(false),
		);
		await fireEvent.click(save);

		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
		expect(setConfig.mock.calls[0]?.[0]).toMatchObject({
			relay_protocol: "rist",
		});
	});

	it("keeps SRTLA selected and persists relay_protocol=srtla (unaffected)", async () => {
		state.capabilities = { transports: ["srtla", "rist"] };

		render(ServerDialog, { props: { open: true } });
		await expandAdvanced();

		expect(srtlaButton().getAttribute("aria-checked")).toBe("true");

		const addr = document.getElementById("srtla-addr") as HTMLInputElement;
		const port = document.getElementById("srtla-port") as HTMLInputElement;
		await fireEvent.input(addr, { target: { value: "srtla.example.com" } });
		await fireEvent.input(port, { target: { value: "5000" } });

		const save = screen.getByRole("button", { name: "Save" });
		await waitFor(() =>
			expect((save as HTMLButtonElement).disabled).toBe(false),
		);
		await fireEvent.click(save);

		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));
		expect(setConfig.mock.calls[0]?.[0]).toMatchObject({
			relay_protocol: "srtla",
		});
	});
});
