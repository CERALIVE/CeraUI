/// <reference types="vite/client" />
// @vitest-environment jsdom
import { UPDATE_PREFLIGHT_REASONS } from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	beginOperation,
	destroyAsyncOperations,
	getOperationPhase,
	initAsyncOperations,
	sweepOperations,
} from "../../lib/rpc/async-operation.svelte.ts";
import { rpc } from "../../lib/rpc/client.ts";
import { reactiveUpdateState } from "../../tests/fixtures/reactive-subscriptions.svelte.ts";
import UpdatesDialog from "./UpdatesDialog.svelte";

vi.mock("$lib/rpc/client", async (original) => ({
	...(await original<typeof import("../../lib/rpc/client.ts")>()),
	rpc: {
		system: {
			startUpdate: vi.fn(async () => ({ success: true })),
			checkForUpdates: vi.fn(async () => ({ success: true })),
		},
	},
}));
vi.mock("$lib/rpc/subscriptions.svelte", async () => {
	const { reactiveUpdateState: state } = await import(
		"../../tests/fixtures/reactive-subscriptions.svelte"
	);
	return { getUpdateState: () => state.value };
});
vi.mock("svelte-sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

const catalogs = import.meta.glob<Readonly<Record<string, unknown>>>(
	"../../../../../packages/i18n/messages/*.json",
	{ eager: true, import: "default" },
);
const english = catalogs["../../../../../packages/i18n/messages/en.json"];

beforeEach(() => {
	initAsyncOperations();
});
afterEach(() => {
	cleanup();
	destroyAsyncOperations();
	reactiveUpdateState.reset();
	vi.clearAllMocks();
});

describe("preflight terminal rendering", () => {
	it.each(UPDATE_PREFLIGHT_REASONS)(
		"renders %s as a refusal, never up-to-date or success",
		(preflight_reason) => {
			// Given a typed refusal; when rendered; then the operator sees its localized reason.
			reactiveUpdateState.value = {
				kind: "update_preflight_failed",
				preflight_reason,
			};
			render(UpdatesDialog, { open: true });
			const reason = document.querySelector(
				'[data-testid="update-preflight-reason"]',
			);
			expect(reason).not.toBeNull();
			expect(reason?.textContent?.trim()).toBe(
				english?.[
					`settings.updates.update_preflight_failed.${preflight_reason}`
				],
			);
			expect(document.body.textContent).not.toContain(preflight_reason);
			expect(
				document.querySelector('[data-testid="update-succeeded"]'),
			).toBeNull();
			expect(
				document.querySelector('[data-testid="update-retry"]'),
			).not.toBeNull();
		},
	);

	it("settles a fast preflight terminal before any progress paint", () => {
		// Given a pending start; when the first painted state is terminal; then no Applying/stalled survives.
		beginOperation("update");
		reactiveUpdateState.value = {
			kind: "update_preflight_failed",
			preflight_reason: "insufficient_space",
		};
		render(UpdatesDialog, { open: true });
		flushSync();
		expect(getOperationPhase("update")).not.toBe("pending");
		sweepOperations(Date.now() + 20_000);
		flushSync();
		expect(
			document.querySelector('[data-testid="update-start-refused"]'),
		).toBeNull();
		expect(document.body.textContent).not.toContain("Applying");
	});

	it("keeps success visible beside its optional cleanup warning", () => {
		// Given a successful install with failed cleanup; when rendered; then both facts survive.
		reactiveUpdateState.value = {
			kind: "success",
			cleanup_warning: "post_clean_failed",
		};
		render(UpdatesDialog, { open: true });
		expect(
			document.querySelector('[data-testid="update-succeeded"]'),
		).not.toBeNull();
		expect(
			document.querySelector('[data-testid="update-cleanup-warning"]'),
		).not.toBeNull();
		expect(
			document
				.querySelector('[data-testid="update-cleanup-warning"]')
				?.textContent?.trim(),
		).toBe(english?.["settings.updates.cleanup_warning.post_clean_failed"]);
	});

	it("re-checks through the existing RPC after a refusal", async () => {
		// Given a refusal; when Retry is clicked; then only the manual check is requested.
		reactiveUpdateState.value = {
			kind: "update_preflight_failed",
			preflight_reason: "probe_failed",
		};
		render(UpdatesDialog, { open: true });
		const button = document.querySelector('[data-testid="update-retry"]');
		if (!button) throw new Error("preflight retry missing");
		await fireEvent.click(button);
		expect(rpc.system.checkForUpdates).toHaveBeenCalledOnce();
		expect(rpc.system.startUpdate).not.toHaveBeenCalled();
	});

	it.each(Object.entries(catalogs))(
		"has complete and distinguishable localized reasons in %s",
		(_path, catalog) => {
			// Given each shipped locale; when enumerating the wire vocabulary; then no cause is unkeyed.
			const keys = [
				...UPDATE_PREFLIGHT_REASONS.map(
					(reason) => `settings.updates.update_preflight_failed.${reason}`,
				),
				"settings.updates.preflightFailedTitle",
				"settings.updates.cleanup_warning.post_clean_failed",
			];
			for (const key of keys) {
				expect(catalog[key]).toEqual(expect.any(String));
				expect(catalog[key]).not.toBe("");
			}
			expect(new Set(keys.map((key) => catalog[key])).size).toBe(keys.length);
		},
	);
});
