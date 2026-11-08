// @vitest-environment jsdom
import type { UpdateSlotStatus } from "@ceraui/rpc/schemas";
import { cleanup, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it } from "vitest";

import { en } from "../../../tests/helpers/catalog";
import SlotsSection from "./SlotsSection.svelte";

const slotsCopy = en.settings.updates.slots;

function slot(overrides: Partial<UpdateSlotStatus>): UpdateSlotStatus {
	return {
		name: "rootfs.0",
		bootname: "A",
		state: "booted",
		bootStatus: "good",
		version: "2026.10.100",
		lastSyncedAt: null,
		...overrides,
	};
}

afterEach(() => {
	cleanup();
});

describe("SlotsSection", () => {
	it("omits the booted slot mirror line when it has never synced", () => {
		render(SlotsSection, {
			slots: [
				slot({ name: "rootfs.0", state: "booted", version: "2026.10.100" }),
				slot({
					name: "rootfs.1",
					bootname: "B",
					state: "inactive",
					version: null,
				}),
			],
		});

		const booted = within(screen.getByTestId("update-slot-A"));
		const standby = within(screen.getByTestId("update-slot-B"));
		expect(booted.queryByText(slotsCopy.neverSynced)).toBeNull();
		expect(standby.getByText(slotsCopy.neverSynced)).not.toBeNull();
	});

	it("keeps the last-synced line for a booted slot with a timestamp", () => {
		render(SlotsSection, {
			slots: [
				slot({
					lastSyncedAt: "2026-11-08T00:00:00Z",
				}),
			],
		});

		const bootedText = screen.getByTestId("update-slot-A").textContent ?? "";
		expect(bootedText).toContain("Mirrored");
		expect(bootedText).not.toContain(slotsCopy.neverSynced);
	});
});
