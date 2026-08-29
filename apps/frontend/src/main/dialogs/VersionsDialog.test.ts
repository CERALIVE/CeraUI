// @vitest-environment jsdom
/**
 * Settings → Versions must report what is actually on the board.
 *
 * Two failures it now covers. The dialog used to render `srtla_send -v` verbatim
 * — `3.2.0 (unknown@unknown-dirty) [srtla_send]` — as one row's whole value,
 * beside three bare version numbers; and it had no row at all for the running
 * kernel or the cerastream engine, even though the engine version was already
 * arriving on every IPC `hello`.
 *
 * The engine row additionally cannot be served from the login-time push: the
 * engine is a separate systemd-owned process that can come up (or be upgraded)
 * after the operator has already logged in, so opening the dialog re-pulls.
 */

import type { Revisions } from "@ceraui/rpc/schemas";
import { render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { rpc } from "$lib/rpc/client";

import VersionsDialog from "./VersionsDialog.svelte";

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

const pushed: Revisions = {
	ceralive: "abc1234",
	srtla: "3.2.0 (main@974c8b9) [srtla_send]",
	bun: "1.4.0",
	kernel: "6.1.115-vendor-rk35xx",
	cerastream: "engine unreachable",
};

vi.mock("$lib/rpc/client", () => ({
	rpc: { system: { getRevisions: vi.fn(async () => pushed) } },
}));

vi.mock("$lib/rpc/subscriptions.svelte", () => ({
	getRevisions: () => pushed,
}));

afterEach(() => {
	vi.clearAllMocks();
});

function rowValue(container: HTMLElement, label: string): string[] {
	const term = [...container.querySelectorAll("dt")].find(
		(dt) => dt.textContent?.trim() === label,
	);
	if (!term) return [];
	const detail = term.nextElementSibling;
	return [...(detail?.querySelectorAll("span") ?? [])].map(
		(span) => span.textContent?.trim() ?? "",
	);
}

describe("VersionsDialog", () => {
	it("renders a kernel row and a cerastream engine row", async () => {
		render(VersionsDialog, { props: { open: true } });
		const container = document.body;
		await waitFor(() => {
			expect(rowValue(container, "Kernel")).toEqual(["6.1.115-vendor-rk35xx"]);
		});
		expect(rowValue(container, "cerastream")).toEqual(["engine unreachable"]);
	});

	it("promotes the SRTLA version and demotes its build metadata", async () => {
		render(VersionsDialog, { props: { open: true } });
		const container = document.body;
		await waitFor(() => {
			expect(rowValue(container, "SRTLA")).toEqual(["3.2.0", "main@974c8b9"]);
		});
	});

	// CeraUI's own row used to be a bare git short-SHA beside four real version
	// numbers, because the .deb stamped only the commit. It now carries the
	// packaged CalVer, and the commit rides the SAME `(...)` shape SRTLA already
	// uses — so the existing splitVersionValue handles it with no row-specific
	// branch and no wire change.
	it("promotes CeraUI's packaged version and demotes its commit", async () => {
		vi.mocked(rpc.system.getRevisions).mockResolvedValueOnce({
			...pushed,
			ceralive: "2026.8.5 (8738fd63)",
		});
		render(VersionsDialog, { props: { open: true } });
		const container = document.body;
		await waitFor(() => {
			expect(rowValue(container, "CeraUI")).toEqual(["2026.8.5", "8738fd63"]);
		});
	});

	it("still renders a dev checkout's bare commit as the whole value", async () => {
		render(VersionsDialog, { props: { open: true } });
		const container = document.body;
		await waitFor(() => {
			expect(rowValue(container, "CeraUI")).toEqual(["abc1234"]);
		});
	});

	it("re-pulls the versions on open so a late engine is not reported unreachable forever", async () => {
		vi.mocked(rpc.system.getRevisions).mockResolvedValueOnce({
			...pushed,
			cerastream: "2026.7.2",
		});
		render(VersionsDialog, { props: { open: true } });
		const container = document.body;
		await waitFor(() => {
			expect(rpc.system.getRevisions).toHaveBeenCalled();
		});
		await waitFor(() => {
			expect(rowValue(container, "cerastream")).toEqual(["2026.7.2"]);
		});
	});

	it("keeps the pushed snapshot readable when the refresh fails", async () => {
		vi.mocked(rpc.system.getRevisions).mockRejectedValueOnce(
			new Error("socket closed"),
		);
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		render(VersionsDialog, { props: { open: true } });
		const container = document.body;
		await waitFor(() => {
			expect(consoleError).toHaveBeenCalled();
		});
		expect(rowValue(container, "Kernel")).toEqual(["6.1.115-vendor-rk35xx"]);
		consoleError.mockRestore();
	});

	it("omits an optional row the device did not report", async () => {
		render(VersionsDialog, { props: { open: true } });
		const container = document.body;
		await waitFor(() => {
			expect(rowValue(container, "Kernel").length).toBeGreaterThan(0);
		});
		expect(rowValue(container, "CERALIVE Image")).toEqual([]);
	});
});
