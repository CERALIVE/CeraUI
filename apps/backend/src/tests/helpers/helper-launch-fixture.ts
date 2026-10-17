import type { HelperLaunchFile } from "../../helpers/helper-launch-file.ts";

export function helperLaunchFixture(text = "42\n"): HelperLaunchFile {
	return {
		prepare: () => "/fixture/launch.pid",
		read: async () => text,
		cleanup: () => undefined,
	};
}
