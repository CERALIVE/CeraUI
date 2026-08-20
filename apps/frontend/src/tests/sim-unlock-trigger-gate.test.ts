/**
 * SIM-unlock trigger placement gate (todo 46).
 *
 * The unlock dialog is reached by an OPERATOR ACTION on the modem it belongs to
 * — never by a global effect that pops it over the whole Network destination.
 *
 * The auto-open this replaced was not merely disruptive once. `Sim.SendPin`
 * verifies for the current UICC power session only, ModemManager keeps no PIN
 * cache, and the single persistent mechanism (`EnablePin(pin, false)`) has no
 * PIN2 equivalent — so a `sim-pin2` lock returns on EVERY boot, forever, for a
 * credential that blocks no traffic. An auto-prompt for it is a nag the
 * operator can never silence, which is why it is gone rather than debounced.
 *
 * This scans the shipped `NetworkView` source and fails if an auto-open ever
 * reappears, so the regression cannot land quietly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SELF = fileURLToPath(import.meta.url);
const SRC_ROOT = path.resolve(path.dirname(SELF), "..");
const NETWORK_VIEW = path.join(SRC_ROOT, "main", "NetworkView.svelte");

const source = readFileSync(NETWORK_VIEW, "utf8");

/** Strip comments so the prose explaining the removal cannot satisfy the scan. */
function stripComments(text: string): string {
	return text
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^[ \t]*\/\/.*$/gm, "");
}

const code = stripComments(source);

describe("SIM-unlock trigger placement (todo 46)", () => {
	it("NetworkView opens the unlock dialog from an explicit action, not an effect", () => {
		// The dialog's open-flag must be raised only inside a named function the
		// row's button calls. An `$effect` that writes it is the auto-open.
		const effectBlocks =
			code.match(/\$effect\(\(\)\s*=>\s*\{[\s\S]*?\n\t*\}\);/g) ?? [];
		for (const block of effectBlocks) {
			expect(
				block.includes("simUnlockOpen"),
				"an $effect must never raise simUnlockOpen — that is the removed auto-open",
			).toBe(false);
		}
	});

	it("keeps no auto-prompt bookkeeping state", () => {
		// `promptedModemId` existed solely to stop the auto-open re-firing after a
		// dismiss. Its return would mean the auto-open returned with it.
		expect(code).not.toMatch(/promptedModemId/);
	});

	it("does not derive a single page-wide 'the locked modem' entry", () => {
		// The old trigger was `modemEntries.find(...)`-based, so with two locked
		// modems the second was unreachable no matter what the operator did.
		expect(code).not.toMatch(/lockedModemEntry/);
	});

	it("routes the row action on the SAME lock the button was labelled from", () => {
		// Label and destination are derived from one rule, so they cannot drift.
		expect(code).toMatch(/isBlockingSimLock/);
		expect(code).toMatch(/openSimUnlock/);
	});

	it("the scan actually catches the auto-open it forbids", () => {
		// A gate that cannot fail proves nothing. This replants the exact effect
		// that was removed and asserts the detector rejects it.
		const relapse = [
			"$effect(() => {",
			"\tif (lockedModemId && promptedModemId !== lockedModemId) {",
			"\t\tpromptedModemId = lockedModemId;",
			"\t\tsimUnlockOpen = true;",
			"\t}",
			"});",
		].join("\n");
		const blocks =
			relapse.match(/\$effect\(\(\)\s*=>\s*\{[\s\S]*?\n\t*\}\);/g) ?? [];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toContain("simUnlockOpen");
	});

	it("the comment stripper cannot be fooled by prose naming the old symbols", () => {
		// The file's own explanation mentions the removed identifiers; if the
		// stripper missed them the two absence assertions above would false-fail.
		expect(stripComments("// promptedModemId = id;\nconst a = 1;")).not.toMatch(
			/promptedModemId/,
		);
		expect(stripComments("<!-- lockedModemEntry -->\n<div />")).not.toMatch(
			/lockedModemEntry/,
		);
	});
});
