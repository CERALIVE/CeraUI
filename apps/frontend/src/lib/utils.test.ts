import { describe, expect, it } from "vitest";

import { capitalizeFirstLetter, cn } from "./utils";

describe("cn (className utility)", () => {
	it("should merge class names", () => {
		const result = cn("px-2", "py-1");
		expect(result).toBe("px-2 py-1");
	});

	it("should handle conditional classes", () => {
		const isActive = true;
		const result = cn("base", isActive && "active");
		expect(result).toContain("base");
		expect(result).toContain("active");
	});

	it("should merge conflicting Tailwind classes", () => {
		// tailwind-merge should keep only the last conflicting class
		const result = cn("px-2", "px-4");
		expect(result).toBe("px-4");
	});

	it("should handle undefined and null values", () => {
		const result = cn("base", undefined, null, "extra");
		expect(result).toBe("base extra");
	});

	it("should handle arrays of classes", () => {
		const result = cn(["px-2", "py-1"], "mx-auto");
		expect(result).toBe("px-2 py-1 mx-auto");
	});

	it("should handle empty input", () => {
		const result = cn();
		expect(result).toBe("");
	});
});

describe("capitalizeFirstLetter", () => {
	it("should capitalize the first letter of a string", () => {
		expect(capitalizeFirstLetter("hello")).toBe("Hello");
	});

	it("should handle single character strings", () => {
		expect(capitalizeFirstLetter("a")).toBe("A");
	});

	it("should handle already capitalized strings", () => {
		expect(capitalizeFirstLetter("Hello")).toBe("Hello");
	});

	it("should handle empty strings", () => {
		expect(capitalizeFirstLetter("")).toBe("");
	});

	it("should preserve the rest of the string", () => {
		expect(capitalizeFirstLetter("hELLO WORLD")).toBe("HELLO WORLD");
	});

	it("should handle strings starting with numbers", () => {
		expect(capitalizeFirstLetter("123abc")).toBe("123abc");
	});
});
