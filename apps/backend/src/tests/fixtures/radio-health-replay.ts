import { replayRadio } from "../../modules/modems/radio-health-replay.ts";

const path = process.argv[2];
if (!path) throw new Error("Pass a normalized replay JSON file");
process.stdout.write(
	`${JSON.stringify(replayRadio(await Bun.file(path).json()))}\n`,
);
