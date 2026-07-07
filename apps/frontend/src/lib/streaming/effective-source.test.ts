import type {
	ConfigMessage,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import { deriveEffectiveSource, hasEffectiveSource } from "./effective-source";

// ── Fixture builders (mirror go-live-readiness.test.ts's partial-cast pattern) ──
function cfg(overrides: Partial<ConfigMessage> = {}): ConfigMessage {
	return overrides as ConfigMessage;
}

function capture(id: string): StreamSource {
	return {
		id,
		pipelineId: id,
		origin: "capture",
		displayName: id,
		kind: "usb",
		devicePath: `/dev/${id}`,
		modes: [],
		supportsAudio: true,
		supportsResolutionOverride: true,
		supportsFramerateOverride: true,
		audioKind: "device",
		available: true,
	} as unknown as StreamSource;
}

function virtual(id: string): StreamSource {
	return {
		id,
		pipelineId: id,
		origin: "virtual",
		labelKey: "settings.sources.test",
		modes: [],
		supportsAudio: false,
		supportsResolutionOverride: false,
		supportsFramerateOverride: false,
		audioKind: "none",
		available: true,
	} as unknown as StreamSource;
}

function sources(entries: StreamSource[]): SourcesMessage {
	return { hardware: "generic", sources: entries };
}

describe("deriveEffectiveSource", () => {
	it("resolves the implicit sole camera when config.source is unset and exactly one capture source exists", () => {
		const result = deriveEffectiveSource(cfg(), sources([capture("cam0")]));
		expect(result.soleCamera?.id).toBe("cam0");
		expect(result.effectiveSourceId).toBe("cam0");
		expect(result.captureSources).toHaveLength(1);
	});

	it("does NOT auto-select when there are two capture sources", () => {
		const result = deriveEffectiveSource(
			cfg(),
			sources([capture("cam0"), capture("cam1")]),
		);
		expect(result.soleCamera).toBeUndefined();
		expect(result.effectiveSourceId).toBeUndefined();
	});

	it("prefers the explicit config.source over any sole-camera derivation", () => {
		const result = deriveEffectiveSource(
			cfg({ source: "cam1" }),
			sources([capture("cam0"), capture("cam1")]),
		);
		expect(result.soleCamera).toBeUndefined();
		expect(result.effectiveSourceId).toBe("cam1");
	});

	it("does NOT auto-select a lone non-capture source", () => {
		const result = deriveEffectiveSource(cfg(), sources([virtual("test")]));
		expect(result.soleCamera).toBeUndefined();
		expect(result.effectiveSourceId).toBeUndefined();
	});

	it("returns empty captureSources when sources is undefined", () => {
		const result = deriveEffectiveSource(cfg(), undefined);
		expect(result.captureSources).toEqual([]);
		expect(result.effectiveSourceId).toBeUndefined();
	});
});

describe("hasEffectiveSource", () => {
	it("hides when sources are known and there are two cameras with no config.source", () => {
		expect(
			hasEffectiveSource(cfg(), sources([capture("cam0"), capture("cam1")])),
		).toBe(false);
	});

	it("renders when sources are known and there is exactly one camera (implicit sole camera)", () => {
		expect(hasEffectiveSource(cfg(), sources([capture("cam0")]))).toBe(true);
	});

	it("renders when config.source is set", () => {
		expect(
			hasEffectiveSource(
				cfg({ source: "cam1" }),
				sources([capture("cam0"), capture("cam1")]),
			),
		).toBe(true);
	});

	it("FAIL-OPEN: renders when sources is undefined (standalone / federation mount)", () => {
		expect(hasEffectiveSource(cfg(), undefined)).toBe(true);
		expect(hasEffectiveSource(cfg({ source: "cam1" }), undefined)).toBe(true);
	});

	it("hides when sources are known but empty", () => {
		expect(hasEffectiveSource(cfg(), sources([]))).toBe(false);
	});
});
