import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageEngine } from 'multer';
import type { Request } from 'express';
import crypto from 'crypto';

import { env } from '../config/env';

// WeakMap to store S3 metadata for each file
const fileMetadataMap = new WeakMap<
  Express.Multer.File,
  { bucket: string; key: string; location: string }
>();

let cachedClient: S3Client | null = null;

const requireS3Config = () => {
  if (!env.AWS_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY || !env.S3_BUCKET) {
    throw new Error('S3 configuration is missing');
  }
};

export const getS3Client = (): S3Client => {
  if (!cachedClient) {
    requireS3Config();
    cachedClient = new S3Client({
      region: env.AWS_REGION!,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      },
    });
  }
  return cachedClient;
};

export const buildS3PublicUrl = (key: string): string => {
  requireS3Config();
  if (env.S3_PUBLIC_URL) {
    return `${env.S3_PUBLIC_URL.replace(/\/+$/, '')}/${key}`;
  }
  return `https://${env.S3_BUCKET!}.s3.${env.AWS_REGION!}.amazonaws.com/${key}`;
};

/**
 * Get S3 metadata for a file uploaded via multer
 */
export const getFileS3Metadata = (
  file: Express.Multer.File,
): { bucket: string; key: string; location: string } | null => {
  return fileMetadataMap.get(file) || null;
};

const sanitizeFilename = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');

interface S3StorageOptions {
  key?: (req: Request, file: Express.Multer.File, cb: (error: any, key?: string) => void) => void;
  contentType?: (
    req: Request,
    file: Express.Multer.File,
    cb: (error: any, contentType?: string) => void,
  ) => void;
}

export const createS3Storage = (options?: S3StorageOptions): StorageEngine => {
  return {
    _handleFile: async (
      req: Request,
      file: Express.Multer.File,
      cb: (error?: any, info?: Partial<Express.Multer.File>) => void,
    ) => {
      try {
        requireS3Config();
        const s3Client = getS3Client();

        // Generate key
        let key: string;
        if (options?.key) {
          key = await new Promise<string>((resolve, reject) => {
            options.key!(req, file, (err, k) => {
              if (err) reject(err);
              else resolve(k!);
            });
          });
        } else {
          // Default key generation
          const user = (req as any).user;
          if (!user) {
            return cb(new Error('User not authenticated'));
          }

          // Support either a single doc_category/doc_type (applies to all files)
          // or arrays (doc_category[], doc_type[]) aligned with files[] order.
          const body: any = req.body ?? {};
          const rawCategory = body.doc_category;
          const rawType = body.doc_type;

          const fileIndexByField: Record<string, number> =
            ((req as any)._uploadFileIndexByField as Record<string, number> | undefined) ?? {};
          (req as any)._uploadFileIndexByField = fileIndexByField;

          const field = file.fieldname || 'file';
          const currentIndex = fileIndexByField[field] ?? 0;
          fileIndexByField[field] = currentIndex + 1;

          const doc_category = Array.isArray(rawCategory) ? rawCategory[currentIndex] : rawCategory;
          const doc_type = Array.isArray(rawType) ? rawType[currentIndex] : rawType;

          if (!doc_category || !doc_type) {
            return cb(new Error('doc_category and doc_type are required'));
          }

          const safeName = sanitizeFilename(file.originalname);
          key = [
            'orgs',
            user.org_id,
            'users',
            user.id,
            'documents',
            doc_category,
            doc_type,
            `${crypto.randomUUID()}-${safeName}`,
          ].join('/');

          // Persist the resolved per-file metadata so controllers can return it reliably
          (file as any).doc_category = doc_category;
          (file as any).doc_type = doc_type;
        }

        // Get content type
        let contentType: string | undefined;
        if (options?.contentType) {
          contentType = await new Promise<string | undefined>((resolve, reject) => {
            options.contentType!(req, file, (err, ct) => {
              if (err) reject(err);
              else resolve(ct);
            });
          });
        } else {
          contentType = file.mimetype || undefined;
        }

        // Read file buffer
        const chunks: Buffer[] = [];
        let isProcessing = false;

        const processBuffer = async () => {
          if (isProcessing) return;
          isProcessing = true;

          try {
            const buffer = Buffer.concat(chunks);
            const maxBytes = env.S3_UPLOAD_MAX_MB * 1024 * 1024;
            if (buffer.length > maxBytes) {
              return cb(new Error(`File size exceeds ${env.S3_UPLOAD_MAX_MB}MB limit`));
            }

            const command = new PutObjectCommand({
              Bucket: env.S3_BUCKET!,
              Key: key,
              Body: buffer,
              ContentType: contentType,
            });

            await s3Client.send(command);

            const fileUrl = buildS3PublicUrl(key);

            // Store S3 metadata in WeakMap for access in controller
            fileMetadataMap.set(file, {
              bucket: env.S3_BUCKET!,
              key,
              location: fileUrl,
            });

            // Also attach to file object for direct access (fallback)
            (file as any).bucket = env.S3_BUCKET!;
            (file as any).key = key;
            (file as any).location = fileUrl;

            cb(null, {
              fieldname: file.fieldname,
              originalname: file.originalname,
              encoding: file.encoding,
              mimetype: file.mimetype,
              size: buffer.length,
            });
          } catch (error) {
            cb(error);
          }
        };

        // Attach event listeners
        file.stream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        file.stream.on('end', processBuffer);

        file.stream.on('error', (error) => {
          cb(error);
        });
      } catch (error) {
        cb(error);
      }
    },

    _removeFile: async (
      req: Request,
      file: Express.Multer.File,
      cb: (error: Error | null) => void,
    ) => {
      // Optional: Implement file removal if needed
      cb(null);
    },
  };
};
