// @vitest-environment jsdom
/**
 * What an open Updates dialog re-reads (round-2 review C, M2): a changed phase
 * re-reads once and is evidence; a restored session re-reads even when the
 * phase is exactly what it was; a closed dialog does nothing (its open edge is
 * the surface's own load).
 */
import { describe, expect, it } from "vitest";

import { type DeviceFrame, followStep } from "./update-device-follow.svelte";

const IDLE: DeviceFrame = { open: true, phase: "idle", restored: 3 };

describe("followStep", () => {
	it("re-reads after a restored session on the same phase", () => {
		// Given an open dialog at idle; When the session is restored, still idle.
		const move = followStep(IDLE, { ...IDLE, restored: 4 });

		// Then the details are read again.
		expect(move).toEqual({ kind: "reread" });
	});

	it("forwards a changed phase once, even when the session was restored with it", () => {
		// Given an open dialog at idle; When a restore brings a new phase.
		const move = followStep(IDLE, { ...IDLE, phase: "available", restored: 4 });

		// Then the phase is the one step (it re-reads the details), and the
		// restored session still re-reads the settings (early oracle F6).
		expect(move).toEqual({ kind: "phase", phase: "available", reread: true });
	});

	it("does nothing for an unchanged frame", () => {
		// Given an open dialog; When the same frame arrives again.
		const move = followStep(IDLE, { ...IDLE });

		// Then nothing is read.
		expect(move).toEqual({ kind: "none" });
	});

	it("does nothing while the dialog is closed, whatever moved", () => {
		// Given a closed dialog; When both the phase and the session move.
		const move = followStep(
			{ ...IDLE, open: false },
			{ open: false, phase: "checking", restored: 9 },
		);

		// Then nothing is read; the next open loads everything anyway.
		expect(move).toEqual({ kind: "none" });
	});
});
