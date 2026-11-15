import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { parseRecord, toLogEntry } from "../modules/device-logs/parse.ts";
import { classifyBoot } from "../modules/device-logs/shutdown-classifier.ts";

const helper = fileURLToPath(
	new URL(
		"../../test-harness/journal-conformance/assert-suppression.sh",
		import.meta.url,
	),
);
const fixture = new URL(
	"./fixtures/device-journal-suppression-257.json",
	import.meta.url,
);
const notice = {
	MESSAGE_ID: "a596d6fe7bfa4994828e72309e95d61e",
	MESSAGE: "Suppressed 5995 messages from rate-limited-flood.service",
	N_DROPPED: "5995",
};

async function validate(value: unknown, stored = 5): Promise<number> {
	const child = Bun.spawn(
		["bash", helper, "rate-limited-flood.service", "6000", String(stored)],
		{
			env: process.env,
			stdin: new Blob([JSON.stringify(value)]),
			stdout: "ignore",
			stderr: "pipe",
		},
	);
	const [code, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	if (stderr) throw new Error(stderr);
	return code;
}

test("the native notice assertion accepts the exact ID, unit and dropped count", async () => {
	expect(await validate(notice)).toBe(0);
});

test.each(
	[
		{ ...notice, MESSAGE_ID: "another-id" },
		{ ...notice, MESSAGE_ID: undefined },
		{ ...notice, N_DROPPED: "5994" },
		{
			...notice,
			MESSAGE: "Suppressed 5994 messages from rate-limited-flood.service",
		},
		{ ...notice, MESSAGE: "Suppressed 5995 messages from another.service" },
		null,
		[],
	].map((value) => ({ value })),
)(
	"the native notice assertion rejects inconsistent evidence %j",
	async ({ value }) => {
		expect(await validate(value)).toBe(1);
	},
);

test.each([6000, 6001])(
	"a stored count of %i cannot claim positive suppression",
	async (stored) => {
		const dropped = 6000 - stored;
		expect(
			await validate(
				{
					...notice,
					N_DROPPED: String(dropped),
					MESSAGE: `Suppressed ${dropped} messages from rate-limited-flood.service`,
				},
				stored,
			),
		).toBe(1);
	},
);

test("the actual systemd 257 notice reaches the wire as a gap and proves no shutdown", async () => {
	const captured: unknown = await Bun.file(fixture).json();
	const parsed = parseRecord(captured);
	if (!parsed) throw new Error("native suppression record was skipped");
	expect(parsed.messageId).toBe("a596d6fe7bfa4994828e72309e95d61e");
	expect(parsed.message).toBe(
		"Suppressed 5997 messages from rate-limited-flood.service",
	);
	expect(toLogEntry(parsed).marker).toBe("suppressed");
	expect(
		classifyBoot({
			isCurrent: false,
			tail: [parsed],
			nextBootHead: [],
			storeEvents: [],
		}),
	).toEqual({ shutdown: "unknown", evidence: ["too_few_entries"] });
});
