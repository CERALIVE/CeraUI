// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { expect, it, onTestFinished } from "vitest";

import {
	BUNDLE_TICKET,
	bundleManifest,
	EXPORT_TICKET,
} from "$lib/device-logs/__fixtures__/sharing";
import { SharingFlow } from "$lib/device-logs/sharing-flow.svelte";

import { en } from "../../tests/helpers/catalog";
import BundleDialog from "./BundleDialog.svelte";

it.each([false, true])(
	"reports incomplete journal coverage only when complete is false (complete: %s)",
	async (complete) => {
		const manifest = bundleManifest(10);
		const sharing = new SharingFlow({
			logs: {
				createExport: async () => EXPORT_TICKET,
				createBundle: async () => BUNDLE_TICKET,
				previewBundle: async () => ({
					...manifest,
					sections: manifest.sections.map((section) =>
						section.id === "journal" ? { ...section, complete } : section,
					),
				}),
			},
			download: () => {},
		});
		onTestFinished(() => {
			cleanup();
			sharing.dispose();
		});
		render(BundleDialog, { props: { sharing } });

		await sharing.openBundle();

		const copy = en.systemLogs.sharing;
		const dialog = within(
			await screen.findByRole("dialog", { name: copy.bundle }),
		);
		await dialog.findByRole("table");
		if (complete) {
			expect(dialog.queryByText(copy.bundleJournalIncomplete)).toBeNull();
		} else {
			expect(dialog.getByText(copy.bundleJournalIncomplete).hidden).toBe(false);
		}
		expect(
			dialog
				.getByRole("button", { name: copy.bundleDownload })
				.hasAttribute("disabled"),
		).toBe(false);
	},
);
