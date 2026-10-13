import { expect, test } from "bun:test";
import { recoverDetachedAptUpgrade } from "../modules/system/software-update-process.ts";
import { validateDetachedAptServiceIdentity } from "../modules/system/software-update-service-contract.ts";
import { parseDetachedAptServiceProbe } from "../modules/system/software-update-service-state.ts";
import { classifySlotSyncProbe } from "../modules/system/update-orchestrator/lock.ts";

const owned = `Id=ceralive-software-update.service
FragmentPath=/run/systemd/transient/ceralive-software-update.service
Description=CeraLive software update
LoadState=loaded
ActiveState=active
SubState=exited
Transient=yes
Type=exec
RemainAfterExit=yes
User=
ExecStart={ path=/usr/bin/apt-get ; argv[]=/usr/bin/apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install cerastream ; }
StandardOutput=append
StandardError=append
ExecMainCode=1
ExecMainStatus=9
`;
const probe = (stdout: string) =>
	parseDetachedAptServiceProbe({ stdout, stderr: "", exitCode: 0 }, [
		"systemctl",
		"show",
		"ceralive-software-update.service",
	]);
const ambiguous = [
	undefined,
	"",
	"0garbage",
	"9garbage",
	"+0",
	"-1",
	"0.0",
	"256",
	"9007199254740992",
] as const;

test.each(ambiguous.map((value) => [value] as const))(
	"slot-sync ambiguous failure status %s cannot authorize reset cleanup",
	(status) => {
		// Given a failed mirror unit with ambiguous exit evidence, when classified, then no terminal cleanup verdict is granted.
		const stdout = `LoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=1\n${status === undefined ? "" : `ExecMainStatus=${status}\n`}`;
		expect(() => classifySlotSyncProbe({ exitCode: 0, stdout })).toThrow();
	},
);

test("failed systemctl reply cannot authorize mirror outcome cleanup", () => {
	// Given valid-looking stdout from a failed probe, when classified, then no reset/terminal status is authorized.
	expect(() =>
		classifySlotSyncProbe({
			exitCode: 1,
			stdout:
				"LoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=1\nExecMainStatus=9\n",
		}),
	).toThrow();
});

test("slot-sync contradictory terminal lifecycle cannot authorize reset cleanup", () => {
	// Given conflicting terminal properties, when classified, then failure cleanup remains unauthorized.
	expect(() =>
		classifySlotSyncProbe({
			exitCode: 0,
			stdout:
				"LoadState=loaded\nActiveState=failed\nSubState=exited\nExecMainCode=1\nExecMainStatus=9\n",
		}),
	).toThrow();
});

test.each([2, 3])(
	"signal exit kind %s without a signal cannot authorize mirror cleanup",
	(code) => {
		// Given an impossible signal-status pair, when probed, then no outcome/cleanup is authorized.
		expect(() =>
			classifySlotSyncProbe({
				exitCode: 0,
				stdout: `LoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=${code}\nExecMainStatus=0\n`,
			}),
		).toThrow();
	},
);

test.each(["+1", "0", "4"])(
	"failed owned unit refuses ambiguous exit kind %s",
	(code) => {
		// Given failed owned identity and invalid exit kind, when observed, then completion stays unknown.
		expect(
			probe(
				owned
					.replace("ActiveState=active", "ActiveState=failed")
					.replace("SubState=exited", "SubState=failed")
					.replace("ExecMainCode=1", `ExecMainCode=${code}`),
			),
		).toEqual({ kind: "running" });
	},
);

test.each([2, 3])("exited owned unit refuses signal-kind code %s", (code) => {
	// Given exited lifecycle with a signal-kind code, when observed, then incompatible evidence cannot finish.
	expect(
		probe(owned.replace("ExecMainCode=1", `ExecMainCode=${code}`)),
	).toEqual({ kind: "running" });
});

