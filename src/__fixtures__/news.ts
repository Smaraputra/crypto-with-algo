/**
 * RSS fixtures shaped after the real publisher feeds (CoinDesk, Cointelegraph,
 * Decrypt, The Block): CDATA-wrapped links and descriptions, HTML inside the
 * summary, repeated <category> elements, RFC 822 dates.
 */
export const cointelegraphRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Cointelegraph.com News</title>
    <item>
      <title>Bitcoin ETF inflows surge past record high</title>
      <pubDate>Wed, 09 Sep 2026 21:30:00 +0000</pubDate>
      <guid isPermaLink="true">https://cointelegraph.com/news/btc-etf-inflows</guid>
      <link><![CDATA[https://cointelegraph.com/news/btc-etf-inflows?utm_source=rss_feed]]></link>
      <description><![CDATA[<p style="float:right"><img src="https://example.com/a.jpg" alt="cover"></p><p>Institutional demand for Bitcoin&nbsp;continued to climb.</p>]]></description>
      <dc:creator>Cointelegraph by Nate Kostar</dc:creator>
      <category>Latest News</category>
      <category>Bitcoin</category>
    </item>
    <item>
      <title>Ethereum upgrade ships on mainnet</title>
      <pubDate>Wed, 09 Sep 2026 18:47:32 +0000</pubDate>
      <guid isPermaLink="true">https://cointelegraph.com/news/eth-upgrade</guid>
      <link><![CDATA[https://cointelegraph.com/news/eth-upgrade]]></link>
      <description><![CDATA[<p>The Ether network completed its scheduled upgrade.</p>]]></description>
      <category>Latest News</category>
    </item>
    <item>
      <title>Regulators open investigation into an exchange hack</title>
      <pubDate>Wed, 09 Sep 2026 12:00:00 +0000</pubDate>
      <link>https://cointelegraph.com/news/exchange-hack</link>
      <description>No coin named here, only market-wide regulation news.</description>
    </item>
  </channel>
</rss>`;

/** Same lead story as the Cointelegraph feed, to exercise cross-feed dedupe. */
export const decryptRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Decrypt</title>
    <item>
      <title>Solana partnership drives a rally</title>
      <pubDate>Wed, 09 Sep 2026 20:00:00 +0000</pubDate>
      <link>https://decrypt.co/sol-rally</link>
      <description>SOL gained after a new partnership was announced.</description>
    </item>
    <item>
      <title>Bitcoin ETF inflows surge past record high</title>
      <pubDate>Wed, 09 Sep 2026 21:35:00 +0000</pubDate>
      <link><![CDATA[https://cointelegraph.com/news/btc-etf-inflows?utm_source=rss_feed]]></link>
      <description>Syndicated copy of the same story.</description>
    </item>
  </channel>
</rss>`;

/** A feed carrying exactly one item, which RSS emits as an object not an array. */
export const singleItemRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>CoinDesk</title>
    <item>
      <title>Cardano adoption grows among institutions</title>
      <pubDate>Tue, 08 Sep 2026 09:15:00 +0000</pubDate>
      <link>https://coindesk.com/ada-adoption</link>
      <description>ADA saw institutional adoption.</description>
    </item>
  </channel>
</rss>`;

export const emptyChannelRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Quiet</title></channel></rss>`;
