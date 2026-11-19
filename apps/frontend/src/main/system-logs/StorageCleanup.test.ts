// @vitest-environment jsdom
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/svelte";
import { afterEach, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";
import { logStorage } from "./__fixtures__/log-storage";
import StorageCleanup from "./StorageCleanup.svelte";

const rpc = vi.hoisted(() => ({
	logs: { clearAll: vi.fn() },
	events: { clear: vi.fn() },
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));

const copy = en.systemLogs.storage;

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

it("offers only Clear all logs and Clear event history when there are no leftover debug files", () => {
	render(StorageCleanup, {
		props: { storage: logStorage(), onrefresh: async () => {} },
	});
	const actions = within(screen.getByTestId("storage-cleanup"));
	expect(actions.getAllByRole("button")).toEqual([
		actions.getByRole("button", { name: copy.clearAll }),
		actions.getByRole("button", { name: copy.clearEvents }),
	]);
});

it("reports the boot counts returned after clearing all logs", async () => {
	rpc.logs.clearAll.mockResolvedValue({
		ok: true,
		storage: logStorage(),
		bootsBefore: 3,
		bootsAfter: 1,
	});
	render(StorageCleanup, {
		props: { storage: logStorage(), onrefresh: async () => {} },
	});
	await fireEvent.click(screen.getByRole("button", { name: copy.clearAll }));
	const dialog = await screen.findByRole("alertdialog");
	await fireEvent.click(
		within(dialog).getByRole("button", { name: copy.clearAllConfirm }),
	);
	await waitFor(() =>
		expect(screen.getByRole("status").textContent?.trim()).toBe(
			copy.clearAllResult.replace("{before}", "3").replace("{after}", "1"),
		),
	);
});

it("holds cleanup actions until the event-clear storage refresh finishes", async () => {
	const refreshing = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	rpc.events.clear.mockResolvedValue({ success: true });
	render(StorageCleanup, {
		props: {
			storage: logStorage(),
			onrefresh: () => {
				started.resolve();
				return refreshing.promise;
			},
		},
	});

	await fireEvent.click(screen.getByRole("button", { name: copy.clearEvents }));
	const dialog = await screen.findByRole("alertdialog");
	await fireEvent.click(
		within(dialog).getByRole("button", { name: copy.clearEventsConfirm }),
	);
	await started.promise;
	const clear = screen.getByRole("button", {
		name: copy.clearAll,
		hidden: true,
	});
	await fireEvent.click(clear);
	const confirm = within(
		screen.getByRole("alertdialog", { name: copy.clearAllTitle, hidden: true }),
	).getByRole<HTMLButtonElement>("button", {
		name: copy.clearAllConfirm,
	});
	expect(confirm.disabled).toBe(true);

	refreshing.resolve();
	await waitFor(() => expect(confirm.disabled).toBe(false));
});
