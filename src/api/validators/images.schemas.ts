/**
 * Request schemas for the /api/images endpoints.
 * All shapes parsed at the HTTP boundary with zod.
 */
import { z } from 'zod';

export const listImagesQuerySchema = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'FAILED']).optional(),
  limit: z.coerce.number().int().positive().max(100).default(24),
  cursor: z.string().uuid().optional(),
});

export type ListImagesQuery = z.infer<typeof listImagesQuerySchema>;

export const imageIdParamSchema = z.object({
  id: z.string().uuid('image id must be a valid uuid'),
});
