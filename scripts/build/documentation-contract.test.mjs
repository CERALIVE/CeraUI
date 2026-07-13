import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../..");
const readRepoFile = (filename) =>
	readFileSync(path.join(repoRoot, filename), "utf8");

const rootManifest = JSON.parse(readRepoFile("package.json"));
const backendManifest = JSON.parse(readRepoFile("apps/backend/package.json"));

function markdownSection(markdown, headingPattern) {
	const lines = markdown.split("\n");
	const start = lines.findIndex((line) => {
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		return heading !== null && headingPattern.test(heading[2]);
	});
	if (start < 0) throw new Error(`missing Markdown section ${headingPattern}`);
	const depth = /^(#{1,6})\s/.exec(lines[start])[1].length;
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		const next = /^(#{1,6})\s/.exec(lines[index]);
		if (next !== null && next[1].length <= depth) {
			end = index;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n");
}

function documentedDependencyPins(markdown) {
	const pins = new Map();
	for (const match of markdown.matchAll(/"(@ceralive\/[^"]+)"\s*:\s*"([^"]+)"/g)) {
		pins.set(match[1], match[2]);
	}
	return pins;
}

function expandBracedPath(value) {
	const match = /^(.*)\{([^{}]+)\}(.*)$/.exec(value);
	if (match === null) return [value];
	return match[2]
		.split(",")
		.flatMap((choice) => expandBracedPath(`${match[1]}${choice}${match[3]}`));
}

function documentedEntryNames(markdown) {
	const entries = new Set();
	for (const match of markdown.matchAll(/`([^`]+)`/g)) {
		for (const candidate of expandBracedPath(match[1])) {
			if (candidate.endsWith("-entry.ts")) entries.add(path.basename(candidate));
		}
	}
	return [...entries].sort();
}

function documentedManifestFields(markdown) {
	for (const match of markdown.matchAll(/`([^`]*ceraUiVersion[^`]*)`/g)) {
		const identifiers = new Set(match[1].match(/[A-Za-z][A-Za-z0-9]*/g) ?? []);
		if (identifiers.has("files")) return identifiers;
	}
	throw new Error("manifest shape is not represented as inline structured data");
}

function trackedMarkdownFiles() {
	const result = spawnSync("git", ["ls-files", "--", "*.md"], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim().split("\n").filter(Boolean);
}

function ignoredEvidenceCitations(filename, markdown) {
	const citations = [];
	let fenced = false;
	for (const [offset, line] of markdown.split("\n").entries()) {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const linked = [...line.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].some((match) =>
			match[1].includes("test-results/"),
		);
		const cited = /\b(?:see|evidence|results? (?:at|in))\b/i.test(line) &&
			/test-results\/[^`\s)]+\.[A-Za-z0-9]+/.test(line);
		if (linked || cited) citations.push(`${filename}:${offset + 1}`);
	}
	return citations;
}

describe("documentation contracts", () => {
	it("documents the installed registry dependency pins as standalone packages", () => {
		const expected = new Map(
			["@ceralive/cerastream", "@ceralive/srtla-send"].map((name) => [
				name,
				backendManifest.dependencies[name],
			]),
		);
		const rootPins = documentedDependencyPins(readRepoFile("AGENTS.md"));
		const readmePins = documentedDependencyPins(
			markdownSection(readRepoFile("apps/frontend/README.md"), /^Registry Dependencies$/i),
		);

		for (const [name, version] of expected) {
			expect(rootPins.get(name)).toBe(version);
			expect(readmePins.get(name)).toBe(version);
			expect(version).not.toMatch(/^(?:file|link|workspace):/);
		}
	});

	it("documents every federation entry emitted by the build contract", () => {
		const expected = ["audio-entry.ts", "encoder-entry.ts", "server-entry.ts"];
		const rootEntries = documentedEntryNames(
			markdownSection(readRepoFile("AGENTS.md"), /^What gets built$/i),
		);
		const frontendEntries = documentedEntryNames(
			markdownSection(
				readRepoFile("apps/frontend/AGENTS.md"),
				/^FEDERATION LIB BUILD\b/i,
			),
		);

		expect(rootEntries).toEqual(expected);
		expect(frontendEntries).toEqual(expected);
	});

	it("documents the signed manifest fields and current producer version", () => {
		const frontendAgents = readRepoFile("apps/frontend/AGENTS.md");
		const buildSection = markdownSection(frontendAgents, /^FEDERATION LIB BUILD\b/i);
		const signingSection = markdownSection(frontendAgents, /^FEDERATION SIGNING\b/i);
		const fields = documentedManifestFields(signingSection);

		for (const field of [
			"ceraUiVersion",
			"files",
			"filename",
			"integrity",
			"kind",
			"imports",
		]) {
			expect(fields.has(field)).toBe(true);
		}
		expect(buildSection).toContain(`\`${rootManifest.version}\``);
	});

	it("does not cite ignored test-result artifacts as durable evidence", () => {
		const citations = trackedMarkdownFiles().flatMap((filename) =>
			ignoredEvidenceCitations(filename, readRepoFile(filename)),
		);

		expect(citations).toEqual([]);
	});
});
