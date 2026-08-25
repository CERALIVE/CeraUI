import { SteeringUnavailableError } from "./contracts.ts";

export function routeUnavailable(
	ifname: string,
	detail: string,
): SteeringUnavailableError {
	return new SteeringUnavailableError(
		"policy_route_missing",
		`${ifname}: ${detail}`,
	);
}

export function asRouteError(
	ifname: string,
	error: unknown,
): SteeringUnavailableError {
	return error instanceof SteeringUnavailableError
		? error
		: routeUnavailable(
				ifname,
				error instanceof Error ? error.message : String(error),
			);
}
