import { describe, expect, it } from "bun:test";
import { recoverDetachedAptUpgrade } from "../modules/system/software-update-process.ts";
import { DetachedAptServiceIdentityError } from "../modules/system/software-update-service-contract.ts";
import { parseDetachedAptServiceProbe } from "../modules/system/software-update-service-state.ts";

// From Rock 5B+ systemctl show after our detached apt-get completed. systemd
// omits unset ExecStartPre/ExecStartPost even when --property names both.
const finishedUnit = `Type=exec
RemainAfterExit=yes
ExecMainCode=1
ExecMainStatus=0
ExecStart={ path=/usr/bin/apt-get ; argv[]=/usr/bin/apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o Acquire::ForceIPv4=true install cerastream ; ignore_errors=no ; start_time=[Sat 2026-09-26 01:31:39 UTC] ; stop_time=[Sat 2026-09-26 01:31:44 UTC] ; pid=53469 ; code=exited ; status=0 }
StandardOutput=append
StandardError=append
User=
Id=ceralive-software-update.service
Description=CeraLive software update
LoadState=loaded
ActiveState=active
SubState=exited
FragmentPath=/run/systemd/transient/ceralive-software-update.service
Transient=yes
`;

const command = ["systemctl", "show", "ceralive-software-update.service"];
const probe = (stdout: string) =>
	parseDetachedAptServiceProbe({ exitCode: 0, stdout, stderr: "" }, command);

describe("detached apt unit hook identity on a real systemd show", () => {
	it("accepts an omitted no-hook pair and observes the completed transaction", () => {
		expect(probe(finishedUnit)).toEqual({
			kind: "finished",
			exitCode: 0,
			cleanup: "stop",
		});
	});

	it.each(["ExecStartPre", "ExecStartPost"])(
		"refuses a foreign unit with a populated %s hook",
		(hook) => {
			expect(() =>
				probe(`${finishedUnit}${hook}={ path=/bin/true ; }\n`),
			).toThrow(DetachedAptServiceIdentityError);
		},
	);

	it("retains compatibility with systemd versions that print empty hook fields", () => {
		expect(probe(`${finishedUnit}ExecStartPre=\nExecStartPost=\n`)).toEqual({
			kind: "finished",
			exitCode: 0,
			cleanup: "stop",
		});
	});

	it("allows the observer to drain and clean up after a running unit finishes", async () => {
		let reads = 0;
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
				inspect: async () =>
					probe(
						reads === 0
							? finishedUnit.replace("SubState=exited", "SubState=running")
							: finishedUnit,
					),
				cleanup: async () => {
					cleaned++;
				},
				readOutput: async (_file, offset) => ({
					bytes: new Uint8Array(),
					nextOffset: offset,
				}),
				sleep: async () => {
					reads++;
				},
			},
		);
		expect(recovered).not.toBeNull();
		expect(await recovered?.completion).toBe(0);
		expect(cleaned).toBe(1);
	});
});
