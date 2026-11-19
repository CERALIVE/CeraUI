import { z } from 'zod';

export const bootIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
export const timestampSchema = z.number().int().nonnegative();
export const countSchema = z.number().int().nonnegative();
