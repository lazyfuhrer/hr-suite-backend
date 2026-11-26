import multer from 'multer';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Request, Response, NextFunction, RequestHandler } from 'express';

import { logger } from '../config/logger';
import { env } from '../config/env';
import { getS3Client, buildS3PublicUrl } from './s3';

export interface S3UploadResult {
  doc_category: string;
  doc_type: string;
  file_url: string;
  file_key: string;
}

const s3Client = getS3Client();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 35 * 1024 * 1024 }, // 10MB
});

// Helper to sanitize filenames
const getSafeName = (name: string) => name.replace(/[^\w.-]/g, '_');

/**
 * Middleware for General Onboarding Documents
 * Usage: s3UploadMiddleware([{ name: 'aadhar_front', maxCount: 1 }, ...])
 */
export const s3UploadMiddleware = (fields: any[]): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.fields(fields)(req, res, async (err) => {
      if (err) {
        console.log('-----------------------------------------');
        console.log('MULTER ERROR DETECTED');
        console.log('Error Message:', err.message);
        console.log('Field Name causing error:', err.field);
        console.log('-----------------------------------------');
        return res.status(400).json({
          error: err.message,
          unexpectedField: err.field,
        });
      }

      try {
        if (!req.files || typeof req.files !== 'object') return next();

        console.log('FILES RECEIVED:', Object.keys(req.files));

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const user = (req as any).user;

        if (!user?.id || !user?.org_id) {
          return res.status(400).json({ message: 'Context missing' });
        }

        const uploadResults: any[] = [];
        const CATEGORY_MAP: Record<string, string> = {
          aadhar_front: 'IDENTITY',
          aadhar_back: 'IDENTITY',
          pan_card: 'IDENTITY',
          passport_size_photo: 'IDENTITY',
          passport: 'IDENTITY',
          marksheet_10th: 'EDUCATION',
          marksheet_12th: 'EDUCATION',
          degree_certificate: 'EDUCATION',
          previous_offer_letters: 'EXPERIENCE',
          experience_letter: 'EXPERIENCE',
          salary_slip_month_1: 'EXPERIENCE',
          salary_slip_month_2: 'EXPERIENCE',
          salary_slip_month_3: 'EXPERIENCE',
        };

        for (const [fieldName, fileArray] of Object.entries(files)) {
          const category = CATEGORY_MAP[fieldName] || 'IDENTITY';

          for (const file of fileArray) {
            const safeName = getSafeName(file.originalname);
            const key = `orgs/${user.org_id}/users/${user.id}/documents/${category}/${fieldName}/${Date.now()}_${safeName}`;

            await s3Client.send(
              new PutObjectCommand({
                Bucket: process.env.S3_BUCKET!,
                Key: key,
                Body: file.buffer,
                ContentType: file.mimetype,
              }),
            );

            uploadResults.push({
              doc_category: category,
              doc_type: fieldName.toUpperCase(),
              file_url: buildS3PublicUrl(key),
              file_key: key,
            });
          }
        }

        (req as any).s3Uploads = uploadResults;
        next();
      } catch (error) {
        console.error('S3 LOGIC ERROR:', error);
        res.status(500).json({ error: 'Upload failed' });
      }
    });
  };
};

/**
 * Variant of s3UploadMiddleware used for extra employee uploads.
 * Same category/doc_type mapping, but keeps the original filename (no timestamp prefix).
 */
