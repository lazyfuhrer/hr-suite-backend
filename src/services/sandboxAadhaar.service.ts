type SandboxAuthResponse = {
  code?: number;
  data?: {
    access_token?: string;
  };
};

type SandboxApiError = {
  message?: string;
  error?: string;
  data?: {
    message?: string;
    error?: string;
  };
};

type SandboxConfig = {
  baseUrl: string;
  apiKey: string;
  apiSecret: string;
};

const sanitizeEnv = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeProfile = (value: string | undefined): 'TEST' | 'PROD' => {
  const normalized = (value ?? 'TEST').trim().toUpperCase();
  return normalized === 'PROD' ? 'PROD' : 'TEST';
};

const ensureUrl = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');
const isKycMockModeEnabled = (): boolean =>
  String(process.env.SANDBOX_KYC_MOCK_MODE ?? '')
    .trim()
    .toLowerCase() === 'true';

const extractSandboxError = (
  status: number,
  payload: SandboxApiError | null,
  fallback: string,
): string => {
  const message =
    payload?.message ?? payload?.error ?? payload?.data?.message ?? payload?.data?.error;
  return message ? `${fallback} (status ${status}): ${message}` : `${fallback} (status ${status})`;
};

const SANDBOX_BASE_URL_BY_PROFILE: Record<'TEST' | 'PROD', string> = {
  TEST: 'https://test-api.sandbox.co.in',
  PROD: 'https://api.sandbox.co.in',
};

function resolveSandboxConfig(): SandboxConfig {
  const profile = normalizeProfile(process.env.SANDBOX_PROFILE);
  const baseUrl = SANDBOX_BASE_URL_BY_PROFILE[profile];
  const apiKey = sanitizeEnv(process.env.SADBOX_API_KEY);
  const apiSecret = sanitizeEnv(process.env.SANDBOX_API_SECRET);

  if (!apiKey || !apiSecret) {
    throw new Error('Sandbox API credentials (SADBOX_API_KEY/SANDBOX_API_SECRET) are not set');
  }

  return {
    baseUrl: ensureUrl(baseUrl),
    apiKey,
    apiSecret,
  };
}

async function getSandboxAccessToken(): Promise<string> {
  const { baseUrl, apiKey, apiSecret } = resolveSandboxConfig();

  const resp = await fetch(`${baseUrl}/authenticate`, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'x-api-secret': apiSecret,
      'x-api-version': '1.0.0',
    },
  });

  let data: SandboxAuthResponse | null = null;
  try {
    data = (await resp.json()) as SandboxAuthResponse;
  } catch {
    // ignore; handled below
  }

  if (!resp.ok || !data?.data?.access_token) {
    throw new Error(
      extractSandboxError(
        resp.status,
        data as unknown as SandboxApiError,
        'Failed to obtain Sandbox access token',
      ),
    );
  }

  return data.data.access_token;
}

type GenerateOtpParams = {
  aadhaarNumber: string;
  consent: 'Y' | 'y';
  reason: string;
};

/** Thrown when Sandbox returns HTTP 200 with reference_id but business outcome is rejection (e.g. invalid Aadhaar). */
export class AadhaarOtpRejectedError extends Error {
  readonly referenceId: string;

  readonly providerMessage: string;

  constructor(referenceId: string, providerMessage: string) {
    super(providerMessage);
    this.name = 'AadhaarOtpRejectedError';
    this.referenceId = referenceId;
    this.providerMessage = providerMessage;
  }
}

function isSandboxAadhaarOtpGenerationRejected(payload: {
  status?: string;
  message?: string;
}): boolean {
  const statusRaw = String(payload.status ?? '').trim();
  const status = statusRaw.toUpperCase();
  if (status) {
    if (['FAILED', 'INVALID', 'REJECTED', 'ERROR', 'FAILURE'].includes(status)) {
      return true;
    }
    if (['SUCCESS', 'VALID', 'SENT', 'OK', 'PENDING', 'COMPLETED'].includes(status)) {
      return false;
    }
  }

  const m = String(payload.message ?? '').toLowerCase();
  if (!m) {
    return false;
  }

  if (m.includes('invalid') && (m.includes('aadhaar') || m.includes('card'))) {
    return true;
  }
  if (m.includes('not valid') && m.includes('aadhaar')) {
    return true;
  }
  if (m.includes('rejected') || m.includes('verification failed')) {
    return true;
  }

  return false;
}

