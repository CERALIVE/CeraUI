// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "./clipboard";

const originalNavigator = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator",
);

function setClipboard(clipboard: unknown): void {
	Object.defineProperty(globalThis.navigator, "clipboard", {
		configurable: true,
		value: clipboard,
	});
}

afterEach(() => {
	if (originalNavigator) {
		Object.defineProperty(globalThis, "navigator", originalNavigator);
	}
	vi.restoreAllMocks();
});

describe("copyToClipboard — secure-context Clipboard API", () => {
	it("uses navigator.clipboard.writeText when available", async () => {
		const writeText = vi.fn(async () => {});
		setClipboard({ writeText });

		const ok = await copyToClipboard("hello");

		expect(ok).toBe(true);
		expect(writeText).toHaveBeenCalledWith("hello");
	});
});

describe("copyToClipboard — plain-HTTP fallback (no Clipboard API)", () => {
	it("falls back to execCommand('copy') when navigator.clipboard is absent", async () => {
		setClipboard(undefined);
		const execCommand = vi.fn(() => true);
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: execCommand,
		});

		const ok = await copyToClipboard("over-http");

		expect(ok).toBe(true);
		expect(execCommand).toHaveBeenCalledWith("copy");
		// The transient textarea is always removed after the copy attempt.
		expect(document.querySelector("textarea")).toBeNull();
	});

	it("falls back to execCommand when writeText rejects (permission denied)", async () => {
		const writeText = vi.fn(async () => {
			throw new Error("NotAllowedError");
		});
		setClipboard({ writeText });
		const execCommand = vi.fn(() => true);
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: execCommand,
		});

		const ok = await copyToClipboard("retry-me");

		expect(ok).toBe(true);
		expect(writeText).toHaveBeenCalledWith("retry-me");
		expect(execCommand).toHaveBeenCalledWith("copy");
	});

	it("returns false when both the API and execCommand fail", async () => {
		setClipboard(undefined);
		const execCommand = vi.fn(() => false);
		Object.defineProperty(document, "execCommand", {
			configurable: true,
			value: execCommand,
		});

		const ok = await copyToClipboard("nope");

		expect(ok).toBe(false);
		expect(document.querySelector("textarea")).toBeNull();
	});
});
