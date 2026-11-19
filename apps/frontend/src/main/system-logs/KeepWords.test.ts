// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

import { chineseWordChunks } from "$lib/device-logs/sharing";

import { zh } from "../../tests/helpers/catalog";

import KeepWords from "./KeepWords.svelte";

afterEach(() => {
	cleanup();
	setLocale("en");
	vi.unstubAllGlobals();
});

const NOTE: string = zh.systemLogs.sharing.bundleSensitive;

describe("KeepWords: fixed copy that may wrap", () => {
	it("marks the gaps between Chinese words and keeps the copy exactly", async () => {
		setLocale("zh");
		await tick();
		const { container } = render(KeepWords, { props: { text: NOTE } });

		expect(container.textContent).toBe(NOTE);
		const pieces: string[] = [""];
		for (const node of container.childNodes) {
			if (node.nodeName === "WBR") pieces.push("");
			else if (node.nodeType === Node.TEXT_NODE)
				pieces.push(`${pieces.pop() ?? ""}${node.textContent ?? ""}`);
		}
		expect(pieces).toEqual(chineseWordChunks(NOTE, "zh"));
		expect(pieces.length).toBeGreaterThan(1);
	});

	it("renders any other locale's copy as it is, with no break marks", () => {
		const text =
			"Secrets known to the device and common identifiers are removed.";
		const { container } = render(KeepWords, { props: { text } });

		expect(container.textContent).toBe(text);
		expect(container.querySelectorAll("wbr")).toHaveLength(0);
	});

	it("renders the copy as it is when the browser has no word segmenter", async () => {
		vi.stubGlobal(
			"Intl",
			Object.assign(Object.create(Intl), { Segmenter: undefined }),
		);
		setLocale("zh");
		await tick();
		const { container } = render(KeepWords, { props: { text: NOTE } });

		expect(container.textContent).toBe(NOTE);
		expect(container.querySelectorAll("wbr")).toHaveLength(0);
	});
});
