import { env } from '../config/env';

export type KycStatus = 'VERIFIED' | 'FAILED';

export type KycResult = {
  status: KycStatus;
  code?: string;
  message?: string;
  raw?: unknown;
};

type IdentityPayload = {
  aadharNumber?: string;
  panNumber?: string;
  fullName?: string;
};

type BankPayload = {
  accountNumber?: string;
  ifsc?: string;
  accountHolderName?: string;
};

async function callKycApi(path: string, body: Record<string, unknown>): Promise<KycResult> {
  const baseUrl = env.KYC_API_URL;
  const apiKey = env.KYC_API_KEY;

  if (!baseUrl || !apiKey) {
    // When not configured, treat as FAILED with a clear message so the caller
    // can decide how to surface this to admins.
    return {
      status: 'FAILED',
      code: 'KYC_NOT_CONFIGURED',
      message: 'KYC provider is not configured',
    };
  }

  const url = `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // no-op, leave data as null
  }

  if (!response.ok) {
    return {
      status: 'FAILED',
      code: data?.code ?? String(response.status),
      message: data?.message ?? 'KYC provider returned an error response',
      raw: data,
    };
  }

  const normalizedStatus: KycStatus =
    data?.status === 'VERIFIED' || data?.status === 'SUCCESS' ? 'VERIFIED' : 'FAILED';

  return {
    status: normalizedStatus,
    code: data?.code,
    message: data?.message,
    raw: data,
  };
}

export async function verifyIdentity(payload: IdentityPayload): Promise<KycResult> {
  return callKycApi('/identity/verify', payload);
}

export async function verifyBank(payload: BankPayload): Promise<KycResult> {
  return callKycApi('/bank/verify', payload);
}
