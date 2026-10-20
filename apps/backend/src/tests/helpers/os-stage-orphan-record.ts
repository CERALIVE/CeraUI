import { SOFTWARE_UPDATE_LOCK } from "../../modules/system/update-orchestrator/lock.ts";
import {
	OS_STAGE_GUARD_HELPER,
	OS_STAGE_GUARD_UNIT,
	type OsStageJobRecord,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";

export const record: OsStageJobRecord = {
	schema: 1,
	attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	candidateKey: "candidate",
	bundleUrl: "https://images.ceralive.tv/releases/bundle.raucb",
	launched: false,
	cliSettled: true,
	requireNewInstance: false,
	lifecycle: "acquiring",
	processes: [],
	resources: [],
	baseline: {
		instance: "659:10",
		active: true,
		operation: "idle",
		processes: ["659:10"],
		resources: [],
		bootId: "boot-B",
		bootPrimary: "rootfs.1",
		bootedSlot: "rootfs.1",
		bootedDevice: "179:5",
		bootedHealthy: true,
		targetSlot: "rootfs.0",
		targetDevice: "179:4",
		targetInactive: true,
		activationArmed: false,
	},
};

export function exitedUnit(): string {
	return [
		"LoadState=loaded",
		`Id=${OS_STAGE_GUARD_UNIT}`,
		`FragmentPath=/run/systemd/transient/${OS_STAGE_GUARD_UNIT}`,
		"Description=CeraLive OS stage lock",
		"Transient=yes",
		"Type=exec",
		"RemainAfterExit=yes",
		"User=",
		"DropInPaths=",
		"ExecStartPre=",
		"ExecStartPost=",
		"ExecStop=",
		"ExecStopPost=",
		`ExecStart={ path=/usr/bin/flock ; argv[]=/usr/bin/flock -n -E 75 -x ${SOFTWARE_UPDATE_LOCK} ${OS_STAGE_GUARD_HELPER} ${record.attemptId} ; ignore_errors=no ; start_time=[] ; stop_time=[] ; pid=100 ; code=exited ; status=0 }`,
		"ActiveState=active",
		"MainPID=0",
		"ExecMainStatus=0",
		"ControlPID=0",
		"Restart=no",
		"ExecMainCode=1",
		`InvocationID=${"a".repeat(32)}`,
	].join("\n");
}

export function absentUnit(): string {
	return [
		`Id=${OS_STAGE_GUARD_UNIT}`,
		"LoadState=not-found",
		"FragmentPath=",
		"Description=",
		"Transient=no",
		"Type=simple",
		"RemainAfterExit=no",
		"User=",
		"DropInPaths=",
		"ExecStart=",
		"ExecStartPre=",
		"ExecStartPost=",
		"ExecStop=",
		"ExecStopPost=",
		"ActiveState=inactive",
		"MainPID=0",
		"ExecMainStatus=0",
		"SubState=dead",
		"ControlGroup=",
	].join("\n");
}
