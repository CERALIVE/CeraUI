/**
 * Password hash storage
 * Separate module to avoid circular dependencies
 */

import { logger } from "../../helpers/logger.ts";

let passwordHash: string | undefined;

export function setPasswordHash(newHash: string | undefined) {
	logger.debug(
		`setPasswordHash called: ${newHash ? "hash provided" : "no hash"}`,
	);
	passwordHash = newHash;
}

export function getPasswordHash(): string | undefined {
	return passwordHash;
}
