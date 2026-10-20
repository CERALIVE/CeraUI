import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { logger } from "../helpers/logger.ts";
import {
	killAndRestartRaucForStream,
	RAUC_ESCALATION_FIRST_LOOK_MS,
	RAUC_ESCALATION_GRACE_MS,
} from "../modules/system/update-orchestrator/stream-abort.ts";
import {
	okCommand,
	raucEscalationFixture,
	stoppingRauc,
} from "./helpers/rauc-escalation-fixture.ts";

const warn = spyOn(logger, "warn").mockImplementation(() => logger);
afterEach(() => warn.mockClear());
afterAll(() => warn.mockRestore());

test.each(["nonzero", "throw"])(
	"a detached observation %s warns without reaching SIGKILL",
	async (failure) => {
		// Given a systemctl observation failure after successful restart submission.
		const f = raucEscalationFixture();
		f.setReply(async (argv) => {
			if (argv.includes("show")) {
				if (failure === "throw")
					throw new TypeError("injected observation failure");
				return { ...okCommand, exitCode: 1 };
			}
			return okCommand;
		});
		await killAndRestartRaucForStream(f.run, f.scheduler);
		// When the detached deadline arrives.
		await expect(f.advance(RAUC_ESCALATION_GRACE_MS)).resolves.toBeUndefined();
		// Then the failure is contained, not treated as permission to kill.
		expect(warn).toHaveBeenCalledTimes(1);
		expect(f.commands.some((argv) => argv.includes("--signal=SIGKILL"))).toBe(
			false,
		);
		expect(f.pending()).toBe(0);
	},
);

test("scheduler failure cannot prevent the awaited restart submission", async () => {
	// Given an injected scheduling failure.
	const f = raucEscalationFixture();
	const scheduler = {
		...f.scheduler,
		schedule: () => {
			throw new TypeError("injected scheduler failure");
		},
	};
	// When the detached task cannot be armed.
	await expect(
		killAndRestartRaucForStream(f.run, scheduler),
	).resolves.toBeUndefined();
	// Then restart still submits in its original order and the failure warns.
	expect(f.commands.map((argv) => argv[1])).toEqual(["kill", "restart"]);
	expect(warn).toHaveBeenCalledTimes(1);
});

test("a nonzero TERM still warns and submits restart", async () => {
	// Given systemctl cannot deliver TERM.
	const f = raucEscalationFixture();
	f.setReply(async (argv) => ({
		...okCommand,
		exitCode: argv.includes("--signal=SIGTERM") ? 1 : 0,
	}));
	// When the original recovery effect runs.
	await expect(
		killAndRestartRaucForStream(f.run, f.scheduler),
	).resolves.toBeUndefined();
	// Then the original warning-only TERM policy remains unchanged.
	expect(f.commands.map((argv) => argv[1])).toEqual(["kill", "restart"]);
	expect(warn).toHaveBeenCalledTimes(1);
});

test.each(["--signal=SIGTERM", "restart"])(
	"awaited %s spawn failure still rejects unchanged",
	async (command) => {
		// Given an existing awaited command throws.
		const f = raucEscalationFixture();
		const failure = new TypeError("injected awaited spawn failure");
		f.setReply(async (argv) => {
			if (argv.includes(command)) throw failure;
			return okCommand;
		});
		// When recovery runs.
		const result = killAndRestartRaucForStream(f.run, f.scheduler);
		// Then detached recovery cannot swallow the original rejection.
		await expect(result).rejects.toBe(failure);
	},
);

test("concurrent TERM completions cannot rearm a superseded lifetime", async () => {
	// Given the first call is still awaiting TERM when a second call finishes.
	const f = raucEscalationFixture();
	const held = Promise.withResolvers<typeof okCommand>();
	let firstTerm = true;
	f.setReply((argv) => {
		if (argv.includes("--signal=SIGTERM") && firstTerm) {
			firstTerm = false;
			return held.promise;
		}
		return Promise.resolve({ ...okCommand, stdout: stoppingRauc });
	});
	const first = killAndRestartRaucForStream(f.run, f.scheduler);
	await killAndRestartRaucForStream(f.run, f.scheduler);
	// When the stale TERM finally completes and the escalation window runs.
	held.resolve(okCommand);
	await first;
	expect(f.pending()).toBe(1);
	await f.advance(RAUC_ESCALATION_GRACE_MS);
	// Then only one lifetime owns the three looks and one kill.
	expect(f.commands.filter((argv) => argv.includes("show"))).toHaveLength(3);
	expect(
		f.commands.filter((argv) => argv.includes("--signal=SIGKILL")),
	).toHaveLength(1);
});

test("a slow first observation spends the same absolute eight-second window", async () => {
	// Given the first systemctl read takes three extra seconds.
	const f = raucEscalationFixture();
	let firstRead = true;
	f.setReply(async (argv) => {
		if (argv.includes("show") && firstRead) {
			firstRead = false;
			await f.advance(4000);
		}
		return { ...okCommand, stdout: stoppingRauc };
	});
	await killAndRestartRaucForStream(f.run, f.scheduler);
	// When the first response completes late and the original deadline arrives.
	await f.advance(RAUC_ESCALATION_FIRST_LOOK_MS);
	await f.advance(RAUC_ESCALATION_GRACE_MS - 1);
	expect(f.commands.some((argv) => argv.includes("--signal=SIGKILL"))).toBe(
		false,
	);
	await f.advance(RAUC_ESCALATION_GRACE_MS);
	// Then the deadline was not renewed by observation latency.
	expect(
		f.commands.filter((argv) => argv.includes("--signal=SIGKILL")),
	).toHaveLength(1);
});
