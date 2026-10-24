import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrivacyContent, PRIVACY_LAST_UPDATED } from './PrivacyContent';
import { TermsContent, TERMS_LAST_UPDATED } from './TermsContent';

describe('PrivacyContent', () => {
  const privacyHeadings = [
    '1. Introduction',
    '2. Information We Collect',
    '2.1 Account Information',
    '2.2 Portfolio and Trading Data',
    '2.3 Usage Data',
    '2.4 Cookies and Tracking',
    '3. How We Use Your Information',
    '4. Data Storage and Security',
    '4.1 Storage Infrastructure',
    '4.2 Security Measures',
    '4.3 Data Retention',
    '5. Data Sharing and Third Parties',
    '5.1 Third-Party Services',
    '5.2 Data We Do NOT Sell or Share',
    '5.3 Legal Disclosures',
    '6. Your Privacy Rights',
    '6.1 Access and Control',
    '6.2 GDPR Rights (EU Users)',
    '6.3 CCPA Rights (California Users)',
    '6.4 Exercising Your Rights',
    "7. Children's Privacy",
    '8. International Data Transfers',
    '9. Data Breach Notification',
    '10. Changes to This Privacy Policy',
    '11. Do Not Track Signals',
    '12. Contact Us',
  ];

  it('exports the exact last updated date', () => {
    expect(PRIVACY_LAST_UPDATED).toBe('March 4, 2026');
  });

  it('renders every heading text in order', () => {
    render(<PrivacyContent />);
    const headingElements = screen.getAllByRole('heading');
    const headingTexts = headingElements.map((el) => el.textContent);
    expect(headingTexts).toEqual(privacyHeadings);
  });

  it('renders three distinctive sentences copied exactly from the policy', () => {
    render(<PrivacyContent />);

    expect(
      screen.getByText(
        'CryptoWithAlgo ("we", "us", or "our") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our cryptocurrency portfolio tracking service.'
      )
    ).toBeInTheDocument();

    expect(
      screen.getByText(
        'Important: We do NOT access your exchange accounts. We do NOT store exchange API keys. All portfolio data is manually entered by you.'
      )
    ).toBeInTheDocument();

    expect(
      screen.getByText(
        'We DO NOT sell, rent, or share your personal information or portfolio data with third parties for marketing purposes.'
      )
    ).toBeInTheDocument();
  });

  it('renders markup without any class attribute', () => {
    const { container } = render(<PrivacyContent />);
    expect(container.querySelectorAll('[class]')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/\sclass=["']/);
  });
});

describe('TermsContent', () => {
  const termsHeadings = [
    '1. Acceptance of Terms',
    '2. Description of Service',
    '3. User Accounts',
    '4. User Responsibilities',
    '5. Prohibited Activities',
    '6. Data and Market Information',
    '7. Intellectual Property',
    '8. Disclaimer of Warranties',
    '9. Limitation of Liability',
    '10. Indemnification',
    '11. Account Termination',
    '12. Third-Party Services',
    '13. Changes to Terms',
    '14. Governing Law and Disputes',
    '15. Severability',
    '16. Contact Information',
  ];

  it('exports the exact last updated date', () => {
    expect(TERMS_LAST_UPDATED).toBe('March 4, 2026');
  });

  it('renders every heading text in order', () => {
    render(<TermsContent />);
    const headingElements = screen.getAllByRole('heading');
    const headingTexts = headingElements.map((el) => el.textContent);
    expect(headingTexts).toEqual(termsHeadings);
  });

  it('renders three distinctive sentences copied exactly from the policy', () => {
    render(<TermsContent />);

    expect(
      screen.getByText(
        'By accessing and using CryptoWithAlgo (the "Service"), you accept and agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the Service.'
      )
    ).toBeInTheDocument();

    expect(
      screen.getByText(
        'CryptoWithAlgo is not a financial advisor. Nothing on this Service constitutes financial, investment, trading, or legal advice. You are solely responsible for your investment decisions.'
      )
    ).toBeInTheDocument();

    expect(
      screen.getByText(
        'Our total liability for any claim shall not exceed $100 USD or the amount you paid us in the past 12 months (whichever is greater).'
      )
    ).toBeInTheDocument();
  });

  it('renders markup without any class attribute', () => {
    const { container } = render(<TermsContent />);
    expect(container.querySelectorAll('[class]')).toHaveLength(0);
    expect(container.innerHTML).not.toMatch(/\sclass=["']/);
  });
});
