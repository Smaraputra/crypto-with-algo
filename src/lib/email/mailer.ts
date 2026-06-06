import nodemailer, { type Transporter } from 'nodemailer';

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (transport) return transport;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error('SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS).');
  }

  transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return transport;
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const from = process.env.MAIL_FROM || 'CryptoWithAlgo <noreply@cryptowithalgo.com>';
  await getTransport().sendMail({ from, ...args });
}

// Test-only: clears the cached transport so env changes take effect.
export function __resetTransportForTests(): void {
  transport = null;
}
