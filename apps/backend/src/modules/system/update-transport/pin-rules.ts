import { argMatch, ID_RE, type run } from "../../../helpers/run.ts";
import { parseDefaultRouteInterface } from "../../network/connectivity-candidates.ts";
import { parseDefaultRouteLine } from "../../network/default-route.ts";
import type { Family, RankedTransport } from "./core.ts";

// Steering's route planner allocates 30000 + every 16-bit mark id (through 95535).
export const UPDATE_TRANSPORT_TABLE_BASE = 100_000 as const;
export const UPDATE_TRANSPORT_RULE_PRIORITY = 120 as const;
export type UpdateJob = "apt" | "os";

export class UpdatePinError extends Error {
	constructor(
		readonly reason:
			| "capabilities-unavailable"
			| "busy"
			| "no-transport"
			| "route-unavailable"
			| "foreign-rule"
			| "sweep-required",
	) {
		super(`update routing: ${reason}`);
		this.name = "UpdatePinError";
	}
}

const tableFor = (job: UpdateJob): number =>
	UPDATE_TRANSPORT_TABLE_BASE + (job === "apt" ? 0 : 1);
const familyArgs = (family: Family): string[] => (family === 6 ? ["-6"] : []);

function ruleArgs(
	action: "add" | "del",
	uid: number,
	table: number | undefined,
): string[] {
	return [
		"rule",
		action,
		"priority",
		String(UPDATE_TRANSPORT_RULE_PRIORITY),
		"uidrange",
		`${uid}-${uid}`,
		...(table === undefined ? ["prohibit"] : ["lookup", String(table)]),
	];
}

async function deleteRule(runner: typeof run, args: string[]): Promise<void> {
	try {
		await runner("ip", args);
	} catch (error) {
		const stderr: unknown =
			error instanceof Error && "stderr" in error ? error.stderr : undefined;
		if (
			typeof stderr !== "string" ||
			!stderr.includes("No such file or directory")
		)
			throw error;
	}
}

async function flushTable(
	runner: typeof run,
	family: Family,
	table: number,
): Promise<void> {
	try {
		await runner("ip", [
			...familyArgs(family),
			"route",
			"flush",
			"table",
			String(table),
		]);
	} catch (error) {
		const stderr: unknown =
			error instanceof Error && "stderr" in error ? error.stderr : undefined;
		if (
			typeof stderr !== "string" ||
			!stderr.includes("FIB table does not exist")
		)
			throw error;
	}
}

async function routeFor(
	transport: RankedTransport,
	runner: typeof run,
): Promise<string[]> {
	const family = familyArgs(transport.family);
	const ifname = argMatch(ID_RE, transport.candidate.ifname);
	const main = await runner("ip", [...family, "route", "show", "default"]);
	const matching = main
		.split("\n")
		.find((line) => parseDefaultRouteInterface(line) === ifname);
	const line =
		matching ??
		(
			await runner("ip", [
				...family,
				"route",
				"show",
				"table",
				ifname,
				"default",
			])
		).trim();
	const parsed = parseDefaultRouteLine(line);
	if (
		!parsed.ok ||
		line.includes("\n") ||
		parseDefaultRouteInterface(line) !== ifname
	)
		throw new UpdatePinError("route-unavailable");
	// A metric inherited from the main table must not outrank the unreachable floor.
	const metricAt = parsed.value.indexOf("metric");
	return metricAt < 0
		? parsed.value
		: parsed.value.filter(
				(_, index) => index !== metricAt && index !== metricAt + 1,
			);
}

export async function runPinnedStep<T>(input: {
	readonly job: UpdateJob;
	readonly uid: number;
	readonly transport: RankedTransport;
	readonly step: (
		transport: RankedTransport,
		aptFlags: readonly string[],
	) => Promise<T>;
	readonly runner: typeof run;
}): Promise<T> {
	const { job, uid, transport, step, runner } = input;
	const table = tableFor(job);
	const chosen = familyArgs(transport.family);
	const other = familyArgs(transport.family === 4 ? 6 : 4);
	const route = await routeFor(transport, runner);
	const installed: string[][] = [];
	let outcome:
		| { readonly ok: true; readonly value: T }
		| { readonly ok: false; readonly error: unknown } = {
		ok: false,
		error: new UpdatePinError("route-unavailable"),
	};
	const failures: unknown[] = [];
	try {
		await flushTable(runner, transport.family, table);
		// A removed DHCP default must NOT fall through to main during a transfer.
		await runner("ip", [
			...chosen,
			"route",
			"add",
			"unreachable",
			"default",
			"table",
			String(table),
			"metric",
			"4278198272",
		]);
		await runner("ip", [
			...chosen,
			...route,
			"table",
			String(table),
			"metric",
			"0",
		]);
		installed.push([...other, ...ruleArgs("del", uid, undefined)]);
		await runner("ip", [...other, ...ruleArgs("add", uid, undefined)]);
		installed.push([...chosen, ...ruleArgs("del", uid, table)]);
		await runner("ip", [...chosen, ...ruleArgs("add", uid, table)]);
		outcome = {
			ok: true,
			value: await step(
				transport,
				job === "apt"
					? ["-o", `Acquire::ForceIPv${transport.family}=true`]
					: [],
			),
		};
	} catch (error) {
		outcome = { ok: false, error };
	} finally {
		for (const args of installed.reverse()) {
			try {
				await deleteRule(runner, args);
			} catch (error) {
				failures.push(error);
			}
		}
		for (const family of [4, 6] as const) {
			try {
				await flushTable(runner, family, table);
			} catch (error) {
				failures.push(error);
			}
		}
	}
	if (failures.length)
		throw new AggregateError(
			outcome.ok ? failures : [outcome.error, ...failures],
			"update routing teardown failed",
		);
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}

export async function sweepUpdateRules(runner: typeof run): Promise<void> {
	// Priority 120 is reserved; reject another owner's rule rather than delete it.
	for (const family of [4, 6] as const) {
		const prefix = familyArgs(family);
		const output = await runner("ip", [...prefix, "rule", "show"]);
		for (const line of output.split("\n")) {
			if (!/^\s*120:/.test(line)) continue;
			const match = line.match(
				/^\s*120:\s+from all uidrange (\d+)-\1 (?:lookup (\d+)|prohibit)\s*$/,
			);
			if (
				!match ||
				(match[2] !== undefined &&
					![tableFor("apt"), tableFor("os")].includes(Number(match[2])))
			)
				throw new UpdatePinError("foreign-rule");
			await runner("ip", [
				...prefix,
				...ruleArgs(
					"del",
					Number(match[1]),
					match[2] === undefined ? undefined : Number(match[2]),
				),
			]);
		}
	}
	for (const family of [4, 6] as const)
		for (const job of ["apt", "os"] as const)
			await flushTable(runner, family, tableFor(job));
}
