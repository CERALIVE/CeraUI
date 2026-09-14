import type {
	DeviceKind,
	SessionSwitchTarget,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { findSourceById } from "./sourceSummary";

export interface LiveSwitchRow {
	readonly id: string;
	readonly displayName: string;
	readonly labelKey?: string;
	readonly kind: DeviceKind;
	readonly lost: boolean;
}

export function liveSwitchRows(
	targets: readonly SessionSwitchTarget[],
	sources: readonly StreamSource[],
): LiveSwitchRow[] {
	return targets.map((target) => {
		const source = findSourceById(target.input_id, sources);
		switch (target.kind) {
			case "capture":
				return {
					id: target.input_id,
					displayName:
						source?.origin === "capture" ? source.displayName : target.input_id,
					kind: source?.origin === "capture" ? source.kind : "other",
					lost: false,
				};
			case "synthetic":
				return {
					id: target.input_id,
					displayName: target.input_id,
					labelKey: "settings.sources.test",
					kind: "test",
					lost: false,
				};
			case "network":
				return {
					id: target.input_id,
					displayName: target.input_id,
					labelKey: "live.inputPicker.groups.network",
					kind: "network",
					lost: false,
				};
			default: {
				const exhaustive: never = target.kind;
				return exhaustive;
			}
		}
	});
}
