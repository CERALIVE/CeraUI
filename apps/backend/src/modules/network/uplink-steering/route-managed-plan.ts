import { argMatch, ID_RE } from "../../../helpers/run.ts";
import { parseDefaultRouteInterface } from "../connectivity-candidates.ts";
import { parseDefaultRouteLine } from "../gateways.ts";
import type { UplinkRoutePlan } from "./applier.ts";
import { MANAGED_TABLE_BASE } from "./mark-layout.ts";
import { routeUnavailable } from "./route-errors.ts";
import { parseHasDefaultRoute } from "./route-parsers.ts";
import type {
	UplinkRouteCandidate,
	UplinkRouteManagerDeps,
} from "./route-planner.ts";

/*
  A DUPLICATE-IP TWIN IS STEERED BY ITS MARK, NEVER BY ITS ADDRESS.

  The duplicate-MAC HiLink pair both lease `192.168.8.100`, so on this path the
  source address names a PAIR and every question asked of it is a coin flip: a
  `from <ip>` rule matches whichever twin the kernel likes, and two dispatcher
  rules for one address made the whole steering state refuse with "source address
  selects several tables". The source-rule dimension therefore carries no
  information about THIS device and is skipped outright rather than consulted and
  then second-guessed.

  What CAN name the device is the mark: `stableUplinkMark` keys on the twin's own
  port-anchored physical identity, so each twin gets a distinct mark, a distinct
  managed table, and a default route carrying its own `dev <ifname>` — the same
  fwmark machinery `route-policy.ts` already installs for every other uplink, and
  the routing twin of the `curl --interface` binding the health probe uses.

  Image PR #115 retired dispatcher source rules for every interface class.
  Unlike unique-address uplinks, twins must never create a source rule because
  the address cannot name one device. Each interface must own a default route.
*/
export async function planTwinRoute(
	candidate: UplinkRouteCandidate,
	deps: UplinkRouteManagerDeps,
): Promise<UplinkRoutePlan> {
	const routeOutput = await deps.run("ip", [
		"-4",
		"route",
		"show",
		"default",
		"dev",
		argMatch(ID_RE, candidate.ifname),
	]);
	if (!parseHasDefaultRoute(routeOutput)) {
		throw routeUnavailable(
			candidate.ifname,
			`shares source address ${candidate.sourceAddress} with another interface and has no default route of its own, so no per-interface rule can steer it`,
		);
	}
	return managedPlanFromRoute(
		candidate,
		managedTable(candidate.mark),
		routeOutput,
		undefined,
		true,
	);
}

export async function planManagedRoute(
	candidate: UplinkRouteCandidate,
	deps: UplinkRouteManagerDeps,
	sourceRulePriority: number | undefined,
): Promise<UplinkRoutePlan> {
	const routeOutput = await deps.run("ip", [
		"-4",
		"route",
		"show",
		"default",
		"dev",
		argMatch(ID_RE, candidate.ifname),
	]);
	return managedPlanFromRoute(
		candidate,
		managedTable(candidate.mark),
		routeOutput,
		sourceRulePriority,
		true,
	);
}

export function managedPlanFromRoute(
	candidate: UplinkRouteCandidate,
	table: string,
	defaultRoute: string,
	sourceRulePriority: number | undefined,
	devFiltered: boolean,
): UplinkRoutePlan {
	let defaultLine = defaultRoute
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("default"));
	if (defaultLine === undefined) {
		throw routeUnavailable(
			candidate.ifname,
			"interface has no discoverable default route",
		);
	}
	if (devFiltered) {
		const tokens = defaultLine.split(/\s+/);
		const devIndex = tokens.indexOf("dev");
		if (devIndex !== -1 && tokens[devIndex + 1] !== candidate.ifname) {
			throw routeUnavailable(
				candidate.ifname,
				"interface default route was unusable",
			);
		}
		// iproute2 omits the device clause when the query already filters by it.
		if (devIndex === -1) defaultLine += ` dev ${candidate.ifname}`;
	}
	const parsed = parseDefaultRouteLine(defaultLine);
	if (
		!parsed.ok ||
		parseDefaultRouteInterface(defaultLine) !== candidate.ifname
	) {
		throw routeUnavailable(
			candidate.ifname,
			"interface default route was unusable",
		);
	}
	return {
		...candidate,
		table,
		managed: true,
		...(sourceRulePriority === undefined ? {} : { sourceRulePriority }),
		defaultRouteArgv: [
			"route",
			"replace",
			"table",
			table,
			...parsed.value.slice(2),
		],
	};
}

export function managedTable(mark: number): string {
	return String(MANAGED_TABLE_BASE + ((mark >>> 8) & 0xffff));
}
