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
	logs: { deleteOlderFiles: vi.fn(), clearAll: vi.fn() },
	events: { clear: vi.fn() },
}));
vi.mock("$lib/rpc/client", () => ({ rpc }));

const copy = en.systemLogs.storage;

afterEach(() => {
	cleanup();
	vi.resetAllMocks();
});

it("asks before deleting older logs and leaves them alone on Cancel", async () => {
	render(StorageCleanup, {
		props: { storage: logStorage(), onrefresh: async () => {} },
	});
	await fireEvent.click(screen.getByRole("button", { name: copy.deleteOlder }));
	expect(rpc.logs.deleteOlderFiles).not.toHaveBeenCalled();
	const dialog = await screen.findByRole("alertdialog");
	const cancel = within(dialog).getByRole("button", { name: en.dialog.cancel });
	await waitFor(() => expect(document.activeElement).toBe(cancel));
	await fireEvent.click(cancel);
	expect(rpc.logs.deleteOlderFiles).not.toHaveBeenCalled();
});

it.each([
	[copy.clearAll, copy.clearAllConfirm, rpc.logs.clearAll],
	[copy.clearEvents, copy.clearEventsConfirm, rpc.events.clear],
])(
	"blocks %s confirmation while Delete older is pending",
	async (label, confirmLabel, clear) => {
		const deleting = Promise.withResolvers<unknown>();
		rpc.logs.deleteOlderFiles.mockReturnValue(deleting.promise);
		render(StorageCleanup, {
			props: { storage: logStorage(), onrefresh: async () => {} },
		});
		const older = screen.getByTestId<HTMLButtonElement>("storage-delete-older");
		await fireEvent.click(older);
		const deletingDialog = await screen.findByRole("alertdialog");
		await fireEvent.click(
			within(deletingDialog).getByRole("button", { name: copy.deleteOlder }),
		);
		await fireEvent.click(
			screen.getByRole("button", { name: label, hidden: true }),
		);
		const dialog = screen
			.getAllByRole("alertdialog", { hidden: true })
			.find((candidate) =>
				within(candidate).queryByRole("button", {
					name: confirmLabel,
					hidden: true,
				}),
			);
		if (!dialog) throw new Error("missing Clear dialog");
		const confirm = within(dialog).getByRole<HTMLButtonElement>("button", {
			name: confirmLabel,
			hidden: true,
		});

		await fireEvent.click(confirm);
		expect(clear).not.toHaveBeenCalled();
		expect(confirm.disabled).toBe(true);
		expect(older.getAttribute("aria-busy")).toBe("true");

		deleting.resolve({
			ok: true,
			storage: logStorage(),
			bootsBefore: 2,
			bootsAfter: 1,
		});
		await waitFor(() => expect(confirm.disabled).toBe(false));
	},
);

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
	const older = screen.getByTestId<HTMLButtonElement>("storage-delete-older");
	expect(older.disabled).toBe(true);

	refreshing.resolve();
	await waitFor(() => expect(older.disabled).toBe(false));
});
