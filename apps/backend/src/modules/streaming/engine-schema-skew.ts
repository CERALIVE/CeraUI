/**
 * A schema_version skew between the engine and the bindings CeraUI was built
 * against is the same fact for every probe and capability read, so repeated
 * observations of the same skew are logged once. The warning comes back after
 * an observed boundary: a probe that finds the engine unreachable, a current
 * capability read that finds it unreachable, a retired session connection, or
 * an observed matching schema. A different pair of versions logs at once. An
 * engine restart with the same versions that CeraUI never sees fail is not a
 * boundary: the hello carries versions, not a process identity.
 *
 * A lost or unreachable connection starts a new connection generation; a
 * matching schema only clears the reported pair. A probe or read takes the
 * generation when it starts and passes it back, so one that outlived its
 * connection can neither use up nor clear the next connection's warning.
 */

interface SkewLogger {
	warn(message: string, meta?: unknown): void;
}

let reported: string | undefined;
let generation = 0;

/** The engine connection generation a probe or read starts under. */
export function engineSchemaGeneration(): number {
	return generation;
}

/** Record the engine schema seen on a live connection; warn on a new skew. */
export function observeEngineSchema(
	logger: SkewLogger,
	versions: { engine: string; bindings: string; engineVersion?: string },
	seenIn: number = generation,
): void {
	if (seenIn !== generation) return;
	if (versions.engine === versions.bindings) {
		reported = undefined;
		return;
	}
	const key = `${versions.engine}\u0000${versions.bindings}`;
	if (reported === key) return;
	reported = key;
	logger.warn(
		"cerastream: engine schema_version differs from bindings (additive-only, informational)",
		{
			engine: versions.engine,
			bindings: versions.bindings,
			...(versions.engineVersion !== undefined
				? { engineVersion: versions.engineVersion }
				: {}),
		},
	);
}

/** The engine connection that showed the skew is gone; warn on the next one. */
export function forgetEngineSchemaSkew(seenIn: number = generation): void {
	if (seenIn !== generation) return;
	generation += 1;
	reported = undefined;
}
