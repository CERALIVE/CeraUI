import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import { killAndRestartRaucForStream } from "../modules/system/update-orchestrator/stream-abort.ts";
import {
	okCommand,
	raucEscalationFixture,
	stoppingRauc,
} from "./helpers/rauc-escalation-fixture.ts";

const term = ["systemctl", "kill", "--signal=SIGTERM", "rauc.service"];
const restart = ["systemctl", "restart", "--no-block", "rauc.service"];
const release = ["/usr/libexec/ceralive/ceralive-nbd-release"];
const show = [
	"systemctl",
	"show",
	"-p",
	"ActiveState",
	"-p",
	"MainPID",
	"-p",
	"InvocationID",
	"rauc.service",
];
const forceKill = [
	"systemctl",
	"kill",
	"--signal=SIGKILL",
	"--kill-whom=all",
	"rauc.service",
];
const warn = spyOn(logger, "warn").mockImplementation(() => logger);
const info = spyOn(logger, "info").mockImplementation(() => logger);
afterEach(() => {
	warn.mockClear();
	info.mockClear();
});
afterAll(() => {
	warn.mockRestore();
	info.mockRestore();
});

test("recovery returns after the unchanged awaited TERM then restart with no clock advance", async () => {
	// Given separately held TERM and restart submissions.
	const f = raucEscalationFixture();
	const termReply = Promise.withResolvers<typeof okCommand>();
	const restartReply = Promise.withResolvers<typeof okCommand>();
	const restartEntered = Promise.withResolvers<void>();
	f.setReply((argv) => {
		if (argv.includes("restart")) {
			restartEntered.resolve();
			return restartReply.promise;
		}
		return termReply.promise;
	});
	// When recovery is called, each existing command must still settle in order.
	const result = killAndRestartRaucForStream(f.run, f.scheduler);
	expect(f.commands).toEqual([term]);
	termReply.resolve(okCommand);
	await restartEntered.promise;
	expect(f.commands).toEqual([term, restart]);
	restartReply.resolve(okCommand);
	await result;
	// Then no detached command has run or delayed this awaited result.
	expect(f.commands).toEqual([term, restart]);
	expect(f.scheduler.now()).toBe(0);
	expect(f.pending()).toBe(1);
});

test("same stopping daemon gets NBD release at T+3 then one kill at T+8", async () => {
	// Given a daemon retaining its PID and invocation.
	const f = raucEscalationFixture();
	await killAndRestartRaucForStream(f.run, f.scheduler);
	// When the three look deadlines arrive.
	await f.advance(999);
	expect(f.commands).toEqual([term, restart]);
	await f.advance(1000);
	expect(f.commands).toEqual([term, restart, show]);
	await f.advance(2999);
	expect(f.commands).toEqual([term, restart, show]);
	await f.advance(3000);
	expect(f.commands).toEqual([term, restart, show, show, release]);
	await f.advance(7999);
	expect(f.commands).toEqual([term, restart, show, show, release]);
	await f.advance(8000);
	await f.advance(16000);
	// Then the one bounded kill is submitted and its identity is logged.
	expect(f.commands).toEqual([
		term,
		restart,
		show,
		show,
		release,
		show,
		forceKill,
	]);
	expect(f.options.every((opts) => opts?.timeoutMs === 10000)).toBe(true);
	expect(info).toHaveBeenCalledWith(
		expect.any(String),
		expect.objectContaining({ mainPid: "123", invocationId: "a".repeat(32) }),
	);
	expect(f.pending()).toBe(0);
});

test.each(["active", "inactive", "failed", "activating"])(
	"first look in %s never arms a second look",
	async (state) => {
		// Given a unit that is not stopping when first inspected.
		const f = raucEscalationFixture();
		f.setReply(async () => ({
			...okCommand,
			stdout: stoppingRauc.replace("deactivating", state),
		}));
		await killAndRestartRaucForStream(f.run, f.scheduler);
		// When the entire window elapses.
		await f.advance(8000);
		// Then there is only one read, and no kill.
		expect(f.commands).toEqual([term, restart, show]);
		expect(f.pending()).toBe(0);
	},
);

