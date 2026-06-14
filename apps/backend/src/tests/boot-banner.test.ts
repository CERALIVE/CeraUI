import { describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import {
	APP_NAME,
	buildBootBanner,
	createBootTimer,
	formatReadyLine,
} from "../helpers/boot-banner.ts";

const SECRET_RE = /pin|token|secret|bcrp/i;

describe("boot banner", () => {
	test("renders product name, version, and env", () => {
		const banner = buildBootBanner({
			name: APP_NAME,
			version: "2026.6.1",
			env: "development",
			scenario: null,
			port: null,
		});
		expect(banner).toContain("CeraUI");
		expect(banner).toContain("v2026.6.1");
		expect(banner).toContain("env=development");
	});

	test("reflects the real package.json version (banner version source)", () => {
		const banner = buildBootBanner({
			name: APP_NAME,
			version: pkg.version,
			env: "production",
			scenario: null,
			port: null,
		});
		expect(banner).toContain(`v${pkg.version}`);
	});

	test("includes scenario when provided, omits when null", () => {
		expect(
			buildBootBanner({
				name: APP_NAME,
				version: pkg.version,
				env: "development",
				scenario: "multi-modem-wifi",
				port: null,
			}),
		).toContain("scenario=multi-modem-wifi");

		expect(
			buildBootBanner({
				name: APP_NAME,
				version: pkg.version,
				env: "production",
				scenario: null,
				port: null,
			}),
		).not.toContain("scenario=");
	});

	test("includes port when provided, omits when null", () => {
		expect(
			buildBootBanner({
				name: APP_NAME,
				version: pkg.version,
				env: "production",
				scenario: null,
				port: 3002,
			}),
		).toContain("port=3002");

		expect(
			buildBootBanner({
				name: APP_NAME,
				version: pkg.version,
				env: "production",
				scenario: null,
				port: null,
			}),
		).not.toContain("port=");
	});

	test("contains no secrets (no pin/token/secret/bcrp) even fully populated", () => {
		const banner = buildBootBanner({
			name: APP_NAME,
			version: pkg.version,
			env: "development",
			scenario: "streaming-active",
			port: 3002,
		});
		expect(banner).not.toMatch(SECRET_RE);
	});
});

describe("ready-timing line", () => {
	test("emits a ready line with elapsed ms and bound port", () => {
		const line = formatReadyLine(1234, 3002);
		expect(line).toContain("CeraUI ready");
		expect(line).toContain("on port 3002");
		expect(line).toMatch(/ready .* in \d+ms/);
		expect(line).toContain("in 1234ms");
	});

	test("rounds fractional elapsed ms", () => {
		expect(formatReadyLine(1233.6, 3002)).toContain("in 1234ms");
	});

	test("omits the port clause when the bound port is unknown", () => {
		const line = formatReadyLine(50, null);
		expect(line).toMatch(/ready in \d+ms/);
		expect(line).not.toContain("on port");
	});

	test("ready line carries no secrets", () => {
		expect(formatReadyLine(1234, 3002)).not.toMatch(SECRET_RE);
	});
});

describe("boot timer (passive performance deltas)", () => {
	test("phase reports the delta since the previous mark, not cumulative", () => {
		const ticks = [0, 10, 35, 36];
		let i = 0;
		const timer = createBootTimer(() => ticks[i++] ?? 0);
		expect(timer.phase("🔧", "config")).toBe("🔧 config (+10ms)");
		expect(timer.phase("🔌", "pipelines")).toBe("🔌 pipelines (+25ms)");
	});

	test("elapsedMs reports total since creation", () => {
		const ticks = [100, 250];
		let i = 0;
		const timer = createBootTimer(() => ticks[i++] ?? 0);
		expect(timer.elapsedMs()).toBe(150);
	});

	test("phase line shape matches the per-phase marker format", () => {
		const timer = createBootTimer(() => 0);
		expect(timer.phase("🚀", "server")).toMatch(/^.+ server \(\+\d+ms\)$/);
	});
});
