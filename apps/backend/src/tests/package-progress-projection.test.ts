import { expect, test } from "bun:test";
import { progressFromWire } from "../modules/system/update-orchestrator/package-progress.ts";

test("orchestrator package percentage uses completed steps and stays below 100%", () => {
	expect(
		progressFromWire({ total: 2, downloading: 2, unpacking: 2, setting_up: 1 }),
	).toEqual({ percent: 66, etaSeconds: 0 });
	expect(
		progressFromWire({
			total: 67,
			downloading: 67,
			unpacking: 67,
			setting_up: 67,
		}),
	).toEqual({ percent: 99, etaSeconds: 0 });
});

test("orchestrator exposes no package percentage during acquisition or unknown install", () => {
	expect(
		progressFromWire({ total: 1, downloading: 1, unpacking: 0, setting_up: 0 }),
	).toBeNull();
	expect(
		progressFromWire({ total: 0, downloading: 0, unpacking: 1, setting_up: 1 }),
	).toBeNull();
});
