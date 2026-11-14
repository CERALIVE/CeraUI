import { afterEach, expect, test } from "bun:test";
import { captureTransitions } from "./helpers/capture-event-transitions.ts";

let close = () => {};
afterEach(() => close());
function harness(mode: "recording" | "store") {
	const h = captureTransitions(mode);
	close = h.close;
	return h;
}

for (const mode of ["recording", "store"] as const) {
	test(`${mode}: standby replacement preserves uninterrupted input loss`, () => {
		const h = harness(mode);
		h.capture(["B"], ["A"]);
		h.capture([], ["A", "B"], "standby");
		expect(
			h.events().filter((event) => event.code.startsWith("capture_input")),
		).toEqual([
			{
				code: "capture_input_lost",
				params: { name: "Camera A", activeCamera: false },
			},
		]);
		h.capture(["C"], ["A"]);
		expect(
			h.events().filter((event) => event.code === "capture_input_lost"),
		).toHaveLength(1);
		h.capture(["A", "C"]);
		h.capture(["C"], ["A"]);
		h.capture(["C"], ["A"]);
		h.capture(["C", "A"]);
		expect(
			h.events().filter((event) => event.code.startsWith("capture_input")),
		).toEqual([
			{
				code: "capture_input_lost",
				params: { name: "Camera A", activeCamera: false },
			},
			{
				code: "capture_input_returned",
				params: { name: "Camera A", activeCamera: true },
			},
			{
				code: "capture_input_lost",
				params: { name: "Camera A", activeCamera: false },
			},
			{
				code: "capture_input_returned",
				params: { name: "Camera A", activeCamera: false },
			},
		]);
	});

	test(`${mode}: catalog absence and omitted degradation never prove a return`, () => {
		const h = harness(mode);
		h.capture(["B"], ["A"]);
		h.catalog(false);
		h.capture(["B"], ["A"]);
		expect(h.events()).toEqual([
			{
				code: "capture_input_lost",
				params: { name: "Camera A", activeCamera: false },
			},
		]);
		h.catalog(true);
		h.capture(["B"], ["A"]);
		h.partial();
		h.capture(["B"], [], "normal");
		expect(h.events()).toHaveLength(1);
		h.catalog(false);
		h.capture(["A", "B"], [], "normal");
		expect(h.events()).toEqual([
			{
				code: "capture_input_lost",
				params: { name: "Camera A", activeCamera: false },
			},
			{
				code: "capture_input_returned",
				params: { name: "Camera A", activeCamera: true },
			},
		]);
	});

	test(`${mode}: an empty device set never recovers an absent active source`, () => {
		const h = harness(mode);
		h.video(["B"]);
		h.video([]);
		h.video(["B"]);
		expect(h.events()).toEqual([{ code: "capture_source_lost", params: {} }]);
		// Keep the existing notification behavior, including its empty-scan toast.
		expect(h.notices).toContain("active-source-lost-recovered");
		h.video(["A"]);
		h.video(["A"]);
		h.video(["B"]);
		h.video([]);
		h.video(["A"]);
		expect(h.events().map((event) => event.code)).toEqual([
			"capture_source_lost",
			"capture_source_recovered",
			"capture_source_lost",
			"capture_source_recovered",
		]);
	});

	test(`${mode}: changing active selection cannot recover a different missing source`, () => {
		const h = harness(mode);
		h.video(["B"], "A");
		h.video(["B"], "B");
		h.video(["C"], "B");
		expect(h.events().map((event) => event.code)).toEqual([
			"capture_source_lost",
			"capture_source_lost",
		]);
		h.video(["A", "C"], "B");
		h.video(["B", "C"], "B");
		expect(h.events().map((event) => event.code)).toEqual([
			"capture_source_lost",
			"capture_source_lost",
			"capture_source_recovered",
			"capture_source_recovered",
		]);
	});

	test(`${mode}: first observations do not invent recovery and stops reset event ownership`, () => {
		const h = harness(mode);
		h.video([]);
		h.video(["A"]);
		h.capture(["A", "B"], [], "normal");
		expect(h.events()).toEqual([]);
		h.capture(["B"], ["A"]);
		h.video(["B"]);
		h.stop();
		h.capture(["A"], [], "normal");
		h.video(["A"]);
		expect(h.events().map((event) => event.code)).toEqual([
			"capture_input_lost",
			"capture_source_lost",
		]);
		h.capture(["B"], ["A"]);
		h.video(["B"]);
		expect(h.events().map((event) => event.code)).toEqual([
			"capture_input_lost",
			"capture_source_lost",
			"capture_input_lost",
			"capture_source_lost",
		]);
	});

	test(`${mode}: reentrant observations see committed loss and recovery state`, () => {
		const h = harness(mode);
		const reentered = new Set<string>();
		h.onEvent((code) => {
			if (reentered.has(code)) return;
			reentered.add(code);
			if (code === "capture_input_lost") h.capture(["B"], ["A"]);
			if (code === "capture_input_returned") h.capture(["A"]);
			if (code === "capture_source_lost") h.video(["B"]);
			if (code === "capture_source_recovered") h.video(["A"]);
		});
		h.capture(["B"], ["A"]);
		h.capture(["A"]);
		h.video(["B"]);
		h.video(["A"]);
		expect(h.events().map((event) => event.code)).toEqual([
			"capture_input_lost",
			"capture_input_returned",
			"capture_source_lost",
			"capture_source_recovered",
		]);
	});
}
