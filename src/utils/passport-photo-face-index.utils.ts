import { DeleteObjectCommand } from '@aws-sdk/client-s3';

import { env } from '../config/env';
import { getS3Client } from './s3';

export type PassportPhotoFaceIndexErrorResponse = {
  status: 400;
  message: string;
};

export const getPassportPhotoFaceIndexErrorResponse = (
  err: unknown,
): PassportPhotoFaceIndexErrorResponse => {
  const code = String(
    (err as { name?: string; Code?: string; code?: string })?.name ??
      (err as { Code?: string })?.Code ??
      (err as { code?: string })?.code ??
      '',
  );

  if (code === 'InvalidImageFormatException') {
    return {
      status: 400,
      message: '`passport_size_photo` must be a valid image (JPG/PNG). PDFs are not supported.',
    };
  }

  if (
    String((err as { code?: string; message?: string })?.code ?? (err as Error)?.message ?? '') ===
    'NO_FACE_DETECTED'
  ) {
    return {
      status: 400,
      message: 'No face detected in Passport Size Photo. Please upload a clear front-facing photo.',
    };
  }

  return {
    status: 400,
    message: 'Failed to process Passport Size Photo. Please upload a valid image.',
  };
};

export const cleanupUploadedS3Keys = async (keys: string[]): Promise<void> => {
  if (!env.S3_BUCKET) {
    return;
  }

  const uniqueKeys = [
    ...new Set(keys.map((k) => String(k ?? '').trim()).filter((k) => k.length > 0)),
  ];
  if (uniqueKeys.length === 0) {
    return;
  }

  const client = getS3Client();
  await Promise.all(
    uniqueKeys.map((key) =>
      client
        .send(
          new DeleteObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
          }),
        )
        .catch(() => {
          // best-effort cleanup only
        }),
    ),
  );
};
