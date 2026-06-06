import { describe, expect, it } from 'vitest';
import { verificationEmail, passwordResetEmail } from './templates';

describe('verificationEmail', () => {
  it('includes the name and the verify URL in subject, html, and text', () => {
    const { subject, html, text } = verificationEmail({
      name: 'Ada',
      url: 'https://app.test/verify-email?token=abc',
    });
    expect(subject).toMatch(/verify/i);
    expect(html).toContain('https://app.test/verify-email?token=abc');
    expect(html).toContain('Ada');
    expect(text).toContain('https://app.test/verify-email?token=abc');
  });
});

describe('passwordResetEmail', () => {
  it('includes the reset URL in html and text', () => {
    const { subject, html, text } = passwordResetEmail({
      name: 'Ada',
      url: 'https://app.test/reset-password?token=xyz',
    });
    expect(subject).toMatch(/reset/i);
    expect(html).toContain('https://app.test/reset-password?token=xyz');
    expect(text).toContain('https://app.test/reset-password?token=xyz');
  });
});
