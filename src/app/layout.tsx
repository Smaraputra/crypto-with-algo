import type { Metadata } from 'next';
import { Outfit } from 'next/font/google';
import { Providers } from './providers';
import { ThemedToaster } from '@/components/theme/ThemedToaster';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

const outfit = Outfit({
  variable: '--font-outfit',
  subsets: ['latin'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'CryptoWithAlgo',
  description:
    'A crypto market tracker with an open research lab: live prices, coin study with trading costs, and an open record of trading ideas tested on live data.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={outfit.variable} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} // skipcq: JS-0440 static theme script from src/lib/theme.ts, must run before first paint
        />
      </head>
      <body className="font-sans antialiased">
        <Providers>{children}</Providers>
        <ThemedToaster />
      </body>
    </html>
  );
}
