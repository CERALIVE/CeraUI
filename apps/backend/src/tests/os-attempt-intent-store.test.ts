import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncOrchestratorDirectory } from "../modules/system/update-orchestrator/orchestrator-directory-sync.ts";
import { OsAttemptIntentStore } from "../modules/system/update-orchestrator/os-attempt-intent-store.ts";
import { attemptIntent } from "./helpers/os-attempt-intent-fixture.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});
function fixture(syncParent = syncOrchestratorDirectory) {
	const dir = mkdtempSync(join(tmpdir(), "os-attempt-intent-"));
	roots.push(dir);
	const path = join(dir, "intent.json");
	const uid = process.getuid?.() ?? 0;
	return {
		dir,
		path,
		uid,
		store: new OsAttemptIntentStore({ path, uid, syncParent }),
	};
}

test("durable private intent round-trips both phases and retires only its exact record", () => {
	// Given a valid pre-effect authority.
	const f = fixture();
	const publishing = attemptIntent();
	// When its phase advances through atomic publication.
	f.store.write(publishing, null);
	const launching = { ...publishing, phase: "launching" as const };
	f.store.write(launching, publishing);
	// Then another reader sees exact restart authority with private permissions.
	expect(new OsAttemptIntentStore({ path: f.path, uid: f.uid }).read()).toEqual(
		launching,
	);
	expect(statSync(f.path).mode & 0o777).toBe(0o600);
	expect(() => f.store.retire(publishing)).toThrow();
	f.store.retire(launching);
	expect(f.store.read()).toBeNull();
});

test("post-rename fsync failure preserves complete intent without authorizing continuation", () => {
	// Given a parent-fsync fault after rename.
	const f = fixture(() => {
		throw new Error("intent parent fsync");
	});
	const intent = attemptIntent();
	// When the write is attempted.
	expect(() => f.store.write(intent, null)).toThrow();
	// Then disk holds only a whole, parseable document for restart recovery.
	expect(f.store.read()).toEqual(intent);
});

for (const corruption of [
	"json",
	"foreign",
	"candidate",
	"baseline",
	"mode",
	"uid",
	"oversize",
	"symlink",
]) {
	test(`refuses and preserves ${corruption} intent authority`, () => {
		// Given untrusted authority at the private boundary.
		const f = fixture();
		const intent = attemptIntent();
		f.store.write(intent, null);
		switch (corruption) {
			case "json":
				writeFileSync(f.path, "{");
				break;
			case "foreign":
				writeFileSync(f.path, JSON.stringify({ ...intent, foreign: true }));
				break;
			case "candidate":
				writeFileSync(
					f.path,
					JSON.stringify({
						...intent,
						manifest: { ...intent.manifest, version: "2026.10.99" },
					}),
				);
				break;
			case "baseline":
				writeFileSync(
					f.path,
					JSON.stringify({
						...intent,
						before: {
							...intent.before,
							packageCheck: {
								...intent.before.packageCheck,
								nextAttemptAt: 999,
							},
						},
					}),
				);
				break;
			case "mode":
				chmodSync(f.path, 0o644);
				break;
			case "uid":
				break;
			case "oversize":
				writeFileSync(f.path, " ".repeat(65_537));
				break;
			case "symlink":
				rmSync(f.path);
				symlinkSync(join(f.dir, "foreign"), f.path);
				break;
		}
		const store =
			corruption === "uid"
				? new OsAttemptIntentStore({ path: f.path, uid: f.uid + 1 })
				: f.store;
		const bytes = corruption === "symlink" ? null : readFileSync(f.path);
		// When an untrusted record is read or replaced.
		expect(() => store.read()).toThrow();
		expect(() => store.write(intent, null)).toThrow();
		// Then rejection never edits the evidence.
		if (bytes) expect(readFileSync(f.path)).toEqual(bytes);
	});
}
