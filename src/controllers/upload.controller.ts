import type { Request, Response } from 'express';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import multer from 'multer';
import crypto from 'crypto';

import { env } from '../config/env';
import { uploadPresignSchema } from '../validators';
import { buildS3PublicUrl, getS3Client } from '../utils/s3';

const sanitizeFilename = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');

// Configure multer for direct file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.S3_UPLOAD_MAX_MB * 1024 * 1024, // Use same limit as presign
  },
});

export class UploadController {
  /**
   * Generate a presigned URL for direct S3 upload
   */
  static async createPresignedUrl(req: Request, res: Response): Promise<Response> {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const parsed = uploadPresignSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        message: 'Invalid request body',
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const { file_name, content_type, file_size, doc_category, doc_type } = parsed.data;
    const maxBytes = env.S3_UPLOAD_MAX_MB * 1024 * 1024;
    if (file_size > maxBytes) {
      return res.status(400).json({
        message: `File size exceeds ${env.S3_UPLOAD_MAX_MB}MB limit`,
      });
    }

    const safeName = sanitizeFilename(file_name);
    const key = [
      'orgs',
      req.user.org_id,
      'users',
      req.user.id,
      'documents',
      doc_category,
      doc_type,
      'uploaded-by',
      req.user.id,
      `${crypto.randomUUID()}-${safeName}`,
    ].join('/');

    const client = getS3Client();
    const command = new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentType: content_type,
    });

    try {
      const upload_url = await getSignedUrl(client, command, { expiresIn: 300 });
      const file_url = buildS3PublicUrl(key);

      return res.json({
        upload_url,
        file_key: key,
        file_url,
        expires_in: 300,
      });
    } catch (error) {
      return res.status(500).json({
        message: error instanceof Error ? error.message : 'Failed to generate presigned URL',
      });
    }
  }

  /**
   * Direct file upload endpoint - uploads one or multiple files to S3 and returns file_urls
   * Accepts multipart/form-data with:
   * - files: one or multiple files (array)
   * - doc_category: IDENTITY | EDUCATION | EXPERIENCE | FINANCE | LEGAL (applies to all files)
   * - doc_type: string (applies to all files) OR
   * - doc_types: array of strings matching files (one per file)
   *
   * If doc_types array is provided, it must match the number of files.
   * If only doc_type is provided, it applies to all files.
   */
  static uploadFile = [
    upload.array('files', 20), // Allow up to 20 files
    async (req: Request, res: Response): Promise<Response> => {
      if (!req.user) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ message: 'No files uploaded' });
      }

      const { doc_category, doc_type, doc_types } = req.body;

      // Validate doc_category
      const validCategories = ['IDENTITY', 'EDUCATION', 'EXPERIENCE', 'FINANCE', 'LEGAL'];
      if (!doc_category || !validCategories.includes(doc_category)) {
        return res.status(400).json({
          message: 'Invalid doc_category. Must be one of: ' + validCategories.join(', '),
        });
      }

      // Parse doc_types array if provided
      let docTypesArray: string[] = [];
      if (doc_types) {
        try {
          // Handle both JSON array string and actual array
          docTypesArray = Array.isArray(doc_types) ? doc_types : JSON.parse(doc_types);
          if (!Array.isArray(docTypesArray) || docTypesArray.length !== files.length) {
            return res.status(400).json({
              message: `doc_types array must have ${files.length} elements (one per file)`,
            });
          }
        } catch {
          return res.status(400).json({
            message: 'doc_types must be a valid array matching the number of files',
          });
        }
      } else if (doc_type) {
        // Use single doc_type for all files
        if (typeof doc_type !== 'string' || doc_type.trim().length === 0) {
          return res
            .status(400)
            .json({ message: 'doc_type is required and must be a non-empty string' });
        }
        docTypesArray = Array(files.length).fill(doc_type.trim());
      } else {
        return res.status(400).json({
          message: 'Either doc_type (for all files) or doc_types array (one per file) is required',
        });
      }

      const client = getS3Client();

      try {
        // Upload all files in parallel
        const uploadPromises = files.map(async (file, index) => {
          const docType = docTypesArray[index]?.trim();
          if (!docType || docType.length === 0) {
            throw new Error(`doc_type is required for file ${index + 1}`);
          }

          const safeName = sanitizeFilename(file.originalname);
          const key = [
            'orgs',
            req.user.org_id,
            'users',
            req.user.id,
            'documents',
            doc_category,
            docType,
            'uploaded-by',
            req.user.id,
            `${crypto.randomUUID()}-${safeName}`,
          ].join('/');

          // Upload file to S3
          await client.send(
            new PutObjectCommand({
              Bucket: env.S3_BUCKET,
              Key: key,
              Body: file.buffer,
              ContentType: file.mimetype,
            }),
          );

          const file_url = buildS3PublicUrl(key);

          return {
            file_url,
            file_key: key,
            file_name: file.originalname,
            file_size: file.size,
            content_type: file.mimetype,
            doc_category,
            doc_type: docType,
          };
        });

        const results = await Promise.all(uploadPromises);

        return res.json({
          files: results,
          count: results.length,
        });
      } catch (error) {
        return res.status(500).json({
          message: error instanceof Error ? error.message : 'Failed to upload files',
        });
      }
    },
  ];
}
