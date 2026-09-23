import type {
	DeviceKind,
	SessionSwitchTarget,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { formatCaptureMode, STANDBY_LEG_ID } from "./capture-failover";
import { findSourceById } from "./sourceSummary";

export interface LiveSwitchRow {
	readonly id: string;
	readonly displayName: string;
	readonly labelKey?: string;
	readonly kind: DeviceKind;
	readonly lost: boolean;
	/** The target's reported source mode ("1080p30"); absent when unreported. */
	readonly mode?: string;
}

export function liveSwitchRows(
	targets: readonly SessionSwitchTarget[],
	sources: readonly StreamSource[],
): LiveSwitchRow[] {
	const rows: LiveSwitchRow[] = [];
	for (const target of targets) {
		if (target.input_id === STANDBY_LEG_ID) continue;
		const mode = formatCaptureMode(
			target.source_width,
			target.source_height,
			target.source_framerate,
		);
		const modeField = mode === undefined ? {} : { mode };
		const source = findSourceById(target.input_id, sources);
		switch (target.kind) {
			case "capture":
				rows.push({
					id: target.input_id,
					displayName:
						source?.origin === "capture" ? source.displayName : target.input_id,
					kind: source?.origin === "capture" ? source.kind : "other",
					lost: false,
					...modeField,
				});
				break;
			case "synthetic":
				rows.push({
					id: target.input_id,
					displayName: target.input_id,
					labelKey: "settings.sources.test",
					kind: "test",
					lost: false,
					...modeField,
				});
				break;
			case "network":
				rows.push({
					id: target.input_id,
					displayName: target.input_id,
					labelKey: "live.inputPicker.groups.network",
					kind: "network",
					lost: false,
					...modeField,
				});
				break;
			default: {
				const exhaustive: never = target.kind;
				return exhaustive;
			}
		}
	}
	return rows;
}
