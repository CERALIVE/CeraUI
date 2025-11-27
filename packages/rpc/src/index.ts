/**
 * @ceraui/rpc - Shared ORPC contracts and Zod schemas
 *
 * This package provides end-to-end type safety between the CeraUI frontend and backend
 * through shared ORPC contracts and Zod validation schemas.
 *
 * @example
 * ```typescript
 * // Import contracts for type inference
 * import { appContract, type AppContract } from '@ceraui/rpc';
 *
 * // Import schemas for validation
 * import { loginInputSchema, statusMessageSchema } from '@ceraui/rpc/schemas';
 * ```
 */

// Export all contracts
export * from './contracts';

// Export all schemas
export * from './schemas';
