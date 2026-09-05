/// <reference types="bun" />
/// <reference lib="es2022" />

import { describe, expect, test } from "bun:test";

const REPO_ROOT = `${import.meta.dir}/../../../..`;
const SOURCE_ROOTS = [
	"apps/backend/src",
	"apps/frontend/src",
	"packages/rpc/src",
] as const;

const PRODUCER_TYPE_DECLARATION =
	/\b(?:export\s+)?(?:interface|type)\s+(PlatformCaps|VideoSourceCap|EncoderCapability)\s*(?:=|extends|\{)/g;
const PRODUCER_SCHEMA_DECLARATION =
	/\b(?:export\s+)?const\s+(platformCapsSchema|videoSourceCapSchema|encoderCapabilitySchema)\s*=/g;

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function localProducerDeclarations(source: string): string[] {
	const executable = stripComments(source);
	return [
		...executable.matchAll(PRODUCER_TYPE_DECLARATION),
		...executable.matchAll(PRODUCER_SCHEMA_DECLARATION),
	].map((match) => match[1] ?? "unknown");
}

async function shippedSourceFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const root of SOURCE_ROOTS) {
		const glob = new Bun.Glob("**/*.{ts,svelte}");
		for await (const relative of glob.scan(`${REPO_ROOT}/${root}`)) {
			if (relative.includes(".test.") || relative.includes(".spec.")) continue;
			files.push(`${REPO_ROOT}/${root}/${relative}`);
		}
	}
	return files;
}

describe("producer-owned capability types have no local shadows", () => {
	test("the detector rejects planted type and schema declarations", () => {
		expect(
			localProducerDeclarations(`
				export interface PlatformCaps { max_resolution: string }
				type VideoSourceCap = { id: string }
				type EncoderCapability = { codec: string }
				export const encoderCapabilitySchema = z.object({})
			`),
		).toEqual([
			"PlatformCaps",
			"VideoSourceCap",
			"EncoderCapability",
			"encoderCapabilitySchema",
		]);
	});

	test("shipped source imports every producer-owned capability shape", async () => {
		const shadows: string[] = [];
		for (const file of await shippedSourceFiles()) {
			for (const declaration of localProducerDeclarations(
				await Bun.file(file).text(),
			)) {
				shadows.push(`${file.slice(REPO_ROOT.length + 1)}: ${declaration}`);
			}
		}
		expect(shadows).toEqual([]);
	});

	test("the RPC boundary imports the published binding schemas", async () => {
		const intersection = await Bun.file(
			`${REPO_ROOT}/packages/rpc/src/capabilities/intersect-caps.ts`,
		).text();
		const streamingSchema = await Bun.file(
			`${REPO_ROOT}/packages/rpc/src/schemas/streaming.schema.ts`,
		).text();

		expect(intersection).toContain(
			"import type { PlatformCaps, VideoSourceCap } from '@ceralive/cerastream';",
		);
		expect(streamingSchema).toContain(
			"from '@ceralive/cerastream/dist/messages.js';",
		);
	});
});
