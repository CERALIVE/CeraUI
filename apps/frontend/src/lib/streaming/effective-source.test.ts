import type {
	ConfigMessage,
	SourcesMessage,
	StreamSource,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	deriveEffectiveSource,
	hasEffectiveSource,
	reconcileStartSource,
} from "./effective-source";
import { deriveGoLiveReadiness } from "./go-live-readiness";
import { pipelinesFromSources } from "./sources-view-model";
import { buildStartConfig } from "./startStreaming";

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

describe("reconcileStartSource", () => {
	it("stamps the pipeline from the resolved source row, overwriting a stale persisted one", () => {
		const snapshot = sources([capture("cam0")]);
		const result = reconcileStartSource(
			cfg({ source: "cam0", pipeline: "legacy-unknown-pipeline" }),
			snapshot,
		);
		expect(result?.pipeline).toBe("cam0");
		expect(result?.source).toBe("cam0");
	});

	it("stamps both fields from the implicit sole camera when config.source is unset", () => {
		const result = reconcileStartSource(cfg(), sources([capture("cam0")]));
		expect(result?.source).toBe("cam0");
		expect(result?.pipeline).toBe("cam0");
	});

	it("DROPS the pipeline when the selected source resolves to no row", () => {
		const result = reconcileStartSource(
			cfg({ source: "gone", pipeline: "cam0" }),
			sources([capture("cam0")]),
		);
		expect(result?.pipeline).toBeUndefined();
		expect(result?.source).toBe("gone");
	});

	it("FAIL-OPEN: returns the config untouched when sources is undefined", () => {
		const input = cfg({ source: "cam0", pipeline: "legacy" });
		expect(reconcileStartSource(input, undefined)).toBe(input);
	});
});

// Disagreement here renders an ENABLED Start that toasts a refusal on click.
describe("start-gate coherence — readiness and buildStartConfig agree", () => {
	function verdicts(config: ConfigMessage, snapshot: SourcesMessage) {
		// Mirrors StreamSetupChain's `readinessConfig`: the implicit sole camera is
		// folded in before the readiness runs, exactly as the mounted view does.
		const soleCamera = deriveEffectiveSource(config, snapshot).soleCamera;
		const readiness = deriveGoLiveReadiness({
			config: soleCamera ? { ...config, source: soleCamera.id } : config,
			caps: undefined,
			sources: snapshot,
			netif: { eth0: { enabled: true, ip: "10.0.0.2" } } as never,
			isConnected: true,
			gatewayStatus: { available: true },
		});
		const start = buildStartConfig(
			reconcileStartSource(config, snapshot),
			null,
			pipelinesFromSources(snapshot),
		);
		return { sourceBlocked: readiness.gates.source.state === "blocked", start };
	}

	const snapshot = sources([capture("cam0"), virtual("test")]);
	const server = { srtla_addr: "127.0.0.1" };

	it("a stale config.pipeline beside a resolvable source blocks NEITHER gate", () => {
		const { sourceBlocked, start } = verdicts(
			cfg({ ...server, source: "cam0", pipeline: "e2e-unknown-pipeline" }),
			snapshot,
		);
		expect(sourceBlocked).toBe(false);
		expect(start.ok).toBe(true);
		if (start.ok) expect(start.config.pipeline).toBe("cam0");
	});

	it("an unresolvable source blocks BOTH gates, even with a recognized stale pipeline", () => {
		const { sourceBlocked, start } = verdicts(
			cfg({ ...server, source: "e2e-unknown-source", pipeline: "cam0" }),
			snapshot,
		);
		expect(sourceBlocked).toBe(true);
		expect(start.ok).toBe(false);
	});

	it("no source and no sole camera to imply one blocks BOTH gates", () => {
		const { sourceBlocked, start } = verdicts(
			cfg({ ...server }),
			sources([capture("cam0"), capture("cam1")]),
		);
		expect(sourceBlocked).toBe(true);
		expect(start.ok).toBe(false);
	});

	it("an unset source that a sole camera implies blocks NEITHER gate", () => {
		const { sourceBlocked, start } = verdicts(cfg({ ...server }), snapshot);
		expect(sourceBlocked).toBe(false);
		expect(start.ok).toBe(true);
		if (start.ok) expect(start.config.source).toBe("cam0");
	});
});
