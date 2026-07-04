// @vitest-environment jsdom
/**
 * SourceSection — applied-state acknowledgement contract (F2 field-lock fix).
 *
 * The repo-wide rule (apps/frontend/AGENTS.md → "Applied-state acknowledgement"):
 * after an RPC setter resolves, the frontend releases the field lock to
 * `result.applied` — the value the BACKEND actually wrote after clamp/validation —
 * NEVER the optimistic value the client sent. A setter that fails
 * (`success:false`, e.g. `{error:'unknown_source'}`, which carries no populated
 * `applied.source`) or omits the field from `applied` must call `markFieldFailed`,
 * never `markFieldApplied` with a guessed value.
 *
 * The sibling `SourceSection.test.ts` drives the REAL field-sync machine and can
 * only observe the phase (`applying → applied | failed`); it cannot prove WHICH
 * value the lock released to. This file mocks the field-sync store so the exact
 * `markFieldApplied` / `markFieldFailed` call arguments are asserted — proving the
 * applied value (not the requested id) is what the lock is released to.
 */
import type {
	CoarseStreamSource,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { fireEvent, render } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/helpers/NetworkHelper", () => ({
	generateDeviceAccessQr: vi.fn(
		async (url: string) => `data:image/png;qr(${url})`,
	),
}));

const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock("svelte-sonner", () => ({
	toast: { success: toastSuccess, error: toastError },
}));

// The source-selection RPC — its resolved shape drives the applied-check branch.
const setConfig = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc", () => ({
	rpc: { streaming: { setConfig } },
	rpcClient: {},
}));

// Spy the field-sync store so the EXACT release-value can be asserted. Read-only
// selectors (getFieldState/isFieldApplying) are stubbed to keep FieldSyncIndicator
// and the SourceSection markup rendering.
const beginFieldSync = vi.hoisted(() => vi.fn());
const markFieldApplying = vi.hoisted(() => vi.fn());
const markFieldApplied = vi.hoisted(() => vi.fn());
const markFieldFailed = vi.hoisted(() => vi.fn());
vi.mock("$lib/rpc/field-sync-state.svelte", () => ({
	beginFieldSync,
	markFieldApplying,
	markFieldApplied,
	markFieldFailed,
	getFieldState: () => "idle",
	isFieldApplying: () => false,
}));

import SourceSection from "./SourceSection.svelte";

const COARSE_HDMI: CoarseStreamSource = {
	origin: "coarse",
	id: "hdmi",
	pipelineId: "hdmi",
	labelKey: "settings.sources.hdmi",
	modes: [],
	supportsAudio: true,
	supportsResolutionOverride: true,
	supportsFramerateOverride: true,
	audioKind: "selectable",
	available: true,
};

function sourcesMsg(list: StreamSource[]): SourcesMessage {
	return { hardware: "rk3588", sources: list };
}

function mount(props: Record<string, unknown> = {}) {
	return render(SourceSection, { props });
}

async function clickHdmi(container: HTMLElement): Promise<void> {
	const btn = container.querySelector<HTMLButtonElement>(
		'[data-testid="source-select-hdmi"]',
	);
	if (!btn) throw new Error("source-select-hdmi button not rendered");
	await fireEvent.click(btn);
	// Let the awaited setConfig + the post-resolve applied-check microtasks flush.
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	setConfig.mockReset();
	beginFieldSync.mockReset();
	markFieldApplying.mockReset();
	markFieldApplied.mockReset();
	markFieldFailed.mockReset();
	toastError.mockClear();
	toastSuccess.mockClear();
});

describe("SourceSection — source lock releases to result.applied, never the optimistic id", () => {
	it("a REJECTED setConfig ({success:false, error:'unknown_source'}) calls markFieldFailed, NOT markFieldApplied with the client id", async () => {
		setConfig.mockResolvedValue({ success: false, error: "unknown_source" });
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: { source: "test" },
		});

		await clickHdmi(container);

		expect(setConfig).toHaveBeenCalledWith({ source: "hdmi" });
		// The optimistic id ('hdmi') must NEVER be released as an applied value.
		expect(markFieldApplied).not.toHaveBeenCalled();
		// The lock reverts to the prior authoritative config value ('test').
		expect(markFieldFailed).toHaveBeenCalledWith("source", "test");
		expect(toastError).toHaveBeenCalled();
	});

	it("a SUCCESS that OMITS applied.source is treated as unconfirmed (markFieldFailed, not markFieldApplied)", async () => {
		setConfig.mockResolvedValue({ success: true, applied: {} });
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: { source: "test" },
		});

		await clickHdmi(container);

		expect(markFieldApplied).not.toHaveBeenCalled();
		expect(markFieldFailed).toHaveBeenCalledWith("source", "test");
		expect(toastError).toHaveBeenCalled();
	});

	it("a SUCCESSFUL setConfig releases to result.applied.source — the BACKEND value, even when it differs from the requested id", async () => {
		// The backend clamps/normalizes the requested 'hdmi' to 'hdmi-normalized'.
		// The lock MUST release to that applied value, NOT the optimistic 'hdmi'.
		setConfig.mockResolvedValue({
			success: true,
			applied: { source: "hdmi-normalized" },
		});
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: { source: "test" },
		});

		await clickHdmi(container);

		expect(setConfig).toHaveBeenCalledWith({ source: "hdmi" });
		expect(markFieldApplied).toHaveBeenCalledWith("source", "hdmi-normalized");
		// Proves the APPLIED value drove the release, not the requested id…
		expect(markFieldApplied).not.toHaveBeenCalledWith("source", "hdmi");
		expect(markFieldFailed).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("a THROWN setConfig reverts the lock to the prior config value (markFieldFailed)", async () => {
		setConfig.mockRejectedValue(new Error("transport down"));
		const { container } = mount({
			sources: sourcesMsg([COARSE_HDMI]),
			config: { source: "test" },
		});

		await clickHdmi(container);

		expect(markFieldApplied).not.toHaveBeenCalled();
		expect(markFieldFailed).toHaveBeenCalledWith("source", "test");
		expect(toastError).toHaveBeenCalled();
	});
});
