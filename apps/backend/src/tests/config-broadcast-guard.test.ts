/**
 * A `config` frame sent around `broadcastConfig` names no cleared key, so the
 * clear it carries rests on the save check alone. A writer added on another
 * branch fails here, in whichever of the two branches lands second.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const SRC = new URL("../", import.meta.url).pathname;
const RAW = /\bbroadcast(?:Msg\w*)?\(\s*["'`]config["'`]/g;

test("only broadcastConfig broadcasts a config frame", () => {
	const raw = [...new Glob("**/*.ts").scanSync(SRC)]
		.filter((file) => !file.startsWith("tests/") && !file.endsWith(".test.ts"))
		.flatMap((file) => {
			const code = readFileSync(`${SRC}${file}`, "utf8").replace(
				/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
				"",
			);
			return [...code.matchAll(RAW)].map(() => file);
		});

	expect(raw).toEqual(["rpc/config-broadcast.ts"]);
});
