/**
 * Retry a promise-returning function with exponential backoff.
 *
 * @param fn - Async function to retry
 * @param options - Retry configuration
 * @returns Result of fn on success
 * @throws Last error after maxAttempts exhausted, or immediately if shouldRetry returns false
 */
export async function retryWithBackoff<T>(
	fn: () => Promise<T>,
	options: {
		maxAttempts: number;
		baseDelayMs: number;
		maxDelayMs: number;
		shouldRetry?: (err: unknown) => boolean;
		signal?: AbortSignal;
	},
): Promise<T> {
	const { maxAttempts, baseDelayMs, maxDelayMs } = options;
	const shouldRetry = options.shouldRetry ?? (() => true);

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		options.signal?.throwIfAborted();
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			options.signal?.throwIfAborted();

			// If shouldRetry returns false, throw immediately
			if (!shouldRetry(err)) {
				throw err;
			}

			// If this is the last attempt, throw
			if (attempt === maxAttempts) {
				throw err;
			}

			// Calculate exponential backoff delay
			const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);

			// Wait before retrying
			await new Promise<void>((resolve, reject) => {
				const signal = options.signal;
				const abort = () => {
					clearTimeout(timer);
					reject(signal?.reason);
				};
				const timer = setTimeout(() => {
					signal?.removeEventListener("abort", abort);
					resolve();
				}, delayMs);
				if (signal) timer.unref();
				signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}

	// Should never reach here, but satisfy TypeScript
	throw lastError;
}

/**
 * Poll a result-yielding operation with {@link retryWithBackoff}: a nullish
 * result is retried with the same backoff schedule as a thrown error, and
 * exhaustion returns `undefined` (via `onExhausted`) instead of throwing.
 *
 * Nullish (`null`/`undefined`) is the only "empty" signal, exactly equivalent
 * to the call sites' prior `!result` / `=== undefined` guards (they only ever
 * return objects/arrays or `undefined`).
 */
export async function pollWithBackoff<T>(
	fn: () => Promise<T | null | undefined>,
	options: {
		maxAttempts: number;
		baseDelayMs: number;
		maxDelayMs: number;
		shouldRetry?: (err: unknown) => boolean;
		signal?: AbortSignal;
		emptyResultError?: () => unknown;
		onExhausted?: (err: unknown) => void;
	},
): Promise<T | undefined> {
	const { emptyResultError, onExhausted, ...retryOptions } = options;

	try {
		return await retryWithBackoff(async () => {
			const result = await fn();
			if (result == null) {
				throw emptyResultError
					? emptyResultError()
					: new Error("pollWithBackoff: operation returned no result");
			}
			return result;
		}, retryOptions);
	} catch (err) {
		if (!options.signal?.aborted) onExhausted?.(err);
		return undefined;
	}
}
