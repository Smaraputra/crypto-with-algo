import { ContentLayout } from '@/components/marketing/ContentLayout';

export default function PrivacyPage() {
  const lastUpdated = 'March 4, 2026';

  return (
    <ContentLayout
      title="Privacy Policy"
      subtitle={`Last updated: ${lastUpdated}`}
    >
      <div className="prose prose-sm max-w-none space-y-6 text-muted-foreground">
        <section>
          <h2 className="text-lg font-semibold text-foreground">1. Introduction</h2>
          <p>
            CryptoWithAlgo (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our cryptocurrency portfolio tracking service.
          </p>
          <p className="mt-2">
            By using CryptoWithAlgo, you agree to the collection and use of information in accordance with this Privacy Policy.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">2. Information We Collect</h2>

          <h3 className="text-base font-semibold text-foreground mt-4">2.1 Account Information</h3>
          <p>When you create an account, we collect:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Email address (for email/password registration)</li>
            <li>Password (encrypted and hashed)</li>
            <li>Name and profile information (from OAuth providers like Google or GitHub)</li>
            <li>OAuth provider ID and access tokens (stored securely)</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">2.2 Portfolio and Trading Data</h3>
          <p>You manually provide:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Cryptocurrency holdings (symbols, quantities, purchase prices, dates)</li>
            <li>Portfolio names and configurations</li>
            <li>Watchlist symbols</li>
            <li>Alert thresholds and preferences</li>
            <li>Trading journal entries (trades, strategies, notes, sentiment)</li>
            <li>Backtest configurations and results</li>
            <li>Research notes and market analysis</li>
          </ul>
          <p className="mt-2 font-semibold">
            Important: We do NOT access your exchange accounts. We do NOT store exchange API keys. All portfolio data is manually entered by you.
          </p>

          <h3 className="text-base font-semibold text-foreground mt-4">2.3 Usage Data</h3>
          <p>We automatically collect:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>IP address and browser information</li>
            <li>Pages visited and features used</li>
            <li>Session duration and timestamps</li>
            <li>Device type and operating system</li>
            <li>Referral sources</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">2.4 Cookies and Tracking</h3>
          <p>We use cookies for:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Session management (authentication state)</li>
          </ul>
          <p className="mt-2">
            User preferences (theme, chart settings) are stored locally in your browser using localStorage and are never transmitted to our servers.
          </p>
          <p className="mt-2">
            You can control cookies through your browser settings, but disabling them may affect Service functionality.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">3. How We Use Your Information</h2>
          <p>We use collected information to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Provide and maintain the Service</li>
            <li>Authenticate your identity and manage your account</li>
            <li>Calculate portfolio performance and analytics</li>
            <li>Deliver in-app price alerts and notifications you configured</li>
            <li>Generate trading signals and backtest results</li>
            <li>Improve Service features and user experience</li>
            <li>Detect and prevent security threats or abuse</li>
            <li>Communicate updates, changes, or important notices</li>
            <li>Comply with legal obligations</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">4. Data Storage and Security</h2>

          <h3 className="text-base font-semibold text-foreground mt-4">4.1 Storage Infrastructure</h3>
          <p>Your data is stored using:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>MongoDB</strong>: Portfolio data, user accounts, journal entries, alerts</li>
            <li><strong>Redis</strong>: Temporary cache for market data</li>
            <li><strong>Self-hosted server</strong>: Application and database hosting on a dedicated VPS</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">4.2 Security Measures</h3>
          <p>We implement security practices including:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Password hashing with bcrypt</li>
            <li>HTTPS/TLS encryption for all data transmission</li>
            <li>Secure session management with httpOnly cookies</li>
            <li>Regular security audits and dependency updates</li>
            <li>Rate limiting to prevent abuse</li>
            <li>Input validation and sanitization</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">4.3 Data Retention</h3>
          <p>We retain your data:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Account data: Until you request account deletion</li>
            <li>Portfolio data: Until you delete it or close your account</li>
            <li>Session data: 7 days after issuance</li>
            <li>Analytics data: Aggregated and anonymized indefinitely</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">5. Data Sharing and Third Parties</h2>

          <h3 className="text-base font-semibold text-foreground mt-4">5.1 Third-Party Services</h3>
          <p>We integrate with the following services:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Binance API</strong>: Market data retrieval (no account access, public data only)</li>
            <li><strong>Google OAuth</strong>: Optional authentication (subject to Google Privacy Policy)</li>
            <li><strong>GitHub OAuth</strong>: Optional authentication (subject to GitHub Privacy Policy)</li>
            <li><strong>CryptoPanic</strong>: Cryptocurrency news data (subject to CryptoPanic Terms of Service)</li>
            <li><strong>Alternative.me</strong>: Fear &amp; Greed Index data (subject to Alternative.me Terms of Service)</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">5.2 Data We Do NOT Sell or Share</h3>
          <p className="font-semibold">
            We DO NOT sell, rent, or share your personal information or portfolio data with third parties for marketing purposes.
          </p>

          <h3 className="text-base font-semibold text-foreground mt-4">5.3 Legal Disclosures</h3>
          <p>We may disclose your information if required to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Comply with legal obligations (court orders, subpoenas)</li>
            <li>Protect our rights, property, or safety</li>
            <li>Prevent fraud or illegal activity</li>
            <li>Respond to emergencies involving personal safety</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">6. Your Privacy Rights</h2>

          <h3 className="text-base font-semibold text-foreground mt-4">6.1 Access and Control</h3>
          <p>You have the right to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li><strong>Access</strong>: View all your personal data through the Service</li>
            <li><strong>Update</strong>: Modify your account information and portfolio data</li>
            <li><strong>Delete</strong>: Remove portfolio holdings and journal entries, or request full account deletion by contacting us</li>
            <li><strong>Export</strong>: Download your data in CSV format</li>
            <li><strong>Opt-out</strong>: Disable alerts and notifications at any time</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">6.2 GDPR Rights (EU Users)</h3>
          <p>If you are in the EU, you have additional rights:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Right to data portability</li>
            <li>Right to rectification</li>
            <li>Right to erasure (&quot;right to be forgotten&quot;)</li>
            <li>Right to restrict processing</li>
            <li>Right to object to processing</li>
            <li>Right to lodge a complaint with a supervisory authority</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">6.3 CCPA Rights (California Users)</h3>
          <p>California residents have the right to:</p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Know what personal information we collect and how it&#39;s used</li>
            <li>Request deletion of personal information</li>
            <li>Opt-out of the sale of personal information (we do not sell data)</li>
            <li>Non-discrimination for exercising privacy rights</li>
          </ul>

          <h3 className="text-base font-semibold text-foreground mt-4">6.4 Exercising Your Rights</h3>
          <p>To exercise your privacy rights, contact us at:</p>
          <p className="mt-2">
            Email: smara.putra2001@gmail.com<br />
            To request account deletion, send an email from your registered address.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">7. Children&#39;s Privacy</h2>
          <p>
            CryptoWithAlgo is not intended for users under 18 years of age. We do not knowingly collect personal information from children. If we discover that a child has provided us with personal information, we will delete it immediately.
          </p>
          <p className="mt-2">
            If you believe a child has provided us with personal information, please contact us at smara.putra2001@gmail.com.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">8. International Data Transfers</h2>
          <p>
            Your data may be transferred to and processed in countries other than your own. Our servers are located in Germany. Third-party APIs (Binance, CryptoPanic, Alternative.me) may process requests in other jurisdictions.
          </p>
          <p className="mt-2">
            By using CryptoWithAlgo, you consent to the transfer of your information to these jurisdictions.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">9. Data Breach Notification</h2>
          <p>
            In the event of a data breach that compromises your personal information, we will:
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>Notify affected users within 72 hours via email and in-app notification</li>
            <li>Report to relevant authorities as required by law</li>
            <li>Take immediate steps to secure systems and prevent further breaches</li>
            <li>Provide guidance on protective measures you can take</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">10. Changes to This Privacy Policy</h2>
          <p>
            We may update this Privacy Policy from time to time to reflect changes in our practices or legal requirements. Changes will be posted on this page with an updated &quot;Last Updated&quot; date.
          </p>
          <p className="mt-2">
            We will notify you of material changes via prominent notice in the Service, such as a banner notification on login.
          </p>
          <p className="mt-2">
            Continued use of the Service after changes constitutes acceptance of the updated Privacy Policy.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">11. Do Not Track Signals</h2>
          <p>
            Some browsers support &quot;Do Not Track&quot; (DNT) signals. Currently, there is no industry standard for responding to DNT signals. CryptoWithAlgo does not respond to DNT browser settings at this time.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-foreground">12. Contact Us</h2>
          <p>
            If you have questions, concerns, or requests regarding this Privacy Policy or your personal data, please contact us:
          </p>
          <p className="mt-2">
            <strong>Privacy Officer</strong><br />
            Email: smara.putra2001@gmail.com
          </p>
          <p className="mt-2">
            We will respond to all requests within 30 days.
          </p>
        </section>

        <section className="border-t border-border pt-6 mt-8">
          <p className="text-xs text-muted-foreground italic">
            This Privacy Policy is effective as of {lastUpdated} and applies to all users of CryptoWithAlgo.
          </p>
        </section>
      </div>
    </ContentLayout>
  );
}
