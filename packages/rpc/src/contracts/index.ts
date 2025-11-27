/**
 * Root ORPC Contract - combines all domain contracts
 */
import { oc } from '@orpc/contract';

import { authContract } from './auth.contract';
import { modemsContract } from './modems.contract';
import { networkContract } from './network.contract';
import { notificationsContract } from './notifications.contract';
import { statusContract } from './status.contract';
import { streamingContract } from './streaming.contract';
import { systemContract } from './system.contract';
import { wifiContract } from './wifi.contract';

/**
 * Root application contract
 * This is the main contract that combines all domain-specific contracts
 */
export const appContract = oc.router({
	auth: authContract,
	streaming: streamingContract,
	modems: modemsContract,
	wifi: wifiContract,
	network: networkContract,
	system: systemContract,
	status: statusContract,
	notifications: notificationsContract,
});

/**
 * Type for the application router (used for client type inference)
 */
export type AppContract = typeof appContract;

// Re-export individual contracts for granular usage
export { authContract } from './auth.contract';
export { modemsContract } from './modems.contract';
export { networkContract } from './network.contract';
export { notificationsContract } from './notifications.contract';
export { statusContract } from './status.contract';
export { streamingContract } from './streaming.contract';
export { systemContract } from './system.contract';
export { wifiContract } from './wifi.contract';