export const s3UploadMiddlewareKeepOriginalName = (fields: any[]): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.fields(fields)(req, res, async (err) => {
      if (err) {
        console.log('-----------------------------------------');
        console.log('MULTER ERROR DETECTED');
        console.log('Error Message:', err.message);
        console.log('Field Name causing error:', err.field);
        console.log('-----------------------------------------');
        return res.status(400).json({
          error: err.message,
          unexpectedField: err.field,
        });
      }

      try {
        if (!req.files || typeof req.files !== 'object') return next();

        const files = req.files as { [fieldname: string]: Express.Multer.File[] };
        const user = (req as any).user;

        if (!user?.id || !user?.org_id) {
          return res.status(400).json({ message: 'Context missing' });
        }

        const uploadResults: any[] = [];
        const CATEGORY_MAP: Record<string, string> = {
          aadhar_front: 'IDENTITY',
          aadhar_back: 'IDENTITY',
          pan_card: 'IDENTITY',
          passport_size_photo: 'IDENTITY',
          passport: 'IDENTITY',
          marksheet_10th: 'EDUCATION',
          marksheet_12th: 'EDUCATION',
          degree_certificate: 'EDUCATION',
          previous_offer_letters: 'EXPERIENCE',
          experience_letter: 'EXPERIENCE',
          salary_slip_month_1: 'EXPERIENCE',
          salary_slip_month_2: 'EXPERIENCE',
          salary_slip_month_3: 'EXPERIENCE',
        };

        for (const [fieldName, fileArray] of Object.entries(files)) {
          const category = CATEGORY_MAP[fieldName] || 'IDENTITY';

          for (const file of fileArray) {
            const safeName = getSafeName(file.originalname);
            const key = `orgs/${user.org_id}/users/${user.id}/documents/${category}/${fieldName}/${safeName}`;

            await s3Client.send(
              new PutObjectCommand({
                Bucket: process.env.S3_BUCKET!,
                Key: key,
                Body: file.buffer,
                ContentType: file.mimetype,
              }),
            );

            uploadResults.push({
              doc_category: category,
              doc_type: fieldName.toUpperCase(),
              file_url: buildS3PublicUrl(key),
              file_key: key,
            });
          }
        }

        (req as any).s3Uploads = uploadResults;
        next();
      } catch (error) {
        console.error('S3 LOGIC ERROR:', error);
        res.status(500).json({ error: 'Upload failed' });
      }
    });
  };
};

/**
 * Specialized Middleware for Bank Proof
 * Handles fields named 'cancelled_cheque' OR 'passbook_copy'
 */
export const bankMediaUploader: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // 1. First, call multer to parse the files
  upload.fields([
    { name: 'cancelled_cheque', maxCount: 1 },
    { name: 'passbook_copy', maxCount: 1 },
  ])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] };
      // 2. Extract whichever field was actually uploaded
      const fieldName = Object.keys(files || {})[0];
      const fileToUpload = files?.[fieldName]?.[0];

      if (!fileToUpload) return next();

      const user = (req as any).user;
      const key = `orgs/${user.org_id}/users/${user.id}/finance/bank_proof_${Date.now()}_${getSafeName(fileToUpload.originalname)}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: fileToUpload.buffer,
          ContentType: fileToUpload.mimetype,
        }),
      );

      (req as any).bankMedia = {
        url: buildS3PublicUrl(key),
        key: key,
      };

      next();
    } catch (error) {
      logger.error({ err: error }, 'Bank Media Upload Error');
      res.status(500).json({ message: 'Failed to upload bank document' });
    }
  });
};

/**
 * Specialized middleware for Attendance Regularization attachment.
 * Expects a single file field named "attachment".
 * On success, sets req.regularizationAttachment = { url, key }.
 */
export const attendanceAttachmentUploader: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return next();

      const user = (req as any).user;
      if (!user?.id || !user?.org_id) return res.status(400).json({ message: 'Context missing' });

      const key = `orgs/${user.org_id}/users/${user.id}/attendance/regularizations/${Date.now()}_${getSafeName(file.originalname)}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      (req as any).regularizationAttachment = {
        url: buildS3PublicUrl(key),
        key,
      };

      next();
    } catch (error) {
      logger.error({ err: error }, 'Attendance Regularization Attachment Upload Error');
      res.status(500).json({ message: 'Failed to upload attachment' });
    }
  });
};

/**
 * Specialized middleware for Leave Request attachment.
 * Expects a single file field named "leave_doc".
 * On success, sets req.leaveAttachment = { url, key }.
 */
export const leaveAttachmentUploader: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  upload.single('leave_doc')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return next();

      const user = (req as any).user;
      if (!user?.id || !user?.org_id) return res.status(400).json({ message: 'Context missing' });

      const key = `orgs/${user.org_id}/users/${user.id}/leaves/attachments/${Date.now()}_${getSafeName(file.originalname)}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      (req as any).leaveAttachment = {
        url: buildS3PublicUrl(key),
        key,
      };

      next();
    } catch (error) {
      logger.error({ err: error }, 'Leave Attachment Upload Error');
      res.status(500).json({ message: 'Failed to upload leave attachment' });
    }
  });
};

/**
 * Specialized middleware for WFH Request attachment.
 * Expects a single file field named "wfh_doc".
 * On success, sets req.wfhAttachment = { url, key }.
 */
export const wfhAttachmentUploader: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  upload.single('wfh_doc')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return next();

      const user = (req as any).user;
      if (!user?.id || !user?.org_id) return res.status(400).json({ message: 'Context missing' });

      const key = `orgs/${user.org_id}/users/${user.id}/wfh/attachments/${Date.now()}_${getSafeName(file.originalname)}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      (req as any).wfhAttachment = {
        url: buildS3PublicUrl(key),
        key,
      };

      next();
    } catch (error) {
      logger.error({ err: error }, 'WFH Attachment Upload Error');
      res.status(500).json({ message: 'Failed to upload WFH attachment' });
    }
  });
};

