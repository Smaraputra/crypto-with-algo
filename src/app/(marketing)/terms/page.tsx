import { ContentLayout } from '@/components/marketing/ContentLayout';

export default function TermsPage() {
  const lastUpdated = 'March 4, 2026';

  return (
    <ContentLayout
      title="Terms of Service"
      subtitle={`Last updated: ${lastUpdated}`}
    >
      <div className="prose prose-sm max-w-none space-y-6 text-muted-foreground">
        <section>
          <h2 className="text-lg font-semibold text-foreground">1. Acceptance of Terms</h2>
          <p>
            By accessing and using CryptoWithAlgo (the &quot;Service&quot;), you accept and agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the Service.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">2. Description of Service</h2>
          <p>
            CryptoWithAlgo is a cryptocurrency portfolio tracking and analytics platform that provides:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Real-time cryptocurrency price data from Binance</li>
            <li>Portfolio management and performance tracking</li>
            <li>Technical analysis charts and indicators</li>
            <li>Price alerts and notifications</li>
            <li>Trading signals and backtesting tools</li>
            <li>Trading journal and analytics</li>
          </ul>
          <p className="mt-2">
            The Service is provided free of charge for personal, non-commercial use.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">3. User Accounts</h2>
          <p>
            You must be at least 18 years old to use the Service. By creating an account, you represent that you meet this requirement.
          </p>
          <p className="mt-2">
            To use certain features, you must create an account using email/password or OAuth providers (Google, GitHub). You are responsible for:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Maintaining the confidentiality of your account credentials</li>
            <li>All activities that occur under your account</li>
            <li>Notifying us immediately of any unauthorized access</li>
            <li>Providing accurate and current registration information</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">4. User Responsibilities</h2>
          <p>You agree to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Use the Service in compliance with all applicable laws and regulations</li>
            <li>Not use the Service for any illegal or unauthorized purpose</li>
            <li>Manually enter accurate portfolio information (we do not access exchange accounts)</li>
            <li>Verify all data and make independent investment decisions</li>
            <li>Not rely solely on our alerts or signals for trading decisions</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">5. Prohibited Activities</h2>
          <p>You must not:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Attempt to gain unauthorized access to our systems or other user accounts</li>
            <li>Use automated tools to scrape, spider, or harvest data from the Service</li>
            <li>Interfere with or disrupt the Service or servers</li>
            <li>Transmit viruses, malware, or other harmful code</li>
            <li>Impersonate any person or entity</li>
            <li>Use the Service to manipulate cryptocurrency markets</li>
            <li>Resell, redistribute, or commercialize access to the Service</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">6. Data and Market Information</h2>
          <p>
            Market data is provided by Binance API and other third-party sources. We do not guarantee:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Accuracy, completeness, or timeliness of market data</li>
            <li>Availability or uninterrupted access to data feeds</li>
            <li>Correctness of technical indicators or trading signals</li>
            <li>Performance of backtested strategies in live markets</li>
          </ul>
          <p className="mt-2">
            Backtested strategies reflect historical performance only. Past performance does not guarantee future results. Trading signals are informational and should not be the sole basis for trading decisions.
          </p>
          <p className="mt-2">
            You acknowledge that cryptocurrency markets are highly volatile and trading involves significant risk.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">7. Intellectual Property</h2>
          <p>
            The Service, including its design, features, code, and content, is owned by CryptoWithAlgo and protected by intellectual property laws. You may not:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Copy, modify, or create derivative works of the Service</li>
            <li>Reverse engineer or decompile any part of the Service</li>
            <li>Remove or alter any copyright, trademark, or proprietary notices</li>
          </ul>
          <p className="mt-2">
            Your portfolio data, journal entries, and user-generated content remain your property.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">8. Disclaimer of Warranties</h2>
          <p className="font-semibold uppercase">
            The Service is provided &quot;as is&quot; and &quot;as available&quot; without warranties of any kind, either express or implied.
          </p>
          <p className="mt-2">
            We disclaim all warranties, including but not limited to:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Merchantability and fitness for a particular purpose</li>
            <li>Non-infringement of third-party rights</li>
            <li>Accuracy or reliability of market data</li>
            <li>Uninterrupted or error-free operation</li>
            <li>Security of data transmission or storage</li>
          </ul>
          <p className="mt-2 font-semibold">
            CryptoWithAlgo is not a financial advisor. Nothing on this Service constitutes financial, investment, trading, or legal advice. You are solely responsible for your investment decisions.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">9. Limitation of Liability</h2>
          <p className="font-semibold uppercase">
            To the maximum extent permitted by law, CryptoWithAlgo shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Loss of profits, revenue, or trading opportunities</li>
            <li>Loss of data or portfolio information</li>
            <li>Business interruption or system failures</li>
            <li>Errors in alerts, signals, or market data</li>
            <li>Unauthorized access to your account</li>
          </ul>
          <p className="mt-2">
            Our total liability for any claim shall not exceed $100 USD or the amount you paid us in the past 12 months (whichever is greater).
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">10. Indemnification</h2>
          <p>
            You agree to indemnify and hold harmless CryptoWithAlgo, its officers, directors, employees, and agents from any claims, damages, losses, liabilities, and expenses (including legal fees) arising from:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Your use of the Service</li>
            <li>Your violation of these Terms</li>
            <li>Your violation of any rights of another party</li>
            <li>Your trading decisions based on Service data</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">11. Account Termination</h2>
          <p>
            We reserve the right to suspend or terminate your account at any time for:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Violation of these Terms</li>
            <li>Fraudulent or illegal activity</li>
            <li>Abuse of Service resources</li>
            <li>Extended periods of inactivity</li>
          </ul>
          <p className="mt-2">
            You may request account deletion at any time by contacting us at smara.putra2001@gmail.com. Upon termination, your data will be deleted in accordance with our Privacy Policy.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">12. Third-Party Services</h2>
          <p>
            The Service integrates with third-party providers:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Binance API for market data</li>
            <li>Google and GitHub for OAuth authentication</li>
            <li>MongoDB Atlas for data storage</li>
            <li>Upstash Redis for caching</li>
          </ul>
          <p className="mt-2">
            We are not responsible for the availability, accuracy, or privacy practices of third-party services. Your use of OAuth providers is subject to their respective terms.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">13. Changes to Terms</h2>
          <p>
            We reserve the right to modify these Terms at any time. Changes will be effective immediately upon posting. Your continued use of the Service after changes constitutes acceptance of the new Terms. Material changes will be communicated via email or Service notification.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">14. Governing Law and Disputes</h2>
          <p>
            These Terms are governed by the laws of your jurisdiction of residence. For users in Indonesia, disputes shall be resolved through binding arbitration in Indonesia, except where prohibited by law. For users outside Indonesia, disputes shall be resolved in the courts of the user&apos;s jurisdiction of residence.
          </p>
          <p className="mt-2">
            To the extent permitted by applicable law, you agree to waive any right to a jury trial or to participate in a class action lawsuit. In jurisdictions where mandatory arbitration or class action waivers are not enforceable, disputes shall be resolved in the courts of the user&apos;s jurisdiction.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">15. Severability</h2>
          <p>
            If any provision of these Terms is found to be unenforceable, the remaining provisions will continue in full force and effect.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">16. Contact Information</h2>
          <p>
            For questions about these Terms, please contact us at:
          </p>
          <p className="mt-2">
            Email: smara.putra2001@gmail.com
          </p>
        </section>

        <section className="border-t border-border pt-6 mt-8">
          <p className="text-xs text-muted-foreground italic">
            By using CryptoWithAlgo, you acknowledge that you have read, understood, and agree to be bound by these Terms of Service.
          </p>
        </section>
      </div>
    </ContentLayout>
  );
}
