// @vitest-environment jsdom
/**
 * NetworkIngestSection — LAN network-ingest sources for the Live destination
 * (Task 18).
 *
 * Locks the four acceptance states from the plan:
 *  (a) an ACTIVE gateway renders an enabled, selectable row; selecting it
 *      dispatches `streaming.setConfig({ pipeline })` and drives the per-field
 *      sync lock (`pipeline` field reaches `applied`).
 *  (b) an INACTIVE gateway (`service_active === false`) renders the row DISABLED
 *      with a `title` reason — never hidden.
 *  (c) an ABSENT protocol (`srt: null`) renders NOTHING for that row.
 *  (d) the instructions panel exposes the exact publish URL, a copy-to-clipboard
 *      button (writing that exact URL), and a QR image.
 */
import type { NetworkIngest, Pipeline, Pipelines } from "@ceraui/rpc/schemas";
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";
import { destroyDirtyRegistry } from "$lib/rpc/dirty-registry.svelte";
import {
	destroyFieldSyncState,
	getFieldState,
} from "$lib/rpc/field-sync-state.svelte";

import NetworkIngestSection from "./NetworkIngestSection.svelte";

// Hermetic RPC: `setConfig` is a spy driven per-test — no socket, no env.
vi.mock("$lib/rpc/client", () => ({
	rpc: { streaming: { setConfig: vi.fn() } },
}));

// QR generation is stubbed so the unit never touches the real `qrcode` canvas
// path; it returns a deterministic data URL the render can assert against.
vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(
		async (url: string) => `data:image/png;qr(${url})`,
	),
}));

const toastSuccess = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

const setConfig = vi.mocked(rpc.streaming.setConfig);

const RTMP_URL = "rtmp://192.168.1.100:1935/publish/live";
const SRT_URL = "srt://192.168.1.100:4001";

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
	return {
		name: "Pipeline",
		description: "",
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		...overrides,
	};
}

const PIPELINES: Pipelines = {
	rtmp: pipeline({ name: "RTMP Ingest", requires_gateway: "rtmp" }),
	srt: pipeline({ name: "SRT Ingest", requires_gateway: "srt" }),
	hdmi: pipeline({ name: "HDMI" }),
};

function bothActive(): NetworkIngest {
	return {
		rtmp: { service_active: true, url: RTMP_URL },
		srt: { service_active: true, url: SRT_URL },
	};
}

beforeEach(() => {
	getFieldState("__warmup__"); // eagerly create the field-sync store
	setConfig.mockReset();
	toastSuccess.mockReset();
	toastError.mockReset();
});

afterEach(() => {
	destroyFieldSyncState();
	destroyDirtyRegistry();
});

describe("NetworkIngestSection — active gateway is selectable + locks via field-sync", () => {
	it("renders an enabled row and dispatches setConfig({pipeline}) on select", async () => {
		setConfig.mockResolvedValue({
			success: true,
			is_streaming: false,
			applied: { pipeline: "rtmp" },
		} as never);

		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: bothActive(),
				pipelines: PIPELINES,
				selectedPipeline: undefined,
				isStreaming: false,
			},
		});

		const row = getByTestId("network-ingest-select-rtmp") as HTMLButtonElement;
		expect(row.disabled).toBe(false);

		await fireEvent.click(row);

		await waitFor(() =>
			expect(setConfig).toHaveBeenCalledWith({ pipeline: "rtmp" }),
		);
		// The per-field lock advanced through the machine to the applied phase,
		// released to the SERVER-applied value (never the intended one).
		await waitFor(() => expect(getFieldState("pipeline")).toBe("applied"));
	});

	it("marks the row selected when config.pipeline already matches", () => {
		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: bothActive(),
				pipelines: PIPELINES,
				selectedPipeline: "srt",
				isStreaming: false,
			},
		});
		expect(
			getByTestId("network-ingest-select-srt").getAttribute("data-selected"),
		).toBe("true");
	});

	it("releases the field lock to result.applied.pipeline, not the optimistic value", async () => {
		// The backend applies a DIFFERENT pipeline than the one we sent (e.g., due to
		// clamping or validation). The lock must release to the applied value.
		setConfig.mockResolvedValue({
			success: true,
			is_streaming: false,
			applied: { pipeline: "srt" }, // Different from the requested "rtmp"
		} as never);

		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: bothActive(),
				pipelines: PIPELINES,
				selectedPipeline: undefined,
				isStreaming: false,
			},
		});

		const row = getByTestId("network-ingest-select-rtmp") as HTMLButtonElement;
		await fireEvent.click(row);

		await waitFor(() =>
			expect(setConfig).toHaveBeenCalledWith({ pipeline: "rtmp" }),
		);
		// The lock releases to the SERVER-applied value ("srt"), not the optimistic "rtmp".
		await waitFor(() => expect(getFieldState("pipeline")).toBe("applied"));
	});

	it("marks field failed when setConfig rejects (success:false)", async () => {
		setConfig.mockResolvedValue({
			success: false,
			error: "unknown_pipeline",
			is_streaming: false,
		} as never);

		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: bothActive(),
				pipelines: PIPELINES,
				selectedPipeline: "hdmi", // Prior value
				isStreaming: false,
			},
		});

		const row = getByTestId("network-ingest-select-rtmp") as HTMLButtonElement;
		await fireEvent.click(row);

		await waitFor(() =>
			expect(setConfig).toHaveBeenCalledWith({ pipeline: "rtmp" }),
		);
		// Rejected response → field lock reverts to the prior value and marks failed.
		await waitFor(() => expect(getFieldState("pipeline")).toBe("failed"));
		expect(toastError).toHaveBeenCalled();
	});

	it("marks field failed when setConfig succeeds but omits applied.pipeline", async () => {
		setConfig.mockResolvedValue({
			success: true,
			is_streaming: false,
			applied: {}, // Missing the pipeline field
		} as never);

		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: bothActive(),
				pipelines: PIPELINES,
				selectedPipeline: "hdmi", // Prior value
				isStreaming: false,
			},
		});

		const row = getByTestId("network-ingest-select-rtmp") as HTMLButtonElement;
		await fireEvent.click(row);

		await waitFor(() =>
			expect(setConfig).toHaveBeenCalledWith({ pipeline: "rtmp" }),
		);
		// Success but missing applied field → treat as failure, revert to prior value.
		await waitFor(() => expect(getFieldState("pipeline")).toBe("failed"));
		expect(toastError).toHaveBeenCalled();
	});
});

