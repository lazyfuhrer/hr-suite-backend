import { z } from 'zod';

export const helpdeskCategorySchema = z.enum([
  'it_support',
  'hr_query',
  'payroll',
  'attendance',
  'leave',
] as const);

export const helpdeskPrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH'] as const);

export const helpdeskStatusSchema = z.enum([
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'REOPENED',
] as const);

export const helpdeskTicketCreateSchema = z.object({
  category: helpdeskCategorySchema,
  subject: z.string().trim().min(1).max(255),
  description: z.string().trim().min(1),
  priority: helpdeskPrioritySchema.optional().default('MEDIUM'),
});

export const helpdeskTicketListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10),
  category: helpdeskCategorySchema.optional(),
  status: helpdeskStatusSchema.optional(),
  priority: helpdeskPrioritySchema.optional(),
  created_by: z.string().uuid().optional(),
  assigned_to: z.string().uuid().optional(),
  search: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

export const helpdeskTicketIdParamsSchema = z.object({
  ticketId: z.string().uuid(),
});

export const helpdeskTicketCommentCreateSchema = z.object({
  message: z.string().trim().min(1),
  attachment_file_key: z.string().trim().min(1).max(1024).optional(),
  attachment_file_url: z.string().trim().url().optional(),
});

export const helpdeskTicketStatusSchema = z.object({
  status: helpdeskStatusSchema,
  approver_comment: z.string().trim().max(2000).optional(),
});

export const helpdeskTicketAssignSchema = z.object({
  assigned_to: z.string().uuid().nullable(),
});
