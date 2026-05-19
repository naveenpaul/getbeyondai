import type { Metadata } from 'next';
import Link from 'next/link';
import { UserMenu } from '@/components/UserMenu';
import './globals.css';

export const metadata: Metadata = {
  title: 'getbeyond — Open-source AI GTM teammates',
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
        <header className="border-b border-border/60">
          <div className="container flex h-12 items-center justify-between">
            <Link
              href="/"
              className="text-sm font-semibold tracking-tight"
            >
              getbeyond
            </Link>
            <UserMenu />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
