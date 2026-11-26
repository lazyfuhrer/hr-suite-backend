import { z } from 'zod';

// Helper to accept enums case-insensitively by uppercasing incoming strings
const upperEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (value) => (typeof value === 'string' ? value.toUpperCase() : value),
    z.enum(values),
  );

// Employee documents list query schema
export const userDocumentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
  category: upperEnum(['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL']).optional(),
  status: upperEnum(['PENDING', 'VERIFIED', 'REJECTED']).optional(),
  search: z
    .string()
    .optional()
    .transform((e) => (e === '' ? undefined : e)),
  sort_by: upperEnum(['NAME', 'CATEGORY', 'UPLOADED_DATE', 'STATUS'])
    .optional()
    .default('UPLOADED_DATE'),
  sort_dir: upperEnum(['ASC', 'DESC']).optional().default('DESC'),
});
