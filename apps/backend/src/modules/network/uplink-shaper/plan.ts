import {
	SHAPER_CONFIG,
	type ShapedUplink,
	type ShaperMode,
} from "./contracts.ts";

export interface TcCommand {
	readonly argv: readonly string[];
}

export interface ShaperPlanInput {
	readonly mode: ShaperMode;
	readonly cakeAvailable: boolean;
	readonly uplinks: readonly ShapedUplink[];
}

export function buildShaperPlan(input: ShaperPlanInput): TcCommand[] {
	return [...input.uplinks]
		.sort((left, right) => left.ifname.localeCompare(right.ifname))
		.flatMap((uplink) =>
			input.mode === "idle"
				? [
						command(
							"qdisc",
							"replace",
							"dev",
							uplink.ifname,
							"root",
							"handle",
							SHAPER_CONFIG.rootHandle,
							"fq_codel",
						),
					]
				: streamingPlan(uplink, input.cakeAvailable),
		);
}

function streamingPlan(
	uplink: ShapedUplink,
	cakeAvailable: boolean,
): TcCommand[] {
	const root = SHAPER_CONFIG.rootHandle;
	const client = SHAPER_CONFIG.clientHandle;
	const commands = [
		command(
			"qdisc",
			"replace",
			"dev",
			uplink.ifname,
			"root",
			"handle",
			root,
			"prio",
			"bands",
			"2",
			"priomap",
			...Array.from({ length: 16 }, () => "0"),
		),
		command(
			"qdisc",
			"replace",
			"dev",
			uplink.ifname,
			"parent",
			`${root}1`,
			"handle",
			"ca10:",
			"fq_codel",
		),
		command(
			"filter",
			"replace",
			"dev",
			uplink.ifname,
			"parent",
			root,
			"protocol",
			"all",
			"priority",
			"10",
			"handle",
			`${hexMark(uplink.mark)}/${hexMark(SHAPER_CONFIG.markMask)}`,
			"fw",
			"flowid",
			`${root}2`,
		),
	];
	if (cakeAvailable) {
		commands.push(
			command(
				"qdisc",
				"replace",
				"dev",
				uplink.ifname,
				"parent",
				`${root}2`,
				"handle",
				client,
				"cake",
				"bandwidth",
				`${uplink.capBps}bit`,
			),
		);
		return commands;
	}
	commands.push(
		command(
			"qdisc",
			"replace",
			"dev",
			uplink.ifname,
			"parent",
			`${root}2`,
			"handle",
			client,
			"htb",
			"default",
			"1",
		),
		command(
			"class",
			"replace",
			"dev",
			uplink.ifname,
			"parent",
			client,
			"classid",
			SHAPER_CONFIG.clientClassId,
			"htb",
			"rate",
			`${uplink.capBps}bit`,
			"ceil",
			`${uplink.capBps}bit`,
		),
		command(
			"qdisc",
			"replace",
			"dev",
			uplink.ifname,
			"parent",
			SHAPER_CONFIG.clientClassId,
			"handle",
			"ca30:",
			"fq_codel",
		),
	);
	return commands;
}

function command(...argv: readonly string[]): TcCommand {
	return { argv };
}

function hexMark(mark: number): string {
	return `0x${(mark >>> 0).toString(16).padStart(8, "0")}`;
}
