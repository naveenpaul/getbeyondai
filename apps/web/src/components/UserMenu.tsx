'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { signOut } from '@/lib/auth-client';
import { useIdentity } from '@/lib/use-identity';

/**
 * Top-right "signed in as X · Sign out" strip (T6.4).
 *
 * Renders nothing while the session is loading, and nothing on the public
 * landing/login pages either (parent controls visibility). When signed in,
 * shows email + a sign-out button that clears the session and lands on /.
 */
export function UserMenu(): React.JSX.Element | null {
  const router = useRouter();
  const { identity, status } = useIdentity();

  if (status === 'loading' || status === 'signed_out') return null;

  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="text-muted-foreground">{identity?.email ?? ''}</span>
      <Button asChild size="sm" variant="ghost">
        <Link href="/settings/team">
          <Users className="h-3.5 w-3.5" />
          Team
        </Link>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={async () => {
          await signOut();
          router.replace('/');
        }}
      >
        <LogOut className="h-3.5 w-3.5" />
        Sign out
      </Button>
    </div>
  );
}
