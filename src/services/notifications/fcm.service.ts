import type { Message, MulticastMessage, SendResponse } from 'firebase-admin/messaging';

import { firebaseMessaging } from '../../config/firebase-admin';
import { logger } from '../../config/logger';
import { UserDeviceToken } from '../../models/UserDeviceToken';

const INVALID_TOKEN_ERROR_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
]);

export type FcmSendResult = {
  tokens: string[];
  successCount: number;
  failureCount: number;
  responses: SendResponse[];
  invalidTokens: string[];
};

export async function sendFcmToTokens(
  tokens: string[],
  message: Omit<Message, 'token'> & { notification?: Message['notification'] },
): Promise<FcmSendResult> {
  const uniqueTokens = Array.from(new Set(tokens)).filter(Boolean);
  if (uniqueTokens.length === 0) {
    return { tokens: [], successCount: 0, failureCount: 0, responses: [], invalidTokens: [] };
  }

  const multicast: MulticastMessage = {
    ...message,
    tokens: uniqueTokens,
  };

  const batch = await firebaseMessaging().sendEachForMulticast(multicast);

  const invalidTokens: string[] = [];
  let loggedFirstFailure = false;
  batch.responses.forEach((r, idx) => {
    if (r.success) return;
    const code = (r.error as any)?.code as string | undefined;
    const message = (r.error as any)?.message as string | undefined;
    if (!loggedFirstFailure) {
      loggedFirstFailure = true;
      logger.warn(
        { code, message, failureCount: batch.failureCount, tokenIndex: idx },
        'FCM multicast delivery failure (first error)',
      );
    }
    if (code && INVALID_TOKEN_ERROR_CODES.has(code)) {
      invalidTokens.push(uniqueTokens[idx]!);
    }
  });

  if (invalidTokens.length > 0) {
    try {
      await UserDeviceToken.query().whereIn('token', invalidTokens).patch({ enabled: false });
    } catch (err) {
      logger.warn({ err }, 'Failed to disable invalid FCM tokens');
    }
  }

  return {
    tokens: uniqueTokens,
    successCount: batch.successCount,
    failureCount: batch.failureCount,
    responses: batch.responses,
    invalidTokens,
  };
}
