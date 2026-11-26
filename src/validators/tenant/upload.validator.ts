import { z } from 'zod';

const docCategoryEnum = z.enum(['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL']);

// Schema for multipart/form-data uploads
export const uploadSchema = z.object({
  doc_category: docCategoryEnum,
  doc_type: z.string().min(1),
});

// Schema for presigned URL generation
export const uploadPresignSchema = z.object({
  file_name: z.string().min(1),
  content_type: z.string().min(1),
  file_size: z.number().int().positive(),
  doc_category: docCategoryEnum,
  doc_type: z.string().min(1),
});
