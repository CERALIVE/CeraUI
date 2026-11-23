import { file, markdown, spawnSync, write } from 'bun';

const { GITHUB_REPOSITORY, GITHUB_SHA, IS_BETA, RELEASE_NOTES, TAG, VERSION } = process.env;
const [, , dependenciesPath, outputPath] = process.argv;
const releaseTag = /^v[0-9]{4}\.([1-9]|1[0-2])\.(0|[1-9][0-9]*)(-beta\.[1-9][0-9]*)?$/;
// softprops/action-gh-release v3 truncates oversized bodies with JS substring.
const bodyLimit = 120_000;

function command(args) {
	return spawnSync(args, { env: process.env, stdin: 'ignore', timeout: 30_000 });
}

function generateNotes() {
	const tags = command(['git', 'tag', '--list']);
	if (!tags.success) throw new Error('Could not list release tags');
	const matches = tags.stdout
		.toString()
		.split('\n')
		.filter((tag) => releaseTag.test(tag));

	const args = [
		'gh',
		'api',
		'--method',
		'POST',
		`repos/${GITHUB_REPOSITORY}/releases/generate-notes`,
		'-f',
		`tag_name=${TAG}`,
		'-f',
		`target_commitish=${GITHUB_SHA}`,
		'--jq',
		'.body',
	];
	if (matches.length > 0) {
		const previous = command([
			'git',
			'describe',
			'--tags',
			'--first-parent',
			'--abbrev=0',
			...matches.flatMap((tag) => ['--match', tag]),
			GITHUB_SHA,
		]);
		if (previous.success) {
			args.push('-f', `previous_tag_name=${previous.stdout.toString().trim()}`);
		}
	}
	const response = command(args);
	if (!response.success) {
		throw new Error(
			'Could not generate merged PR release notes from GitHub; retry or provide release_notes',
		);
	}
	const generated = response.stdout.toString().trimEnd();
	if (generated && !generated.startsWith('**Full Changelog**:')) return generated;
	const nothing = "## What's Changed\n\nNo merged pull requests in this release range.";
	return generated ? `${nothing}\n\n${generated}` : nothing;
}

try {
	const supplied = Boolean(RELEASE_NOTES?.trim());
	const notes = supplied ? RELEASE_NOTES : generateNotes();
	const detailsLine = notes.split(/\r\n?|\n/).findIndex((line) => /<\/?details/i.test(line));
	if (detailsLine !== -1) {
		const source = supplied ? 'release_notes' : 'Generated release notes';
		throw new Error(
			`${source} line ${detailsLine + 1}: <details> tags are reserved for the Dependencies section`,
		);
	}
	const description = supplied ? `## 📝 Release Notes\n\n${notes}` : notes;
	const beta =
		IS_BETA === 'true'
			? '> ⚠️ **This is a beta release.** It may contain bugs or incomplete features. Use in production at your own risk.\n\n'
			: '';
	const date = new Date().toISOString().slice(0, 10);
	const dependencies = await file(dependenciesPath).text();
	const tail = `---

${beta}**Release Date:** ${date}

🤖 Generated with GitHub Actions

<details>
<summary>Dependencies</summary>

## 📦 Downloads

### System Archives (with install scripts)
| Architecture | File | Target Hardware |
|--------------|------|-----------------|
| ARM64 | \`ceraui-${VERSION}-arm64.tar.gz\` | Orange Pi 5+, Rock 5B+ |
| AMD64 | \`ceraui-${VERSION}-amd64.tar.gz\` | Intel N100/N200, AMD Ryzen |

### Debian Packages (apt/dpkg install)
| Architecture | File |
|--------------|------|
| ARM64 | \`ceralive-device_${VERSION}_arm64.deb\` |
| AMD64 | \`ceralive-device_${VERSION}_amd64.deb\` |

${dependencies}
</details>
`;
	const body = `# CeraUI ${TAG}\n\n${description}\n\n${tail}`;
	if (body.length > bodyLimit) {
		throw new Error(`Release body exceeds ${bodyLimit} UTF-16 code units; shorten release_notes`);
	}
	// A fence still open at the document boundary would consume the generated tail.
	if (!markdown.html(body).endsWith(markdown.html(tail))) {
		throw new Error('Release notes have an unclosed code fence or HTML block before Dependencies');
	}
	await write(outputPath, body);
} catch (error) {
	console.error(`::error::${error.message}`);
	process.exitCode = 1;
}
