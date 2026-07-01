// @vitest-environment jsdom
/**
 * ServerDialog — destination-first, latency-only model (receiver-coherence).
 *
 * The destination IS the provider (CeraLive / BELABOX / Custom). SRTLA is the
 * only transport; latency is the only knob. This suite locks: the three tiles and
 * the per-branch endpoint surface (custom form / managed selector / add-key
 * prompt), the honest transport row (no protocol radiogroup), latency-only tuning
 * (no FEC/recovery/presets), the streaming lock, and field-lock coverage — the
 * set locked via `markPending` BEFORE the RPC equals the set actually sent.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildServerSetConfig,
	type ServerSetDerived,
	type ServerSetDraft,
} from "$lib/streaming/receiver-experience";
import ServerDialog from "./ServerDialog.svelte";

type ServerInfo = {
	name: string;
	rtt?: number;
	default?: true;
	addr?: string;
	port?: number;
	protocol?: string;
};

const state = vi.hoisted(() => ({
	config: undefined as
		| {
				relay_server?: string;
				relay_account?: string;
				relay_streamid_override?: string;
				srtla_addr?: string;
				srtla_port?: number;
				srt_streamid?: string;
				srt_latency?: number;
				remote_provider?: string;
		  }
		| undefined,
	relays: undefined as
		| {
				accounts: Record<string, { name: string }>;
				servers: Record<string, ServerInfo>;
		  }
		| undefined,
	isStreaming: false,
	capabilities: undefined as { transports?: string[] } | undefined,
}));

const setConfig = vi.hoisted(() => vi.fn());
const relayValidate = vi.hoisted(() => vi.fn());
const markPending = vi.hoisted(() => vi.fn());
const onRpcResolved = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

const noop = vi.hoisted(
	() => async () =>
		({
			default: (await import("../../tests/fixtures/Noop.svelte")).default,
		}) as {
			default: unknown;
		},
);
vi.mock("./CloudRemoteDialog.svelte", noop);

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getConfig: () => state.config,
	getRelays: () => state.relays,
	getIsStreaming: () => state.isStreaming,
	getCapabilities: () => state.capabilities,
	getManagedIngestAccounts: () => [],
	getSelectedIngestEndpoint: () => undefined,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig }, relay: { validate: relayValidate } },
}));

vi.mock("$lib/rpc/dirty-registry.svelte", () => ({
	markPending,
	onRpcResolved,
}));

vi.mock("svelte-sonner", () => ({ toast }));

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

beforeEach(() => {
	state.config = undefined;
	state.relays = undefined;
	state.isStreaming = false;
	state.capabilities = undefined;
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} });
	relayValidate.mockReset();
	relayValidate.mockResolvedValue({ valid: true, stage: "probe" });
	markPending.mockReset();
	onRpcResolved.mockReset();
	toast.success.mockReset();
	toast.error.mockReset();
});

const lockedFields = (fn: ReturnType<typeof vi.fn>): string[] =>
	fn.mock.calls.map((call) => call[0] as string).sort();

const saveButton = () =>
	screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;

async function typeInto(id: string, value: string) {
	const el = document.getElementById(id) as HTMLInputElement;
	await fireEvent.input(el, { target: { value } });
}

function draftOf(overrides: Partial<ServerSetDraft> = {}): ServerSetDraft {
	return {
		latency: 2000,
		protocol: "srtla",
		addr: "",
		portStr: "",
		streamId: "",
		relayStreamId: "",
		relayServer: "",
		relayAccount: "",
		...overrides,
	};
}

describe("ServerDialog — destination tiles + transport row", () => {
	it("shows the transport row per-provider: CeraLive + Custom yes, BeLABOX no", async () => {
		render(ServerDialog, { props: { open: true } });
		expect(screen.getByTestId("destination-ceralive")).toBeTruthy();
		expect(screen.getByTestId("destination-belabox")).toBeTruthy();
		expect(screen.getByTestId("destination-custom")).toBeTruthy();

		// Managed default (ceralive): the honest transport row IS shown — CeraLive
		// has a RIST/SRT roadmap (SRTLA active + RIST/SRT coming-soon pills).
		expect(screen.queryByTestId("transport-row")).not.toBeNull();
		expect(screen.getByTestId("transport-srtla")).toBeTruthy();
		expect(screen.getByTestId("transport-rist")).toBeTruthy();
		expect(screen.getByTestId("transport-srt")).toBeTruthy();

		// BeLABOX: SRTLA-only receiver, no RIST/SRT roadmap → the row is hidden.
		await fireEvent.click(screen.getByTestId("destination-belabox"));
		await waitFor(() =>
			expect(screen.queryByTestId("transport-row")).toBeNull(),
		);
		expect(screen.queryByTestId("transport-srtla")).toBeNull();
		expect(screen.queryByTestId("transport-rist")).toBeNull();
		expect(screen.queryByTestId("transport-srt")).toBeNull();

		// Custom: the honest transport row appears again (SRTLA active + RIST/SRT pills).
		await fireEvent.click(screen.getByTestId("destination-custom"));
		await waitFor(() =>
			expect(screen.queryByTestId("transport-row")).not.toBeNull(),
		);
		expect(screen.getByTestId("transport-srtla")).toBeTruthy();
		expect(screen.getByTestId("transport-rist")).toBeTruthy();
		expect(screen.getByTestId("transport-srt")).toBeTruthy();
	});

	it("has no protocol radiogroup and no stream-tuning card", async () => {
		render(ServerDialog, { props: { open: true } });
		expect(screen.queryByTestId("transport-protocol")).toBeNull();
		expect(screen.queryByTestId("stream-tuning")).toBeNull();
		expect(document.querySelector('[role="radio"][data-protocol]')).toBeNull();
		expect(screen.getByTestId("latency-section")).toBeTruthy();

		// Even with the row visible on Custom, there is no protocol radiogroup.
		await fireEvent.click(screen.getByTestId("destination-custom"));
		await waitFor(() =>
			expect(screen.queryByTestId("transport-row")).not.toBeNull(),
		);
		expect(screen.queryByTestId("transport-protocol")).toBeNull();
		expect(document.querySelector('[role="radio"][data-protocol]')).toBeNull();
	});

	it("shows the add-key prompt when picking a cloud the device has no key for", async () => {
		state.config = { remote_provider: "ceralive" };
		state.relays = { accounts: {}, servers: { fra: { name: "Frankfurt" } } };
		render(ServerDialog, { props: { open: true } });

		await fireEvent.click(screen.getByTestId("destination-belabox"));
		await waitFor(() =>
			expect(screen.queryByTestId("destination-needs-key")).not.toBeNull(),
		);
		expect(screen.getByTestId("destination-add-key")).toBeTruthy();
		expect(saveButton().disabled).toBe(true);
	});
});

describe("ServerDialog — latency-only save + field-lock coverage", () => {
	it("custom: locks EXACTLY the keys buildServerSetConfig sends (no fec/recovery)", async () => {
		render(ServerDialog, { props: { open: true } });

		await fireEvent.click(screen.getByTestId("destination-custom"));
		await typeInto("srtla-addr", "custom.example");
		await typeInto("srtla-port", "5000");

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());
		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

		const derived: ServerSetDerived = { destination: "custom" };
		const expected = buildServerSetConfig(
			draftOf({ addr: "custom.example", portStr: "5000" }),
			derived,
		);
		const expectedKeys = Object.keys(expected).sort();
		const sent = setConfig.mock.calls[0]?.[0] as Record<string, unknown>;

		expect(expected).not.toHaveProperty("fec_enabled");
		expect(expected).not.toHaveProperty("recovery_mode");
		expect(lockedFields(markPending)).toEqual(expectedKeys);
		expect(Object.keys(sent).sort()).toEqual(expectedKeys);
		expect(lockedFields(onRpcResolved)).toEqual(expectedKeys);
	});

	it("managed relay (keyed cloud): saves the relay field set + clears any stale slot", async () => {
		state.relays = {
			accounts: {},
			servers: { "srv-eu": { name: "EU West", default: true } },
		};
		state.config = { remote_provider: "ceralive", relay_server: "srv-eu" };

		render(ServerDialog, { props: { open: true } });

		await waitFor(() => expect(saveButton().disabled).toBe(false));
		await fireEvent.click(saveButton());
		await waitFor(() => expect(setConfig).toHaveBeenCalledTimes(1));

		const sent = setConfig.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(sent.relay_server).toBe("srv-eu");
		expect(sent.relay_protocol).toBe("srtla");
		expect(sent.selected_ingest_endpoint).toBe("");
		expect(sent).not.toHaveProperty("srtla_addr");
		expect(sent).toHaveProperty("relay_streamid_override", "");
	});
});

describe("ServerDialog — streaming lock", () => {
	it("locks the dialog and disables Save while streaming", () => {
		state.config = { srtla_addr: "custom.example", srtla_port: 5000 };
		state.isStreaming = true;
		render(ServerDialog, { props: { open: true } });
		expect(saveButton().disabled).toBe(true);
		const slider = screen.getByTestId("latency-slider") as HTMLInputElement;
		expect(slider.disabled).toBe(true);
	});
});
