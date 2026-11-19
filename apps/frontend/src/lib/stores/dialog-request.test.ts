import { beforeEach, describe, expect, it, vi } from "vitest";

const navigateToDestination = vi.hoisted(() => vi.fn());
vi.mock("$lib/stores/navigation-lazy", () => ({ navigateToDestination }));

import {
	clearRequestedDialog,
	getRequestedDialog,
	getRequestedDialogContext,
	requestDialog,
} from "./dialog-request.svelte";

beforeEach(() => {
	clearRequestedDialog();
	navigateToDestination.mockReset();
});

describe("dialog-request", () => {
	it("holds an updates-dialog request with no context and switches to Settings, as before", async () => {
		requestDialog("updates-dialog");

		expect(getRequestedDialog()).toBe("updates-dialog");
		expect(getRequestedDialogContext()).toBeUndefined();
		await vi.dynamicImportSettled();
		expect(navigateToDestination).toHaveBeenCalledTimes(1);
		expect(navigateToDestination).toHaveBeenCalledWith("settings");
	});

	it("holds a logs request with its context and switches to Settings", async () => {
		requestDialog("logs", { tab: "raw", at: 1_700_000_000_000 });

		expect(getRequestedDialog()).toBe("logs");
		expect(getRequestedDialogContext()).toEqual({
			tab: "raw",
			at: 1_700_000_000_000,
		});
		await vi.dynamicImportSettled();
		expect(navigateToDestination).toHaveBeenCalledTimes(1);
		expect(navigateToDestination).toHaveBeenCalledWith("settings");
	});

	it("replaces an earlier request, context included", () => {
		requestDialog("logs", { tab: "raw", at: 1 });
		requestDialog("updates-dialog");

		expect(getRequestedDialog()).toBe("updates-dialog");
		expect(getRequestedDialogContext()).toBeUndefined();
	});

	it("is empty again once cleared", () => {
		requestDialog("logs", { tab: "storage" });
		clearRequestedDialog();

		expect(getRequestedDialog()).toBeUndefined();
		expect(getRequestedDialogContext()).toBeUndefined();
	});
});
