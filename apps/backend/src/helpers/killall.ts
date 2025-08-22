import { spawnSync } from "node:child_process";

import { setup } from "../modules/setup.ts";

const killallBinary = setup.killall_binary ?? "killall";

export default function killall(args: Readonly<Array<string>>) {
	return spawnSync(killallBinary, args);
}
