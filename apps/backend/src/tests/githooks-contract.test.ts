import { expect, test } from "bun:test";

const REPO_ROOT = `${import.meta.dir}/../../../..`;
const PRE_COMMIT_PATH = `${REPO_ROOT}/.githooks/pre-commit`;

function readGitFiles(): string[] {
	const result = Bun.spawnSync(["git", "ls-files", ".githooks/"], {
		cwd: REPO_ROOT,
		stderr: "pipe",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) {
		throw new Error(new TextDecoder().decode(result.stderr));
	}
	return new TextDecoder()
		.decode(result.stdout)
		.trim()
		.split("\n")
		.filter(Boolean);
}

test("only pre-commit remains tracked under .githooks", () => {
	expect(readGitFiles()).toEqual([".githooks/pre-commit"]);
});

test("pre-commit restages only already-indexed paths", async () => {
	const content = await Bun.file(PRE_COMMIT_PATH).text();

	expect(content).toContain("git update-index --again");
	expect(content).not.toContain("git add -u");
});

test("pre-push is ignored as local hook plumbing", async () => {
	const gitignore = await Bun.file(`${REPO_ROOT}/.gitignore`).text();

	expect(gitignore.split("\n")).toContain("/.githooks/pre-push");
});
