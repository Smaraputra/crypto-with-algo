import type { Metadata } from 'next';
import { Outfit, JetBrains_Mono } from 'next/font/google';
import { Providers } from './providers';
import { ThemedToaster } from '@/components/theme/ThemedToaster';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

const outfit = Outfit({
  variable: '--font-outfit',
  subsets: ['latin'],
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  variable: '--font-jetbrains-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'CryptoWithAlgo',
  description: 'Real-time cryptocurrency portfolio tracking with live market data, interactive charts, and smart alerts',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} // skipcq: JS-0440 static theme script from src/lib/theme.ts, must run before first paint
        />
      </head>
      <body className={`${outfit.variable} ${jetbrainsMono.variable} antialiased`}>
        <Providers>{children}</Providers>
        <ThemedToaster />
      </body>
    </html>
  );
}
