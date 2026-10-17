import { join } from "node:path";
import {
	SETUP_CONFIG_DEFAULTS,
	type SetupConfig,
} from "../../helpers/config-schemas.ts";

/** Plain Bun children do not inherit the bun:test setup-module mock. */
export async function prepareUpdateTransportSetup(root: string): Promise<void> {
	await Bun.write(
		join(root, "setup.json"),
		JSON.stringify({
			...SETUP_CONFIG_DEFAULTS,
			hw: "rk3588",
		} satisfies SetupConfig),
	);
	process.chdir(root);
}
