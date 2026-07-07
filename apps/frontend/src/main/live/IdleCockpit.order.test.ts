// @vitest-environment jsdom
/**
 * IdleCockpit — preview-between-source-and-setup DOM order (C4).
 *
 * Hermetic: SourceSection / StreamSetupChain are stubbed to testid-only markers
 * and PreviewCanvas / ComingSoon to Noop, so this asserts ONLY IdleCockpit's own
 * composition — source-section → preview-disclosure → stream-setup-chain →
 * live-roadmap — independent of the heavy child subtrees.
 */
import { cleanup, render } from "@testing-library/svelte";
import type { ComponentProps } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/components/custom/SourceSection.svelte", async () => ({
	default: (await import("../../tests/fixtures/SourceSectionStub.svelte"))
		.default,
}));
vi.mock("./StreamSetupChain.svelte", async () => ({
	default: (await import("../../tests/fixtures/StreamSetupChainStub.svelte"))
		.default,
}));
vi.mock("$lib/components/preview/PreviewCanvas.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));
vi.mock("$lib/components/custom/ComingSoon.svelte", async () => ({
	default: (await import("../../tests/fixtures/Noop.svelte")).default,
}));

import IdleCockpit from "./IdleCockpit.svelte";

const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;

afterEach(() => {
	cleanup();
});

describe("IdleCockpit — preview between source and setup (C4)", () => {
	it("orders source-section, preview-disclosure, stream-setup-chain, live-roadmap by DOM position", () => {
		const props = {} as unknown as ComponentProps<typeof IdleCockpit>;
		const { container } = render(IdleCockpit, { props });

		const cockpit = container.querySelector<HTMLElement>(
			'[data-testid="idle-cockpit"]',
		);
		expect(cockpit, "idle cockpit mounts").not.toBeNull();

		const order = [
			"source-section",
			"preview-disclosure",
			"stream-setup-chain",
			"live-roadmap",
		].map((id) => {
			const el = cockpit?.querySelector<HTMLElement>(`[data-testid="${id}"]`);
			expect(el, `${id} renders`).not.toBeNull();
			return el as HTMLElement;
		});

		for (let i = 0; i < order.length - 1; i++) {
			const current = order[i] as HTMLElement;
			const next = order[i + 1] as HTMLElement;
			expect(
				current.compareDocumentPosition(next) & FOLLOWING,
				`${current.dataset.testid} precedes ${next.dataset.testid}`,
			).toBeTruthy();
		}
	});
});
