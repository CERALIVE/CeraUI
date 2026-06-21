// @vitest-environment jsdom
/**
 * LogsDialog — download progress + recovery (Todo 31).
 *
 * A failed log download surfaces a calm, inline amber retry band (not a bare,
 * easy-to-miss toast) and stays actionable: the Retry button re-invokes the same
 * download. A successful download shows no band.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import LogsDialog from "./LogsDialog.svelte";

const getDeviceLog = vi.hoisted(() => vi.fn());
const getSystemLog = vi.hoisted(() => vi.fn());

vi.mock("$lib/helpers/SystemHelper", () => ({ getDeviceLog, getSystemLog }));

// AppDialog picks its surface (Dialog vs Sheet) via `new MediaQuery(...)`, which
// reads `window.matchMedia` — absent in jsdom. Stub it to the desktop branch.
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
	getDeviceLog.mockReset();
	getSystemLog.mockReset();
});

describe("LogsDialog — download retry", () => {
	it("shows the retry band on failure and re-invokes the download on Retry", async () => {
		getDeviceLog
			.mockRejectedValueOnce(new Error("network down"))
			.mockResolvedValueOnce(undefined);

		render(LogsDialog, { props: { open: true } });

		await fireEvent.click(screen.getByTestId("log-download-device"));

		// Failure renders the calm inline band, not a swallowed error.
		expect(await screen.findByTestId("log-download-error")).toBeTruthy();
		expect(getDeviceLog).toHaveBeenCalledTimes(1);

		// Retry re-invokes the same download; success clears the band.
		await fireEvent.click(screen.getByTestId("log-download-retry"));
		expect(getDeviceLog).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(screen.queryByTestId("log-download-error")).toBeNull(),
		);
	});

	it("shows no retry band on a successful download", async () => {
		getDeviceLog.mockResolvedValue(undefined);

		render(LogsDialog, { props: { open: true } });

		await fireEvent.click(screen.getByTestId("log-download-device"));

		await waitFor(() => expect(getDeviceLog).toHaveBeenCalledTimes(1));
		expect(screen.queryByTestId("log-download-error")).toBeNull();
	});
});
