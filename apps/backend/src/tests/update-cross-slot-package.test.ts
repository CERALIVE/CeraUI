import { expect, test } from "bun:test";
import { join } from "node:path";

test("the packaged root entrypoint is locked and unreachable from RPC or remote dispatch", async () => {
	const root = join(import.meta.dir, "../../../..");
	const wrapper = await Bun.file(
		join(root, "deployment/ceralive-update-recover"),
	).text();
	const packageScript = await Bun.file(
		join(root, "scripts/build/build-debian-package.sh"),
	).text();
	expect(wrapper).toContain(
		"exec /usr/bin/flock -n -x /run/lock/ceralive-update.lock",
	);
	expect(wrapper).toContain("$(id -u)");
	expect(packageScript).toContain("cp deployment/ceralive-update-recover");
	expect(packageScript).toContain(
		"bun build apps/backend/src/modules/system/update-orchestrator/recovery-cli.ts --compile",
	);
	expect(packageScript).toContain(
		'chmod 0700 "$TEMP_DIR/usr/sbin/ceralive-update-recover"',
	);
	for (const path of [
		"apps/backend/src/rpc/router.ts",
		"apps/backend/src/rpc/procedures/system.procedure.ts",
		"apps/backend/src/modules/remote-control/command-router.ts",
		"apps/backend/src/modules/system/update-orchestrator/runtime.ts",
	]) {
		const source = await Bun.file(join(root, path)).text();
		expect(source).not.toMatch(
			/recoverCrossSlot|ceralive-update-recover|HISTORICAL_COMMIT_ADJUDICATED/,
		);
	}
});
