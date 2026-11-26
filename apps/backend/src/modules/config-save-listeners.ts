import type { RuntimeConfig } from "../helpers/config-schemas.ts";

type Listener = (config: RuntimeConfig) => void;

const listeners = new Set<Listener>();

/** Its own module, so `config.ts` can announce a save without importing the RPC layer. */
export function onConfigSave(listener: Listener): void {
	listeners.add(listener);
}

export function announceConfigSave(config: RuntimeConfig): void {
	for (const listener of listeners) listener(config);
}
