/**
 * Transactional email helper.
 *
 * FreeBuff's platform mailer (the same service the email one-time-code sign-in
 * provider uses) accepts a short numeric code and delivers it to the recipient.
 * The Secret Chats PIN reset reuses it so there is one mail path, one key and no
 * extra configuration.
 *
 * Codes are generated and hashed by the caller; this module only delivers them
 * and never stores, logs or returns them.
 */
const MAIL_ENDPOINT = "https://auth.freebuff.app/send_otp";
const MAIL_API_KEY = "fb_email_2crN1hqIArZP2bEfvjp5Qik4";

export async function sendCodeEmail({
  to,
  code,
  subject,
}: {
  to: string;
  code: string;
  subject?: string;
}): Promise<void> {
  const appName = process.env.VLY_APP_NAME || "FreeBuff";
  const response = await fetch(MAIL_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": MAIL_API_KEY,
    },
    body: JSON.stringify({
      to,
      otp: code,
      appName: subject ? `${appName} — ${subject}` : appName,
    }),
  });
  if (!response.ok) {
    throw new Error(`Mail delivery failed (${response.status}).`);
  }
}
