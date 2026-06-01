'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  ApiError,
  createInvite,
  type InviteRole,
  type InviteSummary,
  listInvites,
  listMembers,
  type MemberSummary,
  revokeInvite,
} from '@/lib/api-client';
import { useIdentity } from '@/lib/use-identity';

/**
 * Settings → Team. Lists current members, lets owners/admins invite, and
 * lets them revoke pending invites.
 *
 * Role gating is enforced server-side; this UI hides destructive controls
 * from members but a member who bypasses the UI just gets a 403 back.
 */
export default function TeamSettingsPage(): React.JSX.Element {
  const { identity } = useIdentity();
  const [members, setMembers] = useState<MemberSummary[] | null>(null);
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([listMembers(), listInvites()]);
      setMembers(m);
      setInvites(i);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Find the current user's role in the active org by looking themselves up
  // in the members list. Cleaner than a parallel /me round-trip.
  const myRole = useMemo<'owner' | 'admin' | 'member' | null>(() => {
    if (!members || !identity) return null;
    return members.find((m) => m.userId === identity.userId)?.role ?? null;
  }, [members, identity]);

  const canManage = myRole === 'owner' || myRole === 'admin';
  const canInviteAdmin = myRole === 'owner';

  return (
    <div className="space-y-6">
      {error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          {members === null ? (
            <SkeletonRow />
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <ul className="divide-y">
              {members.map((m) => (
                <li
                  key={m.userId}
                  className="flex items-center justify-between py-3"
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">
                      {m.name ?? m.email}
                    </span>
                    {m.name ? (
                      <span className="text-xs text-muted-foreground">
                        {m.email}
                      </span>
                    ) : null}
                  </div>
                  <RoleBadge role={m.role} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <InviteForm
          canInviteAdmin={canInviteAdmin}
          onCreated={() => void refresh()}
          onError={setError}
        />
      ) : null}

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invites</CardTitle>
          </CardHeader>
          <CardContent>
            {invites === null ? (
              <SkeletonRow />
            ) : invites.filter((i) => i.status === 'pending').length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No outstanding invites.
              </p>
            ) : (
              <ul className="divide-y">
                {invites
                  .filter((i) => i.status === 'pending')
                  .map((i) => (
                    <PendingInviteRow
                      key={i.id}
                      invite={i}
                      onRevoked={() => void refresh()}
                      onError={setError}
                    />
                  ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function InviteForm({
  canInviteAdmin,
  onCreated,
  onError,
}: {
  canInviteAdmin: boolean;
  onCreated: () => void;
  onError: (msg: string) => void;
}): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<InviteRole>('member');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      await createInvite({ email: email.trim(), role });
      setEmail('');
      setRole('member');
      onCreated();
    } catch (err) {
      onError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a teammate</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-wrap items-end gap-3" onSubmit={onSubmit}>
          <div className="flex-1 space-y-1">
            <label htmlFor="invite-email" className="text-xs font-medium">
              Email
            </label>
            <Input
              id="invite-email"
              type="email"
              required
              placeholder="teammate@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="invite-role" className="text-xs font-medium">
              Role
            </label>
            <select
              id="invite-role"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as InviteRole)}
              disabled={submitting}
            >
              <option value="member">Member</option>
              {canInviteAdmin ? <option value="admin">Admin</option> : null}
            </select>
          </div>
          <Button type="submit" disabled={submitting || !email.trim()}>
            {submitting ? (
              <>
                <Loader2 className="animate-spin" /> Sending…
              </>
            ) : (
              <>Send invite</>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function PendingInviteRow({
  invite,
  onRevoked,
  onError,
}: {
  invite: InviteSummary;
  onRevoked: () => void;
  onError: (msg: string) => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  async function onRevoke(): Promise<void> {
    setBusy(true);
    try {
      await revokeInvite(invite.id);
      onRevoked();
    } catch (err) {
      onError(formatError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className="flex items-center justify-between py-3">
      <div className="flex flex-col">
        <span className="text-sm font-medium">{invite.email}</span>
        <span className="text-xs text-muted-foreground">
          Invited by {invite.invitedByEmail} ·{' '}
          {new Date(invite.expiresAt).toLocaleDateString()}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <RoleBadge role={invite.role} />
        <Button
          size="sm"
          variant="ghost"
          onClick={onRevoke}
          disabled={busy}
          aria-label="Revoke invite"
        >
          <X className="h-3.5 w-3.5" />
          Revoke
        </Button>
      </div>
    </li>
  );
}

function RoleBadge({
  role,
}: {
  role: 'owner' | 'admin' | 'member';
}): React.JSX.Element {
  const styles: Record<string, string> = {
    owner: 'bg-primary/10 text-primary',
    admin: 'bg-blue-500/10 text-blue-600',
    member: 'bg-muted text-muted-foreground',
  };
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-xs font-medium ${styles[role] ?? styles.member}`}
    >
      {role}
    </span>
  );
}

function SkeletonRow(): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-3 text-sm text-muted-foreground">
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Loading…
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.status} — ${err.body.slice(0, 200)}`;
  if (err instanceof Error) return err.message;
  return 'Unknown error';
}
