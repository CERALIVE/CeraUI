import { spyOn } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultArmedStreamMarkerDeps,
	writeArmedStreamMarker,
} from "../modules/streaming/armed-stream-marker.ts";

export async function armedMarkerFixture() {
	const directory = await mkdtemp(join(tmpdir(), "ceraui-apt-space-"));
	const markerPath = join(directory, "stream.armed.json");
	const io = { ...defaultArmedStreamMarkerDeps };
	const readMarker = spyOn(
		defaultArmedStreamMarkerDeps,
		"readMarker",
	).mockImplementation(() => io.readMarker(markerPath));
	const writeMarker = spyOn(
		defaultArmedStreamMarkerDeps,
		"writeMarker",
	).mockImplementation((_path, text) => io.writeMarker(markerPath, text));
	writeArmedStreamMarker({
		armedAt: 1,
		bootId: "test-boot",
		config: { source: "camera" },
	});
	return {
		before: await readFile(markerPath, "utf8"),
		read: () => readFile(markerPath, "utf8"),
		async [Symbol.asyncDispose]() {
			readMarker.mockRestore();
			writeMarker.mockRestore();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
