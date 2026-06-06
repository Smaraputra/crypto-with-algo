export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

interface TemplateArgs {
  name: string;
  url: string;
}

const ACCENT = '#f0b90b';

function layout(heading: string, body: string, cta: { label: string; url: string }): string {
  return `<!doctype html><html><body style="margin:0;background:#0b0e11;font-family:Arial,Helvetica,sans-serif;color:#eaecef;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#161a1e;border-radius:12px;padding:32px">
    <h1 style="font-size:20px;margin:0 0 16px">${heading}</h1>
    <div style="font-size:14px;line-height:1.6;color:#b7bdc6">${body}</div>
    <a href="${cta.url}" style="display:inline-block;margin-top:24px;background:${ACCENT};color:#0b0e11;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${cta.label}</a>
    <p style="font-size:12px;color:#5e6673;margin-top:24px;word-break:break-all">If the button does not work, paste this link into your browser:<br>${cta.url}</p>
  </div></body></html>`;
}

export function verificationEmail({ name, url }: TemplateArgs): EmailContent {
  return {
    subject: 'Verify your email for CryptoWithAlgo',
    html: layout(
      `Welcome, ${name}`,
      'Confirm your email address to activate your CryptoWithAlgo account. This link expires in 24 hours.',
      { label: 'Verify email', url }
    ),
    text: `Welcome, ${name}.\n\nConfirm your email to activate your CryptoWithAlgo account (link expires in 24 hours):\n${url}\n`,
  };
}

export function passwordResetEmail({ name, url }: TemplateArgs): EmailContent {
  return {
    subject: 'Reset your CryptoWithAlgo password',
    html: layout(
      `Hi ${name}`,
      'We received a request to reset your password. This link expires in 1 hour. If you did not request this, you can ignore this email.',
      { label: 'Reset password', url }
    ),
    text: `Hi ${name}.\n\nReset your CryptoWithAlgo password (link expires in 1 hour):\n${url}\n\nIf you did not request this, ignore this email.\n`,
  };
}
