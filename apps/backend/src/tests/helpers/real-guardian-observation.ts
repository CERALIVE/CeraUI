import { SOFTWARE_UPDATE_LOCK } from "../../modules/system/update-orchestrator/lock.ts";
import {
	OS_STAGE_GUARD_HELPER,
	OS_STAGE_GUARD_UNIT,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import { realDeviceSection } from "./real-device-fixture.ts";

export function guardianProductIdentity(output: string): string {
	return output
		.replaceAll("uso-fixture-guard.service", OS_STAGE_GUARD_UNIT)
		.replaceAll(
			"Description=uso fixture guard",
			"Description=CeraLive OS stage lock",
		)
		.replaceAll("/run/uso-fixture-guard.lock", SOFTWARE_UPDATE_LOCK)
		.replaceAll("/run/uso-fixture-guard/helper.sh", OS_STAGE_GUARD_HELPER);
}

export async function guardianObservationReply(stage: string): Promise<string> {
	const full = await realDeviceSection("rock-guardian", `${stage}-full`);
	const extra = full
		.split("\n")
		.filter((line) =>
			[
				"ControlPID",
				"Restart",
				"ExecMainCode",
				"InvocationID",
				"ControlGroup",
			].some((key) => line.startsWith(`${key}=`)),
		);
	return guardianProductIdentity(
		`${await realDeviceSection("rock-guardian", `${stage}-properties`)}${await realDeviceSection("rock-guardian", `${stage}-load`)}${extra.join("\n")}\n`,
	);
}
