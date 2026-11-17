import assert from "node:assert/strict";
import {
	appendFile,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";

type Schedule = "restore" | "atomic" | "before" | "version";
type State = {
	readonly secret: string;
	readonly uuid?: string;
	readonly filename?: string;
	readonly schedule?: Schedule;
	readonly blocked?: string;
};

export async function runNativeNmcliShim(root: string): Promise<void> {
	const state: State = JSON.parse(
		await readFile(join(root, "state.json"), "utf8"),
	);
	const args = process.argv.slice(2);
	if (
		args.some((arg) => arg.includes(state.secret)) ||
		Object.values(process.env).some((value) => value?.includes(state.secret))
	) {
		process.stderr.write("native nmcli sentinel exposure\n");
		process.exitCode = 90;
		return;
	}
	const up = args.indexOf("up");
	const modify = args.indexOf("modify");
	const uuid = args[(up >= 0 ? up : modify) + 1];
	await appendFile(
		join(root, "events.jsonl"),
		`${JSON.stringify({
			kind:
				up >= 0
					? "up"
					: modify >= 0
						? "modify"
						: args.includes("load")
							? "load"
							: "read",
			uuid,
			argvClean: true,
			environmentClean: true,
		})}\n`,
		{ mode: 0o600 },
	);
	if (up >= 0 && uuid === state.blocked) {
		process.stderr.write("native scheduled activation refusal\n");
		process.exitCode = 10;
		return;
	}
	const interfered =
		modify >= 0 && uuid === state.uuid && state.schedule && state.filename;
	if (interfered && state.schedule === "before")
		await writeFile(
			state.filename,
			`${await readFile(state.filename, "utf8")}\n# native foreign edit\n`,
		);
	const input = args.includes("--offline") ? await Bun.stdin.text() : undefined;
	const child = Bun.spawn(["/usr/bin/nmcli", ...args], {
		env: process.env,
		stdin: input === undefined ? "ignore" : new Response(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (interfered && code === 0) {
		const staged = join(root, "before.nmconnection");
		if (state.schedule === "restore")
			await writeFile(state.filename, await readFile(staged));
		if (state.schedule === "atomic") {
			const { rename } = await import("node:fs/promises");
			await rename(staged, state.filename);
		}
		if (state.schedule === "version") {
			const update = Bun.spawn(
				["/usr/bin/nmcli", "-w", "10", "con", "up", uuid ?? ""],
				{
					env: process.env,
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
				},
			);
			assert.equal(await update.exited, 0);
		}
		await writeFile(
			join(root, "foreign.nmconnection"),
			await readFile(state.filename),
			{ mode: 0o600 },
		);
		await writeFile(
			join(root, "state.json"),
			JSON.stringify({
				secret: state.secret,
				...(state.blocked ? { blocked: state.blocked } : {}),
			}),
			{ mode: 0o600 },
		);
	}
	process.stdout.write(stdout);
	process.stderr.write(stderr.replaceAll(state.secret, "<redacted>"));
	process.exitCode = code;
}

/** Guest-only instrumentation observes native child argv/environment and schedules exact windows. */
export async function installNativeNmcliShim(secret: string) {
	assert.equal(process.env.HWSIM_REPO, "/repo");
	assert.equal(process.getuid?.(), 0);
	const root = await mkdtemp("/run/cerab7-nmcli-");
	const prior = process.env.PATH;
	let state: State = { secret };
	await writeFile(join(root, "state.json"), JSON.stringify(state), {
		mode: 0o600,
	});
	await writeFile(join(root, "events.jsonl"), "", { mode: 0o600 });
	await writeFile(
		join(root, "nmcli"),
		`#!/usr/bin/env bun
import {runNativeNmcliShim} from ${JSON.stringify(import.meta.url)};
await runNativeNmcliShim(${JSON.stringify(root)});
`,
		{ mode: 0o700 },
	);
	// Bun's env-less product runner resolves commands against its startup PATH.
	const launcher = "/usr/local/bin/nmcli";
	try {
		await symlink(join(root, "nmcli"), launcher);
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}
	process.env.PATH = `${root}:${prior ?? ""}`;
	return {
		schedule: async (uuid: string, filename: string, schedule: Schedule) => {
			await writeFile(
				join(root, "before.nmconnection"),
				await readFile(filename),
				{ mode: 0o600 },
			);
			state = { secret, uuid, filename, schedule };
			await writeFile(join(root, "state.json"), JSON.stringify(state), {
				mode: 0o600,
			});
		},
		block: async (uuid?: string) => {
			state = { secret, ...(uuid ? { blocked: uuid } : {}) };
			await writeFile(join(root, "state.json"), JSON.stringify(state), {
				mode: 0o600,
			});
		},
		events: async (): Promise<
			readonly { readonly kind: string; readonly uuid?: string }[]
		> => {
			const bytes = await readFile(join(root, "events.jsonl"), "utf8");
			const complete = bytes.lastIndexOf("\n");
			return complete < 0
				? []
				: bytes
						.slice(0, complete)
						.split("\n")
						.filter(Boolean)
						.map((line: string) => JSON.parse(line));
		},
		foreign: () => readFile(join(root, "foreign.nmconnection")),
		close: async () => {
			if (prior === undefined) delete process.env.PATH;
			else process.env.PATH = prior;
			await rm(launcher);
			await rm(root, { recursive: true, force: true });
		},
	};
}

export type NativeNmcliProbe = Awaited<
	ReturnType<typeof installNativeNmcliShim>
>;
