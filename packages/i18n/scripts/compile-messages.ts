/**
 * Compiles `messages/<locale>.json` into the Paraglide runtime at `src/paraglide`.
 *
 * A COMMITTED script rather than an `npx`/`bunx` invocation: CeraUI is Bun-only
 * and an ad-hoc package runner is banned by the workspace guardrails. It is also
 * the single place the byte-parity gate and (from plan todo 21) the frontend
 * build agree on compiler options.
 *
 * `outputStructure: "message-modules"` is passed EXPLICITLY. It happens to be the
 * 2.23.2 default, but the per-message module layout is a structural dependency of
 * the later barrel/namespace generator, so it is pinned here rather than inherited.
 *
 * The outdir is GENERATED and gitignored — never hand-edit it, and never commit it.
 * Plugin modules are fetched from the pinned jsdelivr URLs in
 * `project.inlang/settings.json` and cached under the (gitignored)
 * `project.inlang/cache`, so the first run on a clean tree needs network.
 *
 * Usage:  bun run --filter @ceraui/i18n compile-messages
 */

import { compile } from "@inlang/paraglide-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PARAGLIDE_OUTDIR = join(packageRoot, "src", "paraglide");

export async function compileMessages(): Promise<void> {
	await compile({
		project: join(packageRoot, "project.inlang"),
		outdir: PARAGLIDE_OUTDIR,
		outputStructure: "message-modules",
	});
}

if (import.meta.main) {
	await compileMessages();
	process.stdout.write(`compiled to ${PARAGLIDE_OUTDIR}\n`);
}
