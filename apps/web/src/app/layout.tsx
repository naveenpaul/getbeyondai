import type { Metadata } from 'next';
import { AppNav } from '@/components/AppNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'getbeyond ai — Open-source AI GTM teammates',
  description:
    'Audit every prompt, every claim, every source. Open source under AGPL-3.0.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        <AppNav />
        {children}
      </body>
    </html>
  );
}
