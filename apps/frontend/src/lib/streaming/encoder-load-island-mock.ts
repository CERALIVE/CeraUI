import type { EncoderLoadReading } from "./encoder-load";

/**
 * Illustrative queue/ownership data, not board measurements; never a wire publisher.
 *
 * The core IDENTITIES are the real ones, read from an Orange Pi 5+ running the
 * mainline media island (`/proc/mpp_service/load`, `/proc/rkrga/load`): one JPEG
 * decoder, not two, and `fdc40100.video-codec` rather than the invented
 * `fdc48100`. A fixture whose identities no board publishes cannot stand in for
 * one during layout QA, which is the job this fixture is actually asked to do.
 */
export function mockIslandLoadAt(t: number): EncoderLoadReading {
	return {
		source: "mpp-service",
		cores: [
			{ core: "rkvenc0", kind: "unavailable" },
			{ core: "rkvenc1", kind: "percent", percent: 0 },
		],
		updatedAt: t,
		simulated: true,
		blocks: [
			{
				source: "mpp-service",
				block: "rkvenc",
				cores: [
					{
						core: "fdbd0000.rkvenc-core",
						load: 145.53,
						utilization: 121.08,
						sessions: [
							{ pid: 4242, index: 7 },
							{ pid: 4242, index: 9 },
						],
					},
					{
						core: "fdbe0000.rkvenc-core",
						load: 0,
						utilization: 0,
						sessions: [],
					},
				],
			},
			{
				source: "mpp-service",
				block: "rkvdec",
				cores: [
					{
						core: "fdc38100.video-codec",
						load: 23.1,
						utilization: 19.04,
						sessions: [{ pid: 5380, index: 2 }],
					},
					{
						core: "fdc40100.video-codec",
						load: null,
						utilization: 0,
						sessions: null,
					},
				],
			},
			{
				source: "mpp-service",
				block: "jpgdec",
				cores: [
					{ core: "fdb90000.jpegd", load: 7.5, utilization: 5, sessions: [] },
				],
			},
			{
				source: "rkrga",
				block: "rga",
				cores: [
					{
						core: "scheduler[0]: rga3",
						load: 12,
						utilization: null,
						sessions: null,
					},
					{
						core: "scheduler[1]: rga3",
						load: 0,
						utilization: null,
						sessions: null,
					},
					{
						core: "scheduler[2]: rga2",
						load: null,
						utilization: null,
						sessions: null,
					},
				],
			},
		],
	};
}
