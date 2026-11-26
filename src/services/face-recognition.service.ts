import { knex } from '../config/database';
import { logger } from '../config/logger';
import {
  RekognitionClient,
  IndexFacesCommand,
  SearchFacesByImageCommand,
} from '@aws-sdk/client-rekognition';

const rekognition = new RekognitionClient({ region: process.env.AWS_REGION });
const COLLECTION_ID = process.env.REKOGNITION_COLLECTION_ID;

if (!COLLECTION_ID) {
  logger.warn('REKOGNITION_COLLECTION_ID is not set; face recognition will be disabled.');
}

export async function indexUserFaceFromS3(
  orgId: string,
  userId: string,
  bucket: string,
  key: string,
  options?: { rethrow?: boolean },
): Promise<void> {
  const rethrow = options?.rethrow ?? false;

  if (!COLLECTION_ID) return;

  try {
    const cmd = new IndexFacesCommand({
      CollectionId: COLLECTION_ID,
      ExternalImageId: userId,
      Image: { S3Object: { Bucket: bucket, Name: key } },
      DetectionAttributes: [],
    });
    const resp = await rekognition.send(cmd);
    const faceId = resp.FaceRecords?.[0]?.Face?.FaceId;

    if (!faceId) {
      logger.warn({ orgId, userId, bucket, key }, 'No face detected when indexing user face');
      if (rethrow) {
        const err: any = new Error('NO_FACE_DETECTED');
        err.code = 'NO_FACE_DETECTED';
        throw err;
      }
      return;
    }

    const existingForUser = await knex('user_face_embeddings')
      .where({ org_id: orgId, user_id: userId })
      .first();

    if (existingForUser) {
      await knex('user_face_embeddings').where({ id: existingForUser.id }).update({
        provider: 'rekognition',
        rekognition_collection_id: COLLECTION_ID,
        rekognition_face_id: faceId,
        updated_at: knex.fn.now(),
      });
    } else {
      await knex('user_face_embeddings').insert({
        org_id: orgId,
        user_id: userId,
        provider: 'rekognition',
        rekognition_collection_id: COLLECTION_ID,
        rekognition_face_id: faceId,
      });
    }
  } catch (error) {
    logger.error(
      { err: error, orgId, userId, bucket, key },
      'Failed to index user face in Rekognition',
    );
    if (rethrow) {
      throw error;
    }
  }
}

export async function identifyUserByS3Image(
  orgId: string,
  bucket: string,
  key: string,
  similarityThreshold = 90,
): Promise<{ userId: string; similarity: number } | null> {
  if (!COLLECTION_ID) {
    return null;
  }

  try {
    const cmd = new SearchFacesByImageCommand({
      CollectionId: COLLECTION_ID,
      Image: { S3Object: { Bucket: bucket, Name: key } },
      FaceMatchThreshold: similarityThreshold,
      MaxFaces: 1,
    });
    const resp = await rekognition.send(cmd);
    const match = resp.FaceMatches?.[0];
    if (!match?.Face?.FaceId) {
      return null;
    }

    const faceId = match.Face.FaceId;
    const row = await knex('user_face_embeddings')
      .where({ org_id: orgId, rekognition_face_id: faceId })
      .first();

    if (!row) {
      const matchedExternalImageId = match.Face.ExternalImageId ?? null;

      // Fallback: if Rekognition provides ExternalImageId and it belongs to an org user,
      // resolve by that user and heal missing face-id mapping for future requests.
      if (matchedExternalImageId) {
        const userInOrg = await knex('users')
          .where({ id: matchedExternalImageId, org_id: orgId })
          .select('id')
          .first();
        if (userInOrg) {
          const existingForUser = await knex('user_face_embeddings')
            .where({ org_id: orgId, user_id: matchedExternalImageId })
            .first();
          if (existingForUser) {
            await knex('user_face_embeddings').where({ id: existingForUser.id }).update({
              provider: 'rekognition',
              rekognition_collection_id: COLLECTION_ID,
              rekognition_face_id: faceId,
              updated_at: knex.fn.now(),
            });
          } else {
            await knex('user_face_embeddings').insert({
              org_id: orgId,
              user_id: matchedExternalImageId,
              provider: 'rekognition',
              rekognition_collection_id: COLLECTION_ID,
              rekognition_face_id: faceId,
            });
          }
          return { userId: matchedExternalImageId, similarity: match.Similarity ?? 0 };
        }
      }
      return null;
    }
    return { userId: row.user_id, similarity: match.Similarity ?? 0 };
  } catch (error) {
    logger.error({ err: error, orgId, bucket, key }, 'Failed to identify user by S3 image');
    return null;
  }
}