test.each([
	stoppingRauc.replace("123", "456"),
	stoppingRauc.replace("a".repeat(32), "b".repeat(32)),
	stoppingRauc.replace("123", "456").replace("a".repeat(32), "b".repeat(32)),
	stoppingRauc.replace("deactivating", "active"),
])(
	"protects a changed or active daemon at the second look: %s",
	async (second) => {
		// Given the first stopping identity has been captured.
		const f = raucEscalationFixture();
		await killAndRestartRaucForStream(f.run, f.scheduler);
		await f.advance(1000);
		f.setReply(async () => ({ ...okCommand, stdout: second }));
		// When the second read observes recovery or a replacement.
		await f.advance(8000);
		// Then it never kills that daemon.
		expect(f.commands).toEqual([term, restart, show, show]);
	},
);

test.each(["nonzero", "throw"])(
	"detached SIGKILL %s only warns after the caller has returned",
	async (failure) => {
		// Given a failed escalation command, independent of successful admission.
		const f = raucEscalationFixture();
		f.setReply(async (argv) => {
			if (argv.includes("--signal=SIGKILL")) {
				if (failure === "throw") throw new TypeError("injected spawn failure");
				return { ...okCommand, exitCode: 1 };
			}
			return { ...okCommand, stdout: stoppingRauc };
		});
		await killAndRestartRaucForStream(f.run, f.scheduler);
		// When the detached task fails.
		await expect(f.advance(8000)).resolves.toBeUndefined();
		// Then failure is contained and reported, with no retry or caller rejection.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(
			f.commands.filter((argv) => argv.includes("--signal=SIGKILL")),
		).toHaveLength(1);
		expect(f.pending()).toBe(0);
	},
);

test("rapid calls replace the pending escalation instead of stacking timers", async () => {
	// Given a second cancellation before the first look.
	const f = raucEscalationFixture();
	await killAndRestartRaucForStream(f.run, f.scheduler);
	await f.advance(500);
	// When cancellation is repeated.
	await killAndRestartRaucForStream(f.run, f.scheduler);
	expect(f.pending()).toBe(1);
	await f.advance(8500);
	// Then the latest lifetime alone observes and escalates.
	expect(f.commands).toEqual([
		term,
		restart,
		term,
		restart,
		show,
		show,
		release,
		show,
		forceKill,
	]);
});

test("replacement fences a first look already waiting on systemctl", async () => {
	// Given the old lifetime has an in-flight first read.
	const f = raucEscalationFixture();
	const held = Promise.withResolvers<typeof okCommand>();
	await killAndRestartRaucForStream(f.run, f.scheduler);
	f.setReply((argv) =>
		argv.includes("show") ? held.promise : Promise.resolve(okCommand),
	);
	const oldLook = f.advance(1000);
	// When a new cancellation replaces it before the read completes.
	await killAndRestartRaucForStream(f.run, f.scheduler);
	held.resolve({ ...okCommand, stdout: stoppingRauc });
	await oldLook;
	f.setReply(async () => ({ ...okCommand, stdout: stoppingRauc }));
	await f.advance(9000);
	// Then the old response cannot schedule a duplicate second look or kill.
	expect(f.commands.filter((argv) => argv.includes("show"))).toHaveLength(4);
	expect(
		f.commands.filter((argv) => argv.includes("--signal=SIGKILL")),
	).toHaveLength(1);
	expect(f.pending()).toBe(0);
});

test.each([
	"",
	"ActiveState=deactivating\nMainPID=0\nInvocationID=\n",
	`${stoppingRauc}MainPID=456\n`,
])(
	"ambiguous or absent identity never authorizes escalation: %s",
	async (stdout) => {
		// Given incomplete or contradictory unit evidence.
		const f = raucEscalationFixture();
		f.setReply(async () => ({ ...okCommand, stdout }));
		await killAndRestartRaucForStream(f.run, f.scheduler);
		// When the detached read runs.
		await f.advance(8000);
		// Then no kill is authorized and the evidence failure is logged.
		expect(f.commands).toEqual([term, restart, show]);
		expect(warn).toHaveBeenCalledTimes(1);
	},
);
