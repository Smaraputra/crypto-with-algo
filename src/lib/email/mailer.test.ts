import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMail, createTransport } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail }));
  return { sendMail, createTransport };
});
vi.mock('nodemailer', () => ({ default: { createTransport } }));

import { sendEmail, __resetTransportForTests } from './mailer';

beforeEach(() => {
  vi.clearAllMocks();
  __resetTransportForTests();
  vi.stubEnv('SMTP_HOST', 'smtp.test');
  vi.stubEnv('SMTP_PORT', '587');
  vi.stubEnv('SMTP_USER', 'user');
  vi.stubEnv('SMTP_PASS', 'pass');
  vi.stubEnv('MAIL_FROM', 'CryptoWithAlgo <noreply@cryptowithalgo.com>');
});

describe('sendEmail', () => {
  it('sends with the configured from address and content', async () => {
    await sendEmail({ to: 'a@b.com', subject: 'S', html: '<p>H</p>', text: 'T' });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'CryptoWithAlgo <noreply@cryptowithalgo.com>',
      to: 'a@b.com',
      subject: 'S',
      html: '<p>H</p>',
      text: 'T',
    });
  });

  it('caches the transport across calls', async () => {
    await sendEmail({ to: 'a@b.com', subject: 'S', html: 'h', text: 't' });
    await sendEmail({ to: 'c@d.com', subject: 'S2', html: 'h', text: 't' });
    expect(createTransport).toHaveBeenCalledTimes(1);
  });

  it('throws when SMTP is not configured', async () => {
    vi.stubEnv('SMTP_HOST', '');
    __resetTransportForTests();
    await expect(
      sendEmail({ to: 'a@b.com', subject: 'S', html: 'h', text: 't' })
    ).rejects.toThrow(/SMTP/i);
  });
});