export async function sandboxGenerateAadhaarOtp(params: GenerateOtpParams): Promise<{
  reference_id: string;
  message: string;
}> {
  if (isKycMockModeEnabled()) {
    return {
      reference_id: `MOCK-AADHAAR-${Date.now()}`,
      message: 'Mock Aadhaar OTP generated successfully',
    };
  }

  const { baseUrl, apiKey } = resolveSandboxConfig();

  const accessToken = await getSandboxAccessToken();

  const body = {
    '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.otp.request',
    aadhaar_number: params.aadhaarNumber,
    consent: params.consent,
    reason: params.reason,
  };

  const resp = await fetch(`${baseUrl}/kyc/aadhaar/okyc/otp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Sandbox Aadhaar OTP for this account expects raw JWT token (no Bearer prefix).
      Authorization: accessToken,
      'x-api-key': apiKey,
      'x-api-version': '1.0.0',
    },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as any;
  if (!resp.ok || !data?.data?.reference_id) {
    throw new Error(extractSandboxError(resp.status, data, 'Failed to generate Aadhaar OTP'));
  }

  const referenceId = String(data.data.reference_id);
  const message = data.data.message ?? 'OTP sent successfully';

  if (
    isSandboxAadhaarOtpGenerationRejected({
      status: data.data.status,
      message,
    })
  ) {
    throw new AadhaarOtpRejectedError(referenceId, message);
  }

  return {
    reference_id: referenceId,
    message,
  };
}

type VerifyOtpParams = {
  referenceId: string;
  otp: string;
};

export async function sandboxVerifyAadhaarOtp(params: VerifyOtpParams): Promise<{
  status: 'VALID' | 'INVALID';
  message: string;
  name?: string;
  date_of_birth?: string;
  gender?: string;
  full_address?: string;
}> {
  if (isKycMockModeEnabled()) {
    return {
      status: 'VALID',
      message: 'Mock Aadhaar OTP verification successful',
      name: 'Mock Aadhaar User',
      date_of_birth: '1990-01-01',
      gender: 'M',
      full_address: 'Mock Address, India',
    };
  }

  const { baseUrl, apiKey } = resolveSandboxConfig();

  const accessToken = await getSandboxAccessToken();

  const body = {
    '@entity': 'in.co.sandbox.kyc.aadhaar.okyc.request',
    reference_id: params.referenceId,
    otp: params.otp,
  };

  const resp = await fetch(`${baseUrl}/kyc/aadhaar/okyc/otp/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: accessToken,
      'x-api-key': apiKey,
      'x-api-version': '1.0.0',
    },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as any;
  if (!resp.ok || !data?.data) {
    throw new Error(extractSandboxError(resp.status, data, 'Failed to verify Aadhaar OTP'));
  }

  const status = data.data.status === 'VALID' ? 'VALID' : 'INVALID';

  return {
    status,
    message: data.data.message ?? '',
    name: data.data.name,
    date_of_birth: data.data.date_of_birth,
    gender: data.data.gender,
    full_address: data.data.full_address,
  };
}

type VerifyPanParams = {
  pan: string;
  nameAsPerPan: string;
  dateOfBirth: string; // DD/MM/YYYY
  consent: 'Y' | 'y';
  reason: string;
};

export async function sandboxVerifyPan(params: VerifyPanParams): Promise<{
  status: 'valid' | 'invalid';
  message: string;
  name_match?: boolean;
  dob_match?: boolean;
}> {
  if (isKycMockModeEnabled()) {
    return {
      status: 'valid',
      message: 'Mock PAN verification successful',
      name_match: true,
      dob_match: true,
    };
  }

  const { baseUrl, apiKey } = resolveSandboxConfig();

  const accessToken = await getSandboxAccessToken();

  const body = {
    '@entity': 'in.co.sandbox.kyc.pan_verification.request',
    pan: params.pan,
    name_as_per_pan: params.nameAsPerPan,
    date_of_birth: params.dateOfBirth,
    consent: params.consent,
    reason: params.reason,
  };

  const resp = await fetch(`${baseUrl}/kyc/pan/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: accessToken,
      'x-api-key': apiKey,
      'x-api-version': '1.0.0',
    },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as any;
  if (!resp.ok || !data?.data) {
    throw new Error(extractSandboxError(resp.status, data, 'Failed to verify PAN'));
  }

  const status: 'valid' | 'invalid' =
    String(data.data.status).toLowerCase() === 'valid' ? 'valid' : 'invalid';

  return {
    status,
    message: data.data.remarks ?? data.data.message ?? '',
    name_match: data.data.name_as_per_pan_match,
    dob_match: data.data.date_of_birth_match,
  };
}

type VerifyBankPennyLessParams = {
  ifscCode: string;
  accountNumber: string;
  name?: string;
  mobile?: string;
};

export async function sandboxVerifyBankPennyLess(params: VerifyBankPennyLessParams): Promise<{
  account_exists: boolean;
  name_at_bank?: string;
  message?: string;
  transaction_id?: string;
}> {
  if (isKycMockModeEnabled()) {
    return {
      account_exists: true,
      name_at_bank: params.name || 'Mock Bank User',
      message: 'Mock bank account verified successfully',
      transaction_id: `MOCK-BANK-${Date.now()}`,
    };
  }

  const { baseUrl, apiKey } = resolveSandboxConfig();
  const accessToken = await getSandboxAccessToken();

  const ifsc = params.ifscCode.trim().toUpperCase();
  const accountNumber = params.accountNumber.trim();

  const searchParams = new URLSearchParams();
  if (params.name?.trim()) {
    searchParams.set('name', params.name.trim());
  }
  if (params.mobile?.trim()) {
    searchParams.set('mobile', params.mobile.trim());
  }

  const query = searchParams.toString();
  const endpoint = `${baseUrl}/bank/${encodeURIComponent(ifsc)}/accounts/${encodeURIComponent(accountNumber)}/penniless-verify${query ? `?${query}` : ''}`;

  const resp = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: accessToken,
      'x-api-key': apiKey,
      'x-api-version': '1.0.0',
    },
  });

  const data = (await resp.json()) as any;
  if (!resp.ok || !data?.data) {
    throw new Error(extractSandboxError(resp.status, data, 'Failed to verify bank account'));
  }

  const accountExists =
    typeof data.data.account_exists === 'boolean'
      ? data.data.account_exists
      : typeof data.data.account_exist === 'boolean'
        ? data.data.account_exist
        : false;

  return {
    account_exists: accountExists,
    name_at_bank: data.data.name_at_bank,
    message: data.data.message,
    transaction_id: data.transaction_id,
  };
}
