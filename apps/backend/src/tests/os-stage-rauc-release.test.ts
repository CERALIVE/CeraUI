import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { killAndRestartRaucForStream } from "../modules/system/update-orchestrator/stream-abort.ts";
import {
	okCommand,
	raucEscalationFixture,
	stoppingRauc,
} from "./helpers/rauc-escalation-fixture.ts";

const helper = "/usr/libexec/ceralive/ceralive-nbd-release";
const warn = spyOn(logger, "warn").mockImplementation(() => logger);
afterEach(() => warn.mockClear());
afterAll(() => warn.mockRestore());

test("NBD release that clears the stopping daemon prevents the final kill", async () => {
	// Given NBD release lets the queued restart complete.
	const f = raucEscalationFixture();
	let state = stoppingRauc;
	f.setReply(async (argv) => {
		if (argv[0] === helper)
			state = stoppingRauc.replace("deactivating", "active");
		return { ...okCommand, stdout: state };
	});
	await killAndRestartRaucForStream(f.run, f.scheduler);
	// When all deadlines pass.
	await f.advance(8000);
	// Then the helper ran once but no SIGKILL followed recovery.
	expect(f.commands.filter((argv) => argv[0] === helper)).toHaveLength(1);
	expect(f.commands.some((argv) => argv.includes("--signal=SIGKILL"))).toBe(
		false,
	);
	expect(f.pending()).toBe(0);
});

test.each(["nonzero", "throw"])(
	"NBD release %s warns but preserves the last-resort kill",
	async (failure) => {
		// Given the helper fails independently of stream admission.
		const f = raucEscalationFixture();
		f.setReply(async (argv) => {
			if (argv[0] === helper) {
				if (failure === "throw")
					throw new TypeError("injected helper spawn failure");
				return { ...okCommand, exitCode: 1 };
			}
			return { ...okCommand, stdout: stoppingRauc };
		});
		await killAndRestartRaucForStream(f.run, f.scheduler);
		// When helper failure occurs before the final look.
		await f.advance(3000);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(f.commands.some((argv) => argv.includes("--signal=SIGKILL"))).toBe(
			false,
		);
		await f.advance(8000);
		// Then exactly one fallback kill was still attempted.
		expect(
			f.commands.filter((argv) => argv.includes("--signal=SIGKILL")),
		).toHaveLength(1);
		expect(f.pending()).toBe(0);
	},
);

test.each([
	stoppingRauc.replace("123", "456"),
	stoppingRauc.replace("a".repeat(32), "b".repeat(32)),
	stoppingRauc.replace("deactivating", "active"),
])(
	"a replacement or active daemon after release cannot be killed: %s",
	async (third) => {
		// Given the helper was attempted for the confirmed old daemon.
		const f = raucEscalationFixture();
		await killAndRestartRaucForStream(f.run, f.scheduler);
		await f.advance(3000);
		f.setReply(async () => ({ ...okCommand, stdout: third }));
		// When the final read observes a replacement or completed restart.
		await f.advance(8000);
		// Then no final kill touches that daemon.
		expect(f.commands.filter((argv) => argv[0] === helper)).toHaveLength(1);
		expect(f.commands.some((argv) => argv.includes("--signal=SIGKILL"))).toBe(
			false,
		);
	},
);

test("a failed second TERM spawn leaves the first escalation armed", async () => {
	// Given one armed cancellation and a second call whose TERM cannot spawn.
	const f = raucEscalationFixture();
	await killAndRestartRaucForStream(f.run, f.scheduler);
	const failedTerm = new TypeError("injected TERM spawn failure");
	// When the later cancellation rejects before any TERM reply.
	await expect(
		killAndRestartRaucForStream(async () => {
			throw failedTerm;
		}, f.scheduler),
	).rejects.toBe(failedTerm);
	await f.advance(8000);
	// Then the earlier lifetime still releases and escalates.
	expect(f.commands.filter((argv) => argv[0] === helper)).toHaveLength(1);
	expect(
		f.commands.filter((argv) => argv.includes("--signal=SIGKILL")),
	).toHaveLength(1);
});

test("a held second TERM does not replace the earlier lifetime until its reply", async () => {
	// Given a first look already queued and a later TERM held open.
	const f = raucEscalationFixture();
	await killAndRestartRaucForStream(f.run, f.scheduler);
	const held = Promise.withResolvers<typeof okCommand>();
	f.setReply((argv) =>
		argv.includes("--signal=SIGTERM")
			? held.promise
			: Promise.resolve({ ...okCommand, stdout: stoppingRauc }),
	);
	const second = killAndRestartRaucForStream(f.run, f.scheduler);
	// When the earlier first look fires before the later TERM replies.
	await f.advance(1000);
	expect(f.commands.filter((argv) => argv.includes("show"))).toHaveLength(1);
	held.resolve(okCommand);
	await second;
	// Then exactly one replacement timer remains, not the old release timer too.
	expect(f.pending()).toBe(1);
	await f.advance(9000);
	expect(f.commands.filter((argv) => argv[0] === helper)).toHaveLength(1);
});

test("a held helper reply cannot postpone the T+8 last resort", async () => {
	// Given NBD release is submitted but its bounded runner has not replied.
	const f = raucEscalationFixture();
	const held = Promise.withResolvers<typeof okCommand>();
	const entered = Promise.withResolvers<void>();
	f.setReply((argv) => {
		if (argv[0] === helper) {
			entered.resolve();
			return held.promise;
		}
		return Promise.resolve({ ...okCommand, stdout: stoppingRauc });
	});
	await killAndRestartRaucForStream(f.run, f.scheduler);
	// When the final deadline passes while the helper is still pending.
	const release = f.advance(3000);
	await entered.promise;
	await f.advance(8000);
	// Then the final kill did not wait for the helper's ten-second timeout.
	expect(
		f.commands.filter((argv) => argv.includes("--signal=SIGKILL")),
	).toHaveLength(1);
	held.resolve(okCommand);
	await release;
	expect(f.pending()).toBe(0);
});
