import type { UplinkRouteManagerDeps } from "../modules/network/uplink-steering/route-manager.ts";

export type ScriptedRouteDeps = UplinkRouteManagerDeps & {
	readonly calls: string[][];
};

export function scripted(
	answers: Readonly<Record<string, string>>,
): ScriptedRouteDeps {
	const calls: string[][] = [];
	return {
		calls,
		run: async (command, args) => {
			const call = [command, ...args];
			calls.push(call);
			return answers[call.join(" ")] ?? "";
		},
	};
}

export function hexMark(mark: number): string {
	return `0x${mark.toString(16).padStart(8, "0")}`;
}
