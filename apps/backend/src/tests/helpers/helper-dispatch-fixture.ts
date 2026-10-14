import type { AddonHelperDeps } from "../../helpers/addon-helper.ts";
import {
	addonDisable,
	addonEnable,
	addonRefresh,
} from "../../helpers/addon-helper.ts";
import { setSysextEvidenceForTest } from "../../modules/addons/disruptive-sysext-step.ts";
import { setDisruptiveRetryClockForTest } from "../../modules/system/disruptive-retry.ts";
import { sysextFixture } from "../sysext-action-fixture.ts";

export type HelperAction = "enable" | "disable" | "refresh";
export function invokeHelperAction(
	action: HelperAction,
	deps: AddonHelperDeps,
): Promise<string> {
	switch (action) {
		case "enable":
			return addonEnable("cog-display", deps);
		case "disable":
			return addonDisable("cog-display", deps);
		case "refresh":
			return addonRefresh(deps);
		default: {
			const exhaustive: never = action;
			return exhaustive;
		}
	}
}

export function helperDispatchFixture() {
	const owner = sysextFixture();
	const wakeups: Array<() => Promise<void>> = [];
	const delays: number[] = [];
	const units: string[] = [];
	setDisruptiveRetryClockForTest({
		schedule: (run, ms) => {
			wakeups.push(run);
			delays.push(ms);
			return () => undefined;
		},
	});
	setSysextEvidenceForTest({
		probe: async (scope) => {
			units.push(scope.unit);
			return "completed";
		},
	});
	return {
		wakeups,
		delays,
		units,
		reset: () => {
			setDisruptiveRetryClockForTest(null);
			owner.reset();
		},
	};
}

export const launchErrno = (code: string) =>
	Object.assign(new Error("original launch fault"), { code });
