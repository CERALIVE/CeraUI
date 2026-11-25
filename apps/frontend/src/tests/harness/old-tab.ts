/**
 * The frontend as it was before `config_clear` and the out-of-date page check,
 * read from git: what an open tab still runs after an update.
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

/** main just before the live-audio plan: the last handler with no `config_clear`. */
const OLD_TAB = "17dda165792862a009823440cb4b78e2812914d0";

/**
 * The old frontend's `src/lib` and `src/main`, importing each other, not
 * today's; only the shared packages (`@ceraui/rpc`, `@ceraui/i18n`) are today's.
 * The caller removes the returned directory.
 */
export function checkOutOldTab(): string {
	mkdirSync(".vitest", { recursive: true });
	const root = mkdtempSync(join(resolve("."), ".vitest/old-tab-"));
	const archive = execFileSync(
		"git",
		[
			"archive",
			`${OLD_TAB}:apps/frontend/src`,
			"lib",
			"main",
			":(exclude,glob)**/*.test.ts",
		],
		{ cwd: resolve("../.."), maxBuffer: 1 << 28 },
	);
	execFileSync("tar", ["-x", "-C", root], { input: archive });
	for (const entry of readdirSync(root, { recursive: true }) as string[]) {
		if (!/\.(ts|svelte)$/.test(entry)) continue;
		const path = join(root, entry);
		const source = readFileSync(path, "utf8");
		writeFileSync(
			path,
			source.replace(/(["'])\$(lib|main)(?=[/"'])/g, `$1${root}/$2`),
		);
	}
	return root;
}
