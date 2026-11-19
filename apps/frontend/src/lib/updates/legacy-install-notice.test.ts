import type { StatusMessage } from "@ceraui/rpc/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";

import { en } from "../../tests/helpers/catalog";
import { VIEW_LOGS_TOAST_CLASS } from "../device-logs/view-logs";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("svelte-sonner", () => ({ toast }));

import { announceLegacyInstallOutcome } from "./legacy-install-notice";

type Updating = StatusMessage["updating"];

function finished(result: string | number): Updating {
	return {
		downloading: 1,
		unpacking: 1,
		setting_up: 1,
		total: 1,
		result,
	} as Updating;
}

afterEach(() => {
	toast.success.mockReset();
	toast.error.mockReset();
});

describe("announceLegacyInstallOutcome: View logs on a failure", () => {
	it("offers View logs when the device sent no reason", () => {
		announceLegacyInstallOutcome(finished("  "));

		expect(toast.error).toHaveBeenCalledWith(en.updatingOverlay.failedMessage, {
			description: en.settings.updates.failedReasonGeneric,
			class: VIEW_LOGS_TOAST_CLASS,
			action: {
				label: en.notifications.viewLogs,
				onClick: expect.any(Function),
			},
		});
	});

	it("shows the device's own words with no action", () => {
		announceLegacyInstallOutcome(finished("E: Unable to locate package"));

		expect(toast.error).toHaveBeenCalledWith(en.updatingOverlay.failedMessage, {
			description: "E: Unable to locate package",
		});
	});

	it("announces a success with no action", () => {
		announceLegacyInstallOutcome(finished(0));

		expect(toast.success).toHaveBeenCalledWith(
			en.updatingOverlay.successMessage,
			{ description: en.updatingOverlay.installedDescription },
		);
		expect(toast.error).not.toHaveBeenCalled();
	});
});
