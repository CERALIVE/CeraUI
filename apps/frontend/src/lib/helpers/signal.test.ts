import { describe, expect, it } from "vitest";
import { linkVisualState, signalBarCount } from "./signal";

// ============================================
// signalBarCount tests
// ============================================

describe("signalBarCount", () => {
	describe("null signal", () => {
		it("null → 0 bars", () => {
			expect(signalBarCount(null)).toBe(0);
		});
	});

	describe("zero signal", () => {
		it("0 → 0 bars (behavior change from BondedLinks)", () => {
			expect(signalBarCount(0)).toBe(0);
		});
	});

	describe("low signal (>0 and <33)", () => {
		it("1 → 1 bar", () => {
			expect(signalBarCount(1)).toBe(1);
		});

		it("32 → 1 bar", () => {
			expect(signalBarCount(32)).toBe(1);
		});
	});

	describe("medium signal (>=33 and <66)", () => {
		it("33 → 2 bars", () => {
			expect(signalBarCount(33)).toBe(2);
		});

		it("65 → 2 bars", () => {
			expect(signalBarCount(65)).toBe(2);
		});
	});

	describe("high signal (>=66)", () => {
		it("66 → 3 bars", () => {
			expect(signalBarCount(66)).toBe(3);
		});

		it("100 → 3 bars", () => {
			expect(signalBarCount(100)).toBe(3);
		});
	});
});

// ============================================
// linkVisualState tests
// ============================================

describe("linkVisualState", () => {
	describe("ethernet type (always wins)", () => {
		it("ethernet + connected + null signal → {kind:'ethernet'}", () => {
			const result = linkVisualState({
				type: "ethernet",
				connectionState: "connected",
				signal: null,
			});
			expect(result).toEqual({ kind: "ethernet" });
		});

		it("ethernet + connected + 50 signal → {kind:'ethernet'} (ethernet always wins)", () => {
			const result = linkVisualState({
				type: "ethernet",
				connectionState: "connected",
				signal: 50,
			});
			expect(result).toEqual({ kind: "ethernet" });
		});
	});

	describe("signal present (shows bars)", () => {
		it("modem + connected + 67 signal → {kind:'bars', filled:3}", () => {
			const result = linkVisualState({
				type: "modem",
				connectionState: "connected",
				signal: 67,
			});
			expect(result).toEqual({ kind: "bars", filled: 3 });
		});

		it("wifi + connected + 40 signal → {kind:'bars', filled:2}", () => {
			const result = linkVisualState({
				type: "wifi",
				connectionState: "connected",
				signal: 40,
			});
			expect(result).toEqual({ kind: "bars", filled: 2 });
		});

		it("modem + connected + 0 signal → {kind:'bars', filled:0}", () => {
			const result = linkVisualState({
				type: "modem",
				connectionState: "connected",
				signal: 0,
			});
			expect(result).toEqual({ kind: "bars", filled: 0 });
		});
	});

	describe("signal absent + no_sim", () => {
		it("modem + no_sim + null signal → {kind:'no-sim'}", () => {
			const result = linkVisualState({
				type: "modem",
				connectionState: "no_sim",
				signal: null,
			});
			expect(result).toEqual({ kind: "no-sim" });
		});
	});

	describe("signal absent + scanning", () => {
		it("modem + scanning + null signal → {kind:'scanning'}", () => {
			const result = linkVisualState({
				type: "modem",
				connectionState: "scanning",
				signal: null,
			});
			expect(result).toEqual({ kind: "scanning" });
		});
	});

	describe("signal absent + connected (bug fix: both modem AND wifi → acquiring)", () => {
		it("modem + connected + null signal → {kind:'acquiring'}", () => {
			const result = linkVisualState({
				type: "modem",
				connectionState: "connected",
				signal: null,
			});
			expect(result).toEqual({ kind: "acquiring" });
		});

		it("wifi + connected + null signal → {kind:'acquiring'} (NOT wifi-off!)", () => {
			const result = linkVisualState({
				type: "wifi",
				connectionState: "connected",
				signal: null,
			});
			expect(result).toEqual({ kind: "acquiring" });
		});
	});

	describe("signal absent + disconnected", () => {
		it("wifi + disconnected + null signal → {kind:'wifi-off'}", () => {
			const result = linkVisualState({
				type: "wifi",
				connectionState: "disconnected",
				signal: null,
			});
			expect(result).toEqual({ kind: "wifi-off" });
		});

		it("modem + disconnected + null signal → {kind:'zero'}", () => {
			const result = linkVisualState({
				type: "modem",
				connectionState: "disconnected",
				signal: null,
			});
			expect(result).toEqual({ kind: "zero" });
		});
	});
});
