const MSG91_EMAIL_URL = 'https://control.msg91.com/api/v5/email/send';

type SendMsg91EmailParams = {
  toEmail: string;
  toName?: string;
  templateId: string;
  variables: Record<string, string>;
  fromName?: string;
  fromEmail?: string;
};

export async function sendMsg91Email({
  toEmail,
  toName,
  templateId,
  variables,
  fromName = 'No Reply',
  fromEmail = 'no-reply@hr-suite.shlokasolutions.app',
}: SendMsg91EmailParams) {
  if (!toEmail || !templateId) {
    throw new Error('toEmail and templateId are required');
  }

  const payload = {
    recipients: [
      {
        to: [
          {
            name: toName ?? '',
            email: toEmail,
          },
        ],
        variables,
      },
    ],
    from: {
      name: fromName,
      email: fromEmail,
    },
    domain: 'hr-suite.shlokasolutions.app',
    template_id: templateId,
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(MSG91_EMAIL_URL, {
      method: 'POST',
      headers: {
        authkey: process.env.MSG91_AUTH_KEY as string,
        'Content-Type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const data = await response.json();

    console.log(data, 'asdasdsadsadsadsadsadasdasdasdas');

    if (!response.ok) {
      throw new Error(`MSG91 error: ${JSON.stringify(data)}`);
    }

    return {
      success: true,
      data,
    };
  } catch (error: any) {
    if (error.name === 'AbortError') {
      return {
        success: false,
        error: 'MSG91 request timed out',
      };
    }

    return {
      success: false,
      error: error.message,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
