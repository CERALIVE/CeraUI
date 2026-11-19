import { describe, expect, it } from "vitest";

import { markParam, paramParts, paramPieces } from "./param-parts";

describe("paramParts", () => {
	it("splits a message around its data param", () => {
		expect(paramParts((value) => `Before ${value} after`)).toEqual([
			"Before ",
			" after",
		]);
	});

	it("leaves nothing after a param that ends the message", () => {
		expect(paramParts((version) => `System image ${version}`)).toEqual([
			"System image ",
			"",
		]);
	});

	it("leaves nothing before a param that starts the message", () => {
		expect(paramParts((slot) => `${slot} لوحة`)).toEqual(["", " لوحة"]);
	});

	it("finds the param even when the copy around it holds any printable character", () => {
		const printable = Array.from({ length: 95 }, (_, code) =>
			String.fromCharCode(32 + code),
		).join("");
		expect(paramParts((value) => `${printable}${value}${printable}`)).toEqual([
			printable,
			printable,
		]);
	});
});

describe("paramPieces", () => {
	it("keeps each marked param apart, in the order the translation places it", () => {
		const used = markParam("48 MB");
		const limit = markParam("256 MB");
		expect(paramPieces(`${limit}${used} :الحد`)).toEqual([
			{ text: "256 MB", param: true },
			{ text: "48 MB", param: true },
			{ text: " :الحد", param: false },
		]);
	});

	it("keeps a value that holds the mark inside its own param", () => {
		expect(paramPieces(`Logs use ${markParam("a\u0000b")}`)).toEqual([
			{ text: "Logs use ", param: false },
			{ text: "a\uFFFDb", param: true },
		]);
	});
});
