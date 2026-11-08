// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import {
	type UpdateCheckClockSummary,
	type UpdateDetails,
	updateDetailsSchema,
} from "@ceraui/rpc/schemas";
import { cleanup, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatUpdateTime } from "$lib/updates/update-view";
import PackagesSummary from "./PackagesSummary.svelte";
import SystemSection from "./SystemSection.svelte";

const START = Date.parse("2026-11-08T12:00:00Z");
const NEXT = START + 60_000;
const SOON = "Next automatic check: as soon as possible";
const TIMER_LIMIT = 2 ** 31 - 1;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(START);
	setLocale("en");
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function details(clock: UpdateCheckClockSummary): UpdateDetails {
	return updateDetailsSchema.parse({
		slots: null,
		os: { bootedVersion: "2026.10.100", staged: null, candidate: null },
		checks: { packages: clock, os: clock },
		pendingCellular: null,
		transport: null,
	});
}

const oldClock = {
	lastAttemptAt: START - 60_000,
	lastSuccessAt: START - 60_000,
	nextAttemptAt: NEXT,
};

function mount(
	surface: "system" | "packages",
	clock: UpdateCheckClockSummary,
	systemDetails?: UpdateDetails,
) {
	if (surface === "system") {
		const view = render(SystemSection, {
			details: systemDetails ?? details(clock),
			channel: "beta",
			autoEnabled: true,
			checking: false,
			installing: false,
			wire: undefined,
			onCheck: () => undefined,
			onInstall: () => undefined,
		});
		return {
			line: () => screen.getByTestId("update-system-schedule"),
			changeClock: (next: UpdateCheckClockSummary) =>
				view.rerender({ details: details(next) }),
			unmount: () => view.unmount(),
		};
	}
	const view = render(PackagesSummary, {
		clock,
		autoEnabled: true,
		checking: false,
		updateState: { kind: "idle" },
	});
	return {
		line: () => screen.getByTestId("update-next-check"),
		changeClock: (next: UpdateCheckClockSummary) =>
			view.rerender({ clock: next }),
		unmount: () => view.unmount(),
	};
}

