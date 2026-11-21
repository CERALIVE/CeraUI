import { expect, test } from "bun:test";
import { progressFromWire } from "../modules/system/update-orchestrator/package-progress.ts";

test("orchestrator package percentage is the number APT reported for the phase", () => {
	expect(
		progressFromWire({
			total: 1,
			downloading: 1,
			unpacking: 0,
			setting_up: 0,
			percent: 41,
		}),
	).toEqual({ percent: 41, etaSeconds: 0 });
	expect(
		progressFromWire({
			total: 1,
			downloading: 0,
			unpacking: 0,
			setting_up: 1,
			percent: 99,
		}),
	).toEqual({ percent: 99, etaSeconds: 0 });
});

test("orchestrator exposes no package percentage until APT reports one", () => {
	expect(
		progressFromWire({ total: 0, downloading: 0, unpacking: 0, setting_up: 0 }),
	).toBeNull();
	expect(
		progressFromWire({ total: 1, downloading: 0, unpacking: 0, setting_up: 1 }),
	).toBeNull();
});
