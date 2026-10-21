/// <reference types="bun" />
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialNoticeLedger } from "../modules/system/update-orchestrator/credential-ledger.ts";
import { MAX_CREDENTIAL_GENERATIONS } from "../modules/system/update-orchestrator/credential-ledger-state.ts";

const observation = {
	kind: "known",
	expiresAt: 100,
	digest: "a".repeat(64),
} as const;
let root: string;
let path: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "credential-crash-"));
	path = join(root, "ledger.json");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function freshProcess() {
	const module = new URL(
		"../modules/system/update-orchestrator/credential-ledger.ts",
		import.meta.url,
	).href;
	const source = `import {CredentialNoticeLedger} from ${JSON.stringify(module)}; console.log(JSON.stringify(new CredentialNoticeLedger({path:${JSON.stringify(path)}}).observe(${JSON.stringify(observation)},100)))`;
	const command = Bun.spawn([process.execPath, "-e", source], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, error, code] = await Promise.all([
		new Response(command.stdout).text(),
		new Response(command.stderr).text(),
		command.exited,
	]);
	expect(code).toBe(0);
	expect(error).toBe("");
	return JSON.parse(output);
}

test.each(["pending", "active", "acknowledged"] as const)(
	"fresh process after %s restores only undismissed stable intent",
	async (lifecycle) => {
		// Given a persisted publication crash point; When a new Bun process loads; Then intent identity/acknowledgement survives.
		const ledger = new CredentialNoticeLedger({ path });
		const intent = ledger.observe(observation, 100).current;
		if (!intent) throw new Error("fixture intent missing");
		switch (lifecycle) {
			case "pending":
				break;
			case "active":
				ledger.activate(intent);
				break;
			case "acknowledged":
				ledger.acknowledge(intent);
				break;
			default: {
				const exhaustive: never = lifecycle;
				return exhaustive;
			}
		}
		const replay = await freshProcess();
		expect(replay.current).toEqual(
			lifecycle === "acknowledged" ? undefined : intent,
		);
	},
);

test("failed intent save cannot authorize publication", async () => {
	// Given a writer fault before intent persistence; When observed; Then no intent is returned or durable file invented.
	const ledger = new CredentialNoticeLedger({
		path,
		write: () => {
			throw new Error("write failed");
		},
	});
	expect(() => ledger.observe(observation, 100)).toThrow();
	expect(await Bun.file(path).exists()).toBe(false);
});

test("saturated history refuses new generation without evicting rollback acknowledgements", async () => {
	// Given the explicit capacity bound; When a new cert is seen; Then preserve every historical acknowledgement.
	const generations = Array.from(
		{ length: MAX_CREDENTIAL_GENERATIONS },
		(_, index) => ({
			digest: index.toString(16).padStart(64, "0"),
			id: randomUUID(),
			expiresAt: 100,
			notices: { expired: "acknowledged" },
		}),
	);
	const bytes = JSON.stringify({
		schema: 1,
		currentGeneration: null,
		generations,
	});
	await writeFile(path, bytes, { mode: 0o600 });
	expect(() =>
		new CredentialNoticeLedger({ path }).observe(observation, 100),
	).toThrow("capacity");
	expect(await readFile(path, "utf8")).toBe(bytes);
});

test("invalid UTF-8 is unknown authority, never reset", async () => {
	// Given invalid bytes in authority; When observed; Then keep those bytes and refuse.
	const bytes = Buffer.from([0xff, 0xfe]);
	await writeFile(path, bytes);
	expect(() =>
		new CredentialNoticeLedger({ path }).observe(observation, 100),
	).toThrow();
	expect(await readFile(path)).toEqual(bytes);
});
