import type { UplinkRouteManagerDeps } from "../modules/network/uplink-steering/route-manager.ts";
import captured from "./fixtures/iproute2-7.2-absent.json";

export function absentTableError(stderr = captured.ipv4): Error {
	return Object.assign(new Error("Command failed: ip route show table"), {
		code: 2,
		stdout: "",
		stderr,
	});
}

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
			const answer = answers[call.join(" ")];
			if (
				answer === undefined &&
				command === "ip" &&
				args.slice(0, 3).join(" ") === "route show table"
			) {
				throw absentTableError();
			}
			return answer ?? "";
		},
	};
}

export function hexMark(mark: number): string {
	return `0x${mark.toString(16).padStart(8, "0")}`;
}
