import { describe, expect, it } from "vitest";

import {
	fieldsForSection,
	HOT_CHANGEABLE_FIELDS,
	isFieldEditable,
	isFieldHotChangeable,
	isFieldLocked,
	isSectionLocked,
	RESTART_REQUIRED_FIELDS,
} from "./streamingLockPolicy";

describe("streamingLockPolicy", () => {
	describe("isFieldLocked", () => {
		it("locks nothing when not streaming", () => {
			for (const field of [...RESTART_REQUIRED_FIELDS, ...HOT_CHANGEABLE_FIELDS]) {
				expect(isFieldLocked(field, false)).toBe(false);
			}
		});

		it("locks every restart-required field while streaming", () => {
			for (const field of RESTART_REQUIRED_FIELDS) {
				expect(isFieldLocked(field, true)).toBe(true);
			}
		});

		it("never locks hot-changeable bitrate, even while streaming", () => {
			expect(isFieldLocked("max_br", true)).toBe(false);
			expect(isFieldLocked("max_br", false)).toBe(false);
		});

		it("locks the key restart-required fields explicitly", () => {
			expect(isFieldLocked("pipeline", true)).toBe(true); // video source
			expect(isFieldLocked("asrc", true)).toBe(true); // audio source
			expect(isFieldLocked("acodec", true)).toBe(true); // audio codec
			expect(isFieldLocked("srtla_addr", true)).toBe(true); // server address
			expect(isFieldLocked("srtla_port", true)).toBe(true); // server port
			expect(isFieldLocked("srt_latency", true)).toBe(true); // latency
		});

		it("fails open for unknown fields", () => {
			expect(isFieldLocked("bitrate_overlay", true)).toBe(false);
			expect(isFieldLocked("totally_unknown", true)).toBe(false);
		});
	});

	describe("isFieldEditable", () => {
		it("is the inverse of isFieldLocked", () => {
			expect(isFieldEditable("pipeline", true)).toBe(false);
			expect(isFieldEditable("max_br", true)).toBe(true);
			expect(isFieldEditable("pipeline", false)).toBe(true);
		});
	});

	describe("isFieldHotChangeable", () => {
		it("only bitrate is hot-changeable", () => {
			expect(isFieldHotChangeable("max_br")).toBe(true);
			expect(isFieldHotChangeable("pipeline")).toBe(false);
		});
	});

	describe("isSectionLocked", () => {
		it("locks encoder/audio/server while streaming", () => {
			expect(isSectionLocked("encoder", true)).toBe(true);
			expect(isSectionLocked("audio", true)).toBe(true);
			expect(isSectionLocked("server", true)).toBe(true);
		});

		it("unlocks all sections when not streaming", () => {
			expect(isSectionLocked("encoder", false)).toBe(false);
			expect(isSectionLocked("audio", false)).toBe(false);
			expect(isSectionLocked("server", false)).toBe(false);
		});

		it("encoder is locked even though it contains the hot bitrate field", () => {
			// encoder has both restart-required (pipeline) and hot (max_br) fields;
			// the section is still locked because at least one field is restart-required.
			expect(fieldsForSection("encoder")).toContain("max_br");
			expect(fieldsForSection("encoder")).toContain("pipeline");
			expect(isSectionLocked("encoder", true)).toBe(true);
		});
	});
});