for (const lifecycle of ["exited", "failed"] as const) {
	test.each(ambiguous.map((value) => [value] as const))(
		`${lifecycle} owned unit retains observation when ExecMainStatus is %s`,
		(status) => {
			// Given complete owned identity and ambiguous terminal status.
			let stdout =
				status === undefined
					? owned.replace("ExecMainStatus=9\n", "")
					: owned.replace("ExecMainStatus=9", `ExecMainStatus=${status}`);
			if (lifecycle === "failed")
				stdout = stdout
					.replace("ActiveState=active", "ActiveState=failed")
					.replace("SubState=exited", "SubState=failed");
			validateDetachedAptServiceIdentity(stdout);
			// When the real probe and identity boundary observe it.
			const result = probe(stdout);
			// Then neither cleanup nor an exit code is authorized.
			expect(result).toEqual({ kind: "running" });
		},
	);
}

test.each([0, 9, 255])(
	"complete owned exit control preserves status %s",
	(code) => {
		// Given a complete owned terminal observation, when probed, then its exact exit is retained.
		expect(
			probe(owned.replace("ExecMainStatus=9", `ExecMainStatus=${code}`)),
		).toEqual({ kind: "finished", exitCode: code, cleanup: "stop" });
	},
);

test.each([undefined, "", "1junk", "0", "4", "9007199254740992"])(
	"terminal status cannot finish through ambiguous ExecMainCode %s",
	(code) => {
		// Given a complete status but an ambiguous exit-kind property, when probed, then no cleanup is granted.
		const output =
			code === undefined
				? owned.replace("ExecMainCode=1\n", "")
				: owned.replace("ExecMainCode=1", `ExecMainCode=${code}`);
		expect(probe(output)).toEqual({ kind: "running" });
	},
);

test.each([
	owned.replace("ActiveState=active\n", ""),
	owned.replace("ActiveState=active", "ActiveState=failed"),
	owned.replace("SubState=exited", "SubState=failed"),
	owned
		.replace("ActiveState=active", "ActiveState=failed")
		.replace("SubState=exited", "SubState=failed")
		.replace("ExecMainStatus=9", "ExecMainStatus=0"),
])("contradictory terminal lifecycle keeps observation", (output) => {
	// Given conflicting exit/lifecycle signals, when probed, then identity alone cannot authorize completion.
	expect(probe(output)).toEqual({ kind: "running" });
});

test.each([undefined, "0garbage"])(
	"real observer submits no cleanup or success while status is %s",
	async (status) => {
		// Given an owned running unit, then an ambiguous terminal probe, then a complete failure.
		const unknown =
			status === undefined
				? owned.replace("ExecMainStatus=9\n", "")
				: owned.replace("ExecMainStatus=9", `ExecMainStatus=${status}`);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let inspections = 0;
		let sleeps = 0;
		let cleaned = 0;
		const recovered = await recoverDetachedAptUpgrade(
			{ onStdout: () => {}, onStderr: () => {} },
			{
				outputPaths: {
					stdout: "/run/ceralive/software-update.stdout",
					stderr: "/run/ceralive/software-update.stderr",
				},
				prepareOutput: async () => {},
				start: async () => {},
				inspect: async () => {
					inspections++;
					return probe(
						inspections === 1
							? owned.replace("SubState=exited", "SubState=running")
							: inspections === 2
								? unknown
								: owned,
					);
				},
				cleanup: async () => {
					cleaned++;
				},
				readOutput: async (_file, offset) => ({
					bytes: new Uint8Array(),
					nextOffset: offset,
				}),
				sleep: async () => {
					if (++sleeps === 2) {
						reached.resolve();
						await release.promise;
					}
				},
			},
		);
		if (!recovered) throw new Error("owned fixture was not attached");
		try {
			// When ambiguous evidence reaches the real polling observer.
			const outcome = await Promise.race([
				reached.promise.then(() => "held"),
				recovered.completion.then(() => "finished"),
			]);
			// Then it remains unsettled and cannot consume the unit's outcome evidence.
			expect(outcome).toBe("held");
			expect(cleaned).toBe(0);
		} finally {
			release.resolve();
		}
		// A later positive failure control permits cleanup and reports nine, never invented zero.
		expect(await recovered.completion).toBe(9);
		expect(cleaned).toBe(1);
	},
);
