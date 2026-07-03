/*
 * Task 20 — single-use preview-proxy token store.
 *
 * Proves the in-memory store (`modules/ui/preview-token.ts`) mints high-entropy
 * tokens, consumes them exactly ONCE (reuse is impossible), and rejects an
 * expired token — the contract the `/preview` proxy relies on to close 4401.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
	consumePreviewToken,
	mintPreviewToken,
	PREVIEW_TOKEN_TTL_MS,
	resetPreviewTokens,
} from "../modules/ui/preview-token.ts";

beforeEach(() => {
	resetPreviewTokens();
});

describe("preview-token store", () => {
	it("mints a hex token carrying the TTL", () => {
		const { token, ttlMs } = mintPreviewToken(1000);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(ttlMs).toBe(PREVIEW_TOKEN_TTL_MS);
	});

	it("consumes a live token exactly once (single-use)", () => {
		const { token } = mintPreviewToken(1000);
		expect(consumePreviewToken(token, 1000)).toBe(true);
		// Reuse is impossible — the entry was deleted on first consumption.
		expect(consumePreviewToken(token, 1000)).toBe(false);
	});

	it("rejects an expired token and evicts it", () => {
		const { token } = mintPreviewToken(1000);
		const expired = 1000 + PREVIEW_TOKEN_TTL_MS + 1;
		expect(consumePreviewToken(token, expired)).toBe(false);
		// A second attempt is still false (evicted), never a live hit.
		expect(consumePreviewToken(token, 1000)).toBe(false);
	});

	it("rejects a token that was never minted", () => {
		expect(consumePreviewToken("not-a-real-token")).toBe(false);
		expect(consumePreviewToken("")).toBe(false);
	});

	it("issues distinct tokens across mints", () => {
		const a = mintPreviewToken(1000).token;
		const b = mintPreviewToken(1000).token;
		expect(a).not.toBe(b);
		expect(consumePreviewToken(a, 1000)).toBe(true);
		expect(consumePreviewToken(b, 1000)).toBe(true);
	});
});
