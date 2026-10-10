import { run } from "../../helpers/run.ts";
import { isRealDevice } from "../system/device-detection.ts";
import {
	type DefaultRouteReleaseCondition,
	setDefaultRoute,
} from "./default-route.ts";
import { GatewayRouteError } from "./default-route-model.ts";

export class GatewayRoutePreference {
	#startup: Promise<void> | undefined;
	#stopped = false;

	constructor(private readonly runner: typeof run = run) {}

	start(): Promise<void> {
		if (this.#stopped)
			return Promise.reject(new GatewayRouteError("", "apply-failed"));
		this.#startup ??= setDefaultRoute(undefined, { runner: this.runner }).catch(
			(error: unknown) => {
				this.#startup = undefined;
				throw error;
			},
		);
		return this.#startup;
	}

	async apply(ifname: string | undefined, family: 4 | 6 = 4): Promise<void> {
		await this.start();
		if (this.#stopped)
			throw new GatewayRouteError(ifname ?? "", "apply-failed");
		await setDefaultRoute(ifname, { runner: this.runner, family });
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		// The shared runner queue drains already-submitted writes before this release.
		await setDefaultRoute(undefined, { runner: this.runner });
	}

	async release(condition: DefaultRouteReleaseCondition): Promise<void> {
		await this.start();
		if (this.#stopped) throw new GatewayRouteError("", "apply-failed");
		await setDefaultRoute(undefined, {
			runner: this.runner,
			releaseCondition: condition,
		});
	}
}

export const gatewayRoutePreference = new GatewayRoutePreference();

export async function initGatewayRoutes(): Promise<void> {
	if (await isRealDevice()) await gatewayRoutePreference.start();
}

export async function stopGatewayRoutes(): Promise<void> {
	if (await isRealDevice()) await gatewayRoutePreference.stop();
}
