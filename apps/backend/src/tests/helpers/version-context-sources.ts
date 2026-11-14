import { spyOn } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as exec from "../../helpers/exec.ts";
import { srtlaSendExec } from "../../modules/streaming/streamloop.ts";
import {
	getRevisions,
	initRevisions,
	setEngineVersionProbe,
} from "../../modules/system/revisions.ts";
import * as stored from "../../modules/system/update-orchestrator/stored-state-file.ts";

export async function versionSourceHarness() {
	const root = await mkdtemp(join(tmpdir(), "version-sources-"));
	const paths = {
		os: join(root, "os"),
		legacy: join(root, "legacy"),
		model: join(root, "model"),
		rauc: join(root, "rauc-output"),
		sender: join(root, "sender-output"),
		version: join(root, "version"),
		build: join(root, "revision"),
	};
	const mapping = new Map([
		["/etc/ceralive/os-release-version", paths.os],
		["/etc/ceralive_img_version", paths.legacy],
		["/proc/device-tree/model", paths.model],
		["version", paths.version],
		["revision", paths.build],
	]);
	const savedEnv = {
		NODE_ENV: process.env.NODE_ENV,
		MOCK_MODE: process.env.MOCK_MODE,
	};
	process.env.NODE_ENV = "test";
	delete process.env.MOCK_MODE;
	await Bun.write(paths.os, "2026.11.50\n");
	await Bun.write(paths.legacy, "2026.10.9\n");
	await Bun.write(paths.model, " Model\0 one\0 \n");
	await Bun.write(paths.rauc, '{"booted":"B","compatible":"board"}');
	await Bun.write(paths.sender, "sender-before\n");
	await Bun.write(paths.version, "2026.11.3\n");
	await Bun.write(paths.build, "running-build\n");
	const rauc = join(root, "rauc");
	const sender = join(root, "sender");
	await Bun.write(
		rauc,
		`#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = status ] && [ "$2" = --output-format=json ] || exit 64\ncat '${paths.rauc}'\nprintf '%s\\n' '{"booted":"WRONG","compatible":"wrong-channel"}' >&2\n`,
	);
	await Bun.write(
		sender,
		`#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = -v ] || exit 64\ncat '${paths.sender}'\n`,
	);
	await chmod(rauc, 0o700);
	await chmod(sender, 0o700);
	const realFile = Bun.file;
	const realStored = stored.readStoredStateFile;
	const realExec = exec.execFileP;
	let commandCount = 0;
	const state = spyOn(stored, "readStoredStateFile").mockImplementation(
		(path, limit) => realStored(mapping.get(path) ?? path, limit),
	);
	const files = spyOn(Bun, "file").mockImplementation((path, options) => {
		if (typeof path === "string")
			return realFile(mapping.get(path) ?? path, options);
		if (typeof path === "number") return realFile(path, options);
		if (path instanceof URL) return realFile(path, options);
		return realFile(path, options);
	});
	const commands = spyOn(exec, "execFileP").mockImplementation(
		(file, args, options) => {
			commandCount += 1;
			return realExec(
				file === "rauc" ? rauc : file === srtlaSendExec ? sender : file,
				args,
				options,
			);
		},
	);
	let liveEngine: string | undefined = "engine-before";
	let probes = 0;
	setEngineVersionProbe(async () => {
		probes += 1;
		return liveEngine;
	});
	const snapshot = { ...getRevisions() };
	for (const key of Object.keys(getRevisions())) delete getRevisions()[key];
	await initRevisions();
	const initialized = { ...getRevisions() };
	return {
		paths,
		initialized,
		setEngine: (value: string | undefined) => {
			liveEngine = value;
		},
		probes: () => probes,
		commands: () => commandCount,
		write: async (path: string, value: string | undefined | "unreadable") => {
			await rm(path, { force: true, recursive: true });
			if (value === "unreadable") await mkdir(path);
			else if (value !== undefined) await Bun.write(path, value);
		},
		[Symbol.asyncDispose]: async () => {
			commands.mockRestore();
			files.mockRestore();
			state.mockRestore();
			setEngineVersionProbe(null);
			for (const key of Object.keys(getRevisions())) delete getRevisions()[key];
			Object.assign(getRevisions(), snapshot);
			for (const key of ["NODE_ENV", "MOCK_MODE"] as const) {
				if (savedEnv[key] === undefined) delete process.env[key];
				else process.env[key] = savedEnv[key];
			}
			await rm(root, { recursive: true, force: true });
		},
	};
}
