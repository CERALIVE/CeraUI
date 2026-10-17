import { expect, test } from "bun:test";
import {
	abortAptTransferForStream,
	captureAptTransferAdmission,
	trackAptTransfer,
} from "../modules/system/apt-transfer-abort.ts";

test("fixed-seed admission interleavings preserve cancellation and release ownership", () => {
	// Given an independent epoch/active-owner model and a reproducible action stream.
	let seed = 336;
	let epoch = 0;
	const rows: {
		controller: AbortController;
		admitted: number;
		admission: ReturnType<typeof captureAptTransferAdmission>;
		expectedAbort: boolean;
		release?: () => void;
	}[] = [];
	let active: (typeof rows)[number] | undefined;
	// When capture, registration, old-owner release and stream admission interleave.
	for (let index = 0; index < 160; index++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		const operation = seed % 4;
		const selected = rows[(seed >>> 8) % Math.max(rows.length, 1)];
		switch (operation) {
			case 0:
				rows.push({
					controller: new AbortController(),
					admitted: epoch,
					admission: captureAptTransferAdmission(),
					expectedAbort: false,
				});
				break;
			case 1:
				if (selected) {
					selected.release = trackAptTransfer(
						selected.controller,
						selected.admission,
					);
					selected.expectedAbort ||= selected.admitted !== epoch;
					active = selected;
				}
				break;
			case 2:
				selected?.release?.();
				if (selected?.release && selected === active) active = undefined;
				break;
			case 3:
				abortAptTransferForStream();
				epoch++;
				if (active) active.expectedAbort = true;
				break;
		}
		// Then no old release clears a newer controller and no pre-registration abort is lost.
		for (const row of rows) {
			expect(row.admission.cancelled()).toBe(row.admitted !== epoch);
			expect(row.controller.signal.aborted).toBe(row.expectedAbort);
		}
	}
	active?.release?.();
});
