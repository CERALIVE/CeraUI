// Preloaded (`bun --preload`) into a ceralive-update-session.ts child to make it
// the backend main shipped before this notice owner (PR #670): every production
// file under apps/backend/src that differs from MAIN_BEFORE_NOTICE is served with
// its source at that commit, so the check, the notice it raises and the
// notification delivery are main's own code, not a stand-in. It needs that
// commit in the clone (CI fetches full history for the backend suite) and fails
// loudly without it.
import { plugin } from "bun";

export const MAIN_BEFORE_NOTICE = "541ae1e2c3c7d6d746954bbb247a95b302990fbc";

const baseline = process.env.CERALIVE_TEST_BASELINE ?? MAIN_BEFORE_NOTICE;
const git = (args: string[], cwd: string) =>
	Bun.$`env GIT_MASTER=1 git ${args}`.cwd(cwd).text();
const repo = (
	await git(["rev-parse", "--show-toplevel"], import.meta.dir)
).trim();
const changed = (
	await git(
		[
			"diff",
			"--name-only",
			"--diff-filter=M",
			baseline,
			"--",
			"apps/backend/src",
			":!apps/backend/src/tests",
		],
		repo,
	)
)
	.split("\n")
	.filter((path) => path.endsWith(".ts"));
const sources = new Map<string, string>(
	await Promise.all(
		changed.map(
			async (path) =>
				[
					`${repo}/${path}`,
					await git(["show", `${baseline}:${path}`], repo),
				] as const,
		),
	),
);
const literal = (path: string) => path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

plugin({
	name: `backend at ${baseline}`,
	setup(build) {
		build.onLoad(
			{
				filter: new RegExp(
					`^(?:${[...sources.keys()].map(literal).join("|")})$`,
				),
			},
			({ path }) => ({ contents: sources.get(path) ?? "", loader: "ts" }),
		);
	},
});
