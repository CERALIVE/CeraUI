// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { createRawSnippet } from "svelte";
import { describe, expect, it, vi } from "vitest";
import PullToRefresh from "./pull-to-refresh.svelte";

const point = (identifier: number, clientY: number) => ({
	identifier,
	clientY,
});

describe("pull-to-refresh touch ownership", () => {
	it("does not refresh on cancel or a second contact, but accepts a new single finger", async () => {
		const onRefresh = vi.fn(async () => {});
		Object.defineProperty(window, "ontouchstart", {
			configurable: true,
			value: null,
		});
		try {
			render(PullToRefresh, {
				onRefresh,
				children: createRawSnippet(() => ({ render: () => "<span></span>" })),
			});
			const start = () =>
				fireEvent.touchStart(document.body, { touches: [point(1, 60)] });
			const move = () =>
				fireEvent.touchMove(document.body, { touches: [point(1, 180)] });
			const end = () =>
				fireEvent.touchEnd(document.body, {
					touches: [],
					changedTouches: [point(1, 180)],
				});
			await start();
			await move();
			await fireEvent.touchCancel(document.body, {
				touches: [],
				changedTouches: [point(1, 180)],
			});
			await end();
			expect(onRefresh).not.toHaveBeenCalled();
			await start();
			await move();
			await fireEvent.touchStart(document.body, {
				touches: [point(1, 180), point(2, 190)],
			});
			await fireEvent.touchEnd(document.body, {
				touches: [point(1, 180)],
				changedTouches: [point(2, 190)],
			});
			await move();
			await end();
			expect(onRefresh).not.toHaveBeenCalled();
			await start();
			await move();
			await end();
			await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
		} finally {
			Reflect.deleteProperty(window, "ontouchstart");
		}
	});
});