/**
 * Specialized middleware for Reimbursement Request attachment.
 * Expects a single file field named "reimbursement_doc".
 * On success, sets req.reimbursementAttachment = { url, key }.
 */
export const reimbursementAttachmentUploader: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  upload.single('reimbursement_doc')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return next();

      const user = (req as any).user;
      if (!user?.id || !user?.org_id) return res.status(400).json({ message: 'Context missing' });

      const key = `orgs/${user.org_id}/users/${user.id}/reimbursements/attachments/${Date.now()}_${getSafeName(file.originalname)}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      (req as any).reimbursementAttachment = {
        url: buildS3PublicUrl(key),
        key,
      };

      next();
    } catch (error) {
      logger.error({ err: error }, 'Reimbursement Attachment Upload Error');
      res.status(500).json({ message: 'Failed to upload reimbursement attachment' });
    }
  });
};

/**
 * Specialized middleware for Helpdesk ticket attachment.
 * Expects a single file field named \"attachment\".
 * On success, sets req.helpdeskAttachment = { url, key }.
 */
export const helpdeskAttachmentUploader: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  upload.single('attachment')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    try {
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) return next();

      const user = (req as any).user;
      if (!user?.id || !user?.org_id) {
        return res.status(400).json({ message: 'Context missing' });
      }

      const key = `orgs/${user.org_id}/users/${user.id}/helpdesk/${Date.now()}_${getSafeName(
        file.originalname,
      )}`;

      await s3Client.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET!,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      (req as any).helpdeskAttachment = {
        url: buildS3PublicUrl(key),
        key,
      };

      next();
    } catch (error) {
      logger.error({ err: error }, 'Helpdesk Attachment Upload Error');
      res.status(500).json({ message: 'Failed to upload helpdesk attachment' });
    }
  });
};

/**
 * Upload a cancelled cheque for a specific user (admin PATCH on behalf of employee).
 */
export async function uploadCancelledChequeForUser(
  orgId: string,
  userId: string,
  file: Express.Multer.File,
): Promise<{ file_url: string; file_key: string }> {
  const safeName = getSafeName(file.originalname);
  const key = `orgs/${orgId}/users/${userId}/finance/bank_proof_${Date.now()}_${safeName}`;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET!,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }),
  );

  return {
    file_url: buildS3PublicUrl(key),
    file_key: key,
  };
}

export const s3OrgUploadMiddleware = (): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    upload.any()(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });

      if (!req.files || (req.files as Express.Multer.File[]).length === 0) {
        return next();
      }

      try {
        const files = req.files as Express.Multer.File[];
        const user = (req as any).user;
        const uploadResults: any[] = [];
        const AUTO_CATEGORY_MAP: Record<string, string> = {
          nda: 'COMPLIANCE',
          coc: 'COMPLIANCE',
          incorporation: 'LEGAL',
          tax_info: 'FINANCIAL',
          audit: 'FINANCIAL',
          license: 'OPERATIONAL',
          other: 'OTHER',
        };

        for (const file of files) {
          const fieldName = file.fieldname.toLowerCase();
          const category = req.body.doc_category || AUTO_CATEGORY_MAP[fieldName] || 'OTHER';
          const safeName = getSafeName(file.originalname);
          const key = `organizational-documents/${user.org_id}/${category}/${fieldName}/${Date.now()}_${safeName}`;

          await s3Client.send(
            new PutObjectCommand({
              Bucket: env.S3_BUCKET!,
              Key: key,
              Body: file.buffer,
              ContentType: file.mimetype,
            }),
          );

          uploadResults.push({
            doc_type: fieldName.toUpperCase(),
            file_url: buildS3PublicUrl(key),
            doc_category: category,
            file_key: key,
          });
        }

        (req as any).s3Uploads = uploadResults;
        next();
      } catch (error) {
        console.log(error);
        res.status(500).json({ error: 'S3 Upload failed' });
      }
    });
  };
};
