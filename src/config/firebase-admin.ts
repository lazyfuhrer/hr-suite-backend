import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { env } from './env';
import { logger } from './logger';

type FirebaseServiceAccountJson = {
  project_id?: string;
  private_key?: string;
  client_email?: string;
};

function parseServiceAccount(): FirebaseServiceAccountJson {
  if (!env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required for Firebase Admin initialization');
  }

  let parsed: FirebaseServiceAccountJson;
  try {
    parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as FirebaseServiceAccountJson;
  } catch (error) {
    logger.error({ err: error }, 'Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON');
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }

  if (!parsed.project_id || !parsed.private_key || !parsed.client_email) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON must include project_id, private_key, and client_email',
    );
  }

  return {
    ...parsed,
    private_key: parsed.private_key.replace(/\\n/g, '\n'),
  };
}

function ensureFirebaseApp() {
  if (getApps().length > 0) {
    return getApps()[0]!;
  }

  const serviceAccount = parseServiceAccount();

  return initializeApp({
    credential: cert({
      projectId: serviceAccount.project_id,
      privateKey: serviceAccount.private_key,
      clientEmail: serviceAccount.client_email,
    }),
    projectId: env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
  });
}

export function firebaseMessaging() {
  return getMessaging(ensureFirebaseApp());
}