describe.each(["system", "packages"] as const)(
	"%s mounted schedule",
	(surface) => {
		it("replaces the time when its deadline passes without any backend change", async () => {
			const view = mount(surface, {
				...oldClock,
				deferred: null,
				consecutiveFailures: 0,
			});
			expect(view.line().textContent?.trim()).toBe(
				`Next automatic check: ${formatUpdateTime(NEXT, "en")}`,
			);
			await vi.advanceTimersByTimeAsync(120_000);
			await tick();
			expect(view.line().textContent?.trim()).toBe(SOON);
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([30_000, 180_000])(
			"re-arms its single timeout when the deadline moves to %i ms after mount",
			async (offset) => {
				const view = mount(surface, oldClock);
				await vi.advanceTimersByTimeAsync(10_000);
				const nextAttemptAt = START + offset;
				await view.changeClock({ ...oldClock, nextAttemptAt });
				await tick();
				expect(view.line().textContent?.trim()).toBe(
					`Next automatic check: ${formatUpdateTime(nextAttemptAt, "en")}`,
				);
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(offset - 10_001);
				await tick();
				expect(view.line().textContent?.trim()).not.toBe(SOON);
				await vi.advanceTimersByTimeAsync(1);
				await tick();
				expect(view.line().textContent?.trim()).toBe(SOON);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it("unmounting clears the pending deadline timeout", async () => {
			const view = mount(surface, oldClock);
			expect(vi.getTimerCount()).toBe(1);
			await view.unmount();
			expect(vi.getTimerCount()).toBe(0);
		});

		it("removing a deadline clears its timeout and schedule line", async () => {
			const view = mount(surface, oldClock);
			expect(vi.getTimerCount()).toBe(1);
			await view.changeClock({ ...oldClock, nextAttemptAt: null });
			await tick();
			expect(vi.getTimerCount()).toBe(0);
			expect(
				screen.queryByTestId(
					surface === "system" ? "update-system-schedule" : "update-next-check",
				),
			).toBeNull();
		});

		it("an older backend omitting the optional fields still renders and follows the deadline", async () => {
			const legacy = details(oldClock);
			expect(legacy.checks.os.deferred).toBeUndefined();
			expect(legacy.checks.os.consecutiveFailures).toBeUndefined();
			expect(legacy.os.channelUnpublished).toBeUndefined();
			const view = mount(surface, legacy.checks.os);
			expect(view.line().textContent?.trim()).toBe(
				`Next automatic check: ${formatUpdateTime(NEXT, "en")}`,
			);
			expect(document.body.textContent).not.toContain("didn't finish.");
			expect(screen.queryByTestId("update-system-channel-empty")).toBeNull();
			await vi.advanceTimersByTimeAsync(60_000);
			await tick();
			expect(view.line().textContent?.trim()).toBe(SOON);
		});

		it.each([TIMER_LIMIT, TIMER_LIMIT + 1, TIMER_LIMIT + 60_000])(
			"keeps a %i ms deadline armed until its real boundary",
			async (delay) => {
				const view = mount(surface, {
					...oldClock,
					nextAttemptAt: START + delay,
				});
				expect(vi.getTimerCount()).toBe(1);
				await vi.advanceTimersByTimeAsync(2);
				await tick();
				expect(vi.getTimerCount()).toBe(1);
				expect(view.line().textContent?.trim()).not.toBe(SOON);
				await vi.advanceTimersByTimeAsync(TIMER_LIMIT - 3);
				await tick();
				expect(view.line().textContent?.trim()).not.toBe(SOON);
				await vi.advanceTimersByTimeAsync(1);
				await tick();
				if (delay > TIMER_LIMIT) {
					expect(vi.getTimerCount()).toBe(1);
					expect(view.line().textContent?.trim()).not.toBe(SOON);
					await vi.advanceTimersByTimeAsync(delay - TIMER_LIMIT);
					await tick();
				}
				expect(view.line().textContent?.trim()).toBe(SOON);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it("keeps a years-away deadline pending without early firing or timer spam", async () => {
			const timeout = vi.spyOn(globalThis, "setTimeout");
			const nextAttemptAt = Date.UTC(2100, 0, 1);
			const view = mount(surface, { ...oldClock, nextAttemptAt });
			await vi.advanceTimersByTimeAsync(2);
			await tick();
			expect(timeout).toHaveBeenCalledTimes(1);
			for (let chunk = 0; chunk < 3; chunk++) {
				expect(vi.getTimerCount()).toBe(1);
				expect(view.line().textContent?.trim()).toBe(
					`Next automatic check: ${formatUpdateTime(nextAttemptAt, "en")}`,
				);
				await vi.advanceTimersByTimeAsync(TIMER_LIMIT);
				await tick();
			}
			expect(vi.getTimerCount()).toBe(1);
			expect(view.line().textContent?.trim()).not.toBe(SOON);
			for (const [, delay] of timeout.mock.calls) {
				expect(delay).toBeGreaterThan(0);
				expect(delay).toBeLessThanOrEqual(TIMER_LIMIT);
			}
		});

		it("replaces a chunked timeout when the backend changes the deadline", async () => {
			const view = mount(surface, {
				...oldClock,
				nextAttemptAt: START + TIMER_LIMIT * 3,
			});
			await vi.advanceTimersByTimeAsync(TIMER_LIMIT);
			await tick();
			expect(vi.getTimerCount()).toBe(1);
			await view.changeClock({
				...oldClock,
				nextAttemptAt: Date.now() + 60_000,
			});
			await tick();
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(60_000);
			await tick();
			expect(view.line().textContent?.trim()).toBe(SOON);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("unmounting clears a re-armed long deadline", async () => {
			const view = mount(surface, {
				...oldClock,
				nextAttemptAt: START + TIMER_LIMIT * 3,
			});
			await vi.advanceTimersByTimeAsync(TIMER_LIMIT);
			await tick();
			expect(vi.getTimerCount()).toBe(1);
			await view.unmount();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([START, START - 1, 0])(
			"a deadline already reached at %i renders immediately without a timer",
			(nextAttemptAt) => {
				const view = mount(surface, { ...oldClock, nextAttemptAt });
				expect(view.line().textContent?.trim()).toBe(SOON);
				expect(vi.getTimerCount()).toBe(0);
			},
		);

		it.each([
			null,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			8_640_000_000_000_001,
		])(
			"ignores an absent or invalid deadline %s without arming a timer",
			(nextAttemptAt) => {
				const clock = { ...oldClock, nextAttemptAt };
				const value = details(oldClock);
				// Exercise presentation safety even for numbers rejected by the RPC boundary.
				value.checks = { packages: clock, os: clock };
				mount(surface, clock, value);
				expect(vi.getTimerCount()).toBe(0);
				expect(
					screen.queryByTestId(
						surface === "system"
							? "update-system-schedule"
							: "update-next-check",
					),
				).toBeNull();
			},
		);

		it("rounds a fractional remaining delay up rather than consuming an early wake-up", async () => {
			const view = mount(surface, { ...oldClock, nextAttemptAt: START + 0.5 });
			await vi.advanceTimersByTimeAsync(1);
			await tick();
			expect(view.line().textContent?.trim()).toBe(SOON);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("recomputes the remaining wall time after a backward clock correction", async () => {
			const nextAttemptAt = START + TIMER_LIMIT + 60_000;
			const view = mount(surface, { ...oldClock, nextAttemptAt });
			vi.setSystemTime(START - 60_000);
			await vi.advanceTimersByTimeAsync(TIMER_LIMIT);
			await tick();
			expect(vi.getTimerCount()).toBe(1);
			expect(view.line().textContent?.trim()).not.toBe(SOON);
			await vi.advanceTimersByTimeAsync(120_000);
			await tick();
			expect(view.line().textContent?.trim()).toBe(SOON);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("a late wake-up after a forward clock correction settles without another timeout", async () => {
			const view = mount(surface, oldClock);
			vi.setSystemTime(START + 3_600_000);
			await vi.advanceTimersByTimeAsync(60_000);
			await tick();
			expect(view.line().textContent?.trim()).toBe(SOON);
			expect(vi.getTimerCount()).toBe(0);
		});
	},
);

it("each mounted row owns its timer independently", async () => {
	const system = mount("system", oldClock);
	const packages = mount("packages", {
		...oldClock,
		nextAttemptAt: START + 120_000,
	});
	expect(vi.getTimerCount()).toBe(2);
	await vi.advanceTimersByTimeAsync(60_000);
	await tick();
	expect(system.line().textContent?.trim()).toBe(SOON);
	expect(packages.line().textContent?.trim()).not.toBe(SOON);
	expect(vi.getTimerCount()).toBe(1);
	await system.unmount();
	expect(vi.getTimerCount()).toBe(1);
	await vi.advanceTimersByTimeAsync(60_000);
	await tick();
	expect(packages.line().textContent?.trim()).toBe(SOON);
	expect(vi.getTimerCount()).toBe(0);
});
