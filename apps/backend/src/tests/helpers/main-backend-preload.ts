// Preloaded (`bun --preload`) into a ceralive-update-session.ts child to make it
// the backend main shipped before this notice owner (PR #670): every production
// file under apps/backend/src that differs from MAIN_BEFORE_NOTICE is served with
// its source at that commit, so the check, the notice it raises and the
// notification delivery are main's own code, not a stand-in. It needs that
// commit in the clone (CI fetches full history for the backend suite) and fails
// loudly without it.
import { plugin } from "bun";

export const MAIN_BEFORE_NOTICE = "541ae1e2c3c7d6d746954bbb247a95b302990fbc";

const git = (args: string[], cwd: string) => Bun.$`git ${args}`.cwd(cwd).text();
const repo = (
	await git(["rev-parse", "--show-toplevel"], import.meta.dir)
).trim();
const changed = (
	await git(
		[
			"diff",
			"--name-only",
			"--diff-filter=M",
			MAIN_BEFORE_NOTICE,
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
					await git(["show", `${MAIN_BEFORE_NOTICE}:${path}`], repo),
				] as const,
		),
	),
);
const literal = (path: string) => path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

plugin({
	name: `backend at ${MAIN_BEFORE_NOTICE}`,
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