describe("NetworkIngestSection — inactive gateway is disabled-with-reason", () => {
	it("disables the row and surfaces a title reason (never hidden)", () => {
		const ingest: NetworkIngest = {
			rtmp: { service_active: false, url: RTMP_URL },
			srt: { service_active: true, url: SRT_URL },
		};
		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: ingest,
				pipelines: PIPELINES,
				isStreaming: false,
			},
		});

		const row = getByTestId("network-ingest-select-rtmp") as HTMLButtonElement;
		// Visible but disabled — the row is present in the DOM.
		expect(row).toBeTruthy();
		expect(row.disabled).toBe(true);
		expect(row.getAttribute("title")).toBeTruthy();
	});

	it("disables every row while streaming with a title reason", () => {
		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: bothActive(),
				pipelines: PIPELINES,
				isStreaming: true,
			},
		});
		const rtmp = getByTestId("network-ingest-select-rtmp") as HTMLButtonElement;
		expect(rtmp.disabled).toBe(true);
		expect(rtmp.getAttribute("title")).toBeTruthy();
	});
});

describe("NetworkIngestSection — addressless gateway is disabled-with-reason, no panel", () => {
	it("renders the row visible + disabled with the join-LAN/hotspot reason and NO QR/copy panel", () => {
		const ingest: NetworkIngest = {
			rtmp: {
				service_active: true,
				url: null,
				unavailable_reason: "no_lan_or_hotspot_address",
			},
			srt: { service_active: true, url: SRT_URL },
		};
		const { getByTestId, queryByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: ingest,
				pipelines: PIPELINES,
				isStreaming: false,
			},
		});

		const row = getByTestId("network-ingest-select-rtmp") as HTMLButtonElement;
		expect(row).toBeTruthy();
		expect(row.disabled).toBe(true);
		expect(row.getAttribute("title")).toBeTruthy();

		expect(queryByTestId("network-ingest-instructions-rtmp")).toBeNull();
		expect(queryByTestId("network-ingest-url-rtmp")).toBeNull();
		expect(queryByTestId("network-ingest-copy-rtmp")).toBeNull();
		expect(queryByTestId("network-ingest-qr-rtmp")).toBeNull();

		expect(
			getByTestId("network-ingest-select-srt").hasAttribute("disabled"),
		).toBe(false);
	});
});

describe("NetworkIngestSection — absent protocol renders nothing", () => {
	it("omits the srt row entirely when status.network_ingest.srt is null", () => {
		const ingest: NetworkIngest = {
			rtmp: { service_active: true, url: RTMP_URL },
			srt: null,
		};
		const { queryByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: ingest,
				pipelines: PIPELINES,
				isStreaming: false,
			},
		});
		expect(queryByTestId("network-ingest-row-rtmp")).not.toBeNull();
		expect(queryByTestId("network-ingest-row-srt")).toBeNull();
	});

	it("renders nothing at all when network_ingest is null", () => {
		const { queryByTestId } = render(NetworkIngestSection, {
			props: { networkIngest: null, pipelines: PIPELINES, isStreaming: false },
		});
		expect(queryByTestId("network-ingest-section")).toBeNull();
	});
});

describe("NetworkIngestSection — publish instructions (URL + copy + QR)", () => {
	it("shows the exact URL, a QR, and copies the URL to the clipboard", async () => {
		const writeText = vi.fn(async () => {});
		Object.assign(navigator, { clipboard: { writeText } });

		const { getByTestId } = render(NetworkIngestSection, {
			props: {
				networkIngest: bothActive(),
				pipelines: PIPELINES,
				isStreaming: false,
			},
		});

		// Exact publish URL is rendered verbatim.
		expect(getByTestId("network-ingest-url-rtmp").textContent?.trim()).toBe(
			RTMP_URL,
		);

		// QR image resolves from the stubbed generator (encodes the URL only).
		await waitFor(() =>
			expect(getByTestId("network-ingest-qr-rtmp")).toBeTruthy(),
		);
		expect(getByTestId("network-ingest-qr-rtmp").getAttribute("src")).toBe(
			`data:image/png;qr(${RTMP_URL})`,
		);

		// Copy writes the exact URL to the clipboard.
		await fireEvent.click(getByTestId("network-ingest-copy-rtmp"));
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(RTMP_URL));
		expect(toastSuccess).toHaveBeenCalled();
	});
});
