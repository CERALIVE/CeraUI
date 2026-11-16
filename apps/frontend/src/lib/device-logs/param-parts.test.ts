import { describe, expect, it } from "vitest";

import { paramParts } from "./param-parts";

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
