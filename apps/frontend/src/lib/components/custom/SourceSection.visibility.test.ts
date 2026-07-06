// @vitest-environment jsdom
import type {
	CaptureStreamSource,
	NetworkStreamSource,
	SourcesMessage,
	StreamSource,
	VirtualStreamSource,
} from "@ceraui/rpc/schemas";
import { render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

// QR generation is stubbed so the unit never touches the real `qrcode` canvas
// path (mirrors SourceSection.test.ts).
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

const setConfig = vi.hoisted(() =>
	vi.fn(async () => ({ success: true, applied: {} }) as unknown),
);
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

import { destroyFieldSyncState } from "$lib/rpc/field-sync-state.svelte";
import SourceSection from "./SourceSection.svelte";

// ── Fixtures ─────────────────────────────────────────────────────────────────
const RODE: CaptureStreamSource = {
	origin: "capture",
	id: "usb",
	pipelineId: "libuvch264",
	kind: "uvc_h264",
	displayName: "RØDE HDMI to USB-C: RØDE HDMI",
	devicePath: "/dev/video1",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};

const VIRTUAL_TEST: VirtualStreamSource = {
	origin: "virtual",
	id: "test",
	pipelineId: "test",
	labelKey: "settings.sources.test",
	modes: [],
	supportsAudio: false,
	supportsResolutionOverride: false,
	supportsFramerateOverride: false,
	audioKind: "none",
	available: true,
};

// The virtual test-pattern row the operator hid via Settings → Sources: backend
// marks it available:false with the DISTINCT disabledInSettings reason (Todo 6),
// reusing the SAME constant the network operator-disabled rows carry.
const DISABLED_IN_SETTINGS_REASON = "live.education.reason.disabledInSettings";
function virtualHidden(): VirtualStreamSource {
	return {
		...VIRTUAL_TEST,
		available: false,
		unavailableReason: DISABLED_IN_SETTINGS_REASON,
	};
}

// A virtual row unavailable for a DIFFERENT reason (not the settings toggle). The
// filter must key on the EXACT settings reason — this one must NOT be hidden.
function virtualGatewayReason(): VirtualStreamSource {
	return {
		...VIRTUAL_TEST,
		available: false,
		unavailableReason: "live.education.reason.gatewayInactive",
	};
}

// Operator-disabled network row (Task 9 regression fixture): available:false with
// the disabledInSettings reason — the network origin whose behavior must NOT drift.
function netRtmpDisabledInSettings(): NetworkStreamSource {
	return {
		origin: "network",
		id: "rtmp",
		pipelineId: "rtmp",
		labelKey: "settings.sources.rtmp",
		requiresGateway: "rtmp",
		url: null,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "embedded",
		available: false,
		unavailableReason: DISABLED_IN_SETTINGS_REASON,
	};
}

function sourcesMsg(list: StreamSource[]): SourcesMessage {
	return { hardware: "rk3588", sources: list };
}

function mount(props: Record<string, unknown> = {}) {
	return render(SourceSection, { props });
}

afterEach(() => {
	setConfig.mockReset();
	setConfig.mockResolvedValue({ success: true, applied: {} } as unknown);
	toastSuccess.mockClear();
	toastError.mockClear();
	destroyFieldSyncState();
});

describe("SourceSection — operator-hidden filtering generalizes to ANY origin (Todo 7)", () => {
	// (a) A hidden virtual row that is NOT the selected source is filtered out of
	// the picker — exactly like an operator-disabled network row.
	it("HIDES a virtual row with the disabledInSettings reason when it is NOT selected", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, virtualHidden()]),
			config: {},
		});
		expect(
			container.querySelector('[data-testid="source-select-test"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="source-row-test"]'),
		).toBeNull();
		// The healthy capture row is unaffected.
		expect(
			container.querySelector('[data-testid="source-row-usb"]'),
		).not.toBeNull();
	});

	// (b) When the hidden virtual row IS the selected source it stays VISIBLE,
	// disabled, with an origin-neutral reason line AND a Settings-hint line — the
	// same two-line treatment the operator-disabled network row gets, but with the
	// NEW origin-neutral testids (source.requiresGateway is undefined for virtual).
	it("KEEPS a hidden virtual row visible disabled-with-reason + Settings-hint when it IS the selected source", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, virtualHidden()]),
			config: { source: "test" },
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-select-test"]',
		);
		expect(btn).not.toBeNull();
		expect(btn?.disabled).toBe(true);
		expect(btn?.getAttribute("title")).toBeTruthy();
		// Origin-neutral reason + hint lines (NEW testids keyed on source.id).
		expect(
			container.querySelector('[data-testid="source-hidden-reason-test"]'),
		).not.toBeNull();
		expect(
			container.querySelector(
				'[data-testid="source-hidden-settings-hint-test"]',
			),
		).not.toBeNull();
	});

	// The filter keys on the EXACT settings reason: a virtual row unavailable for a
	// different reason (gateway-inactive) is NOT hidden — it renders disabled-with-
	// reason (via the button title), and gets NO Settings-hint line.
	it("does NOT hide a virtual row whose unavailableReason is a DIFFERENT reason", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, virtualGatewayReason()]),
			config: {},
		});
		const btn = container.querySelector<HTMLButtonElement>(
			'[data-testid="source-select-test"]',
		);
		expect(btn).not.toBeNull();
		expect(btn?.disabled).toBe(true);
		expect(btn?.getAttribute("title")).toBeTruthy();
		expect(
			container.querySelector(
				'[data-testid="source-hidden-settings-hint-test"]',
			),
		).toBeNull();
	});

	// (c) Network rows behave BYTE-IDENTICALLY to before: an operator-disabled
	// network row still hides when unselected and still uses its OWN
	// source-network-ingest-* testids when selected — never the new source-hidden-*
	// ones (truthfulness.spec compatibility).
	it("keeps operator-disabled NETWORK rows byte-identical (hidden when unselected)", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, netRtmpDisabledInSettings()]),
			config: {},
		});
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-select-rtmp"]',
			),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="source-row-rtmp"]'),
		).toBeNull();
	});

	it("keeps operator-disabled NETWORK rows on their OWN testids when selected (not source-hidden-*)", () => {
		const { container } = mount({
			sources: sourcesMsg([RODE, netRtmpDisabledInSettings()]),
			config: { source: "rtmp" },
		});
		// The network row keeps its existing reason + settings-hint testids…
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-reason-rtmp"]',
			),
		).not.toBeNull();
		expect(
			container.querySelector(
				'[data-testid="source-network-ingest-settings-hint-rtmp"]',
			),
		).not.toBeNull();
		// …and never adopts the origin-neutral (non-network) testids.
		expect(
			container.querySelector('[data-testid="source-hidden-reason-rtmp"]'),
		).toBeNull();
		expect(
			container.querySelector(
				'[data-testid="source-hidden-settings-hint-rtmp"]',
			),
		).toBeNull();
	});
});
