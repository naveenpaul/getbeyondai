import { z } from 'zod';

export const InviteRoleSchema = z.union([
  z.literal('member'),
  z.literal('admin'),
]);
export type InviteRole = z.infer<typeof InviteRoleSchema>;

/**
 * POST /org/invites — owner/admin invites someone to their org.
 * Only 'member' or 'admin' are valid roles to invite as; owners can't
 * be invited (ownership transfer is a future, separate flow).
 */
export const CreateInviteSchema = z.object({
  email: z.string().email(),
  role: InviteRoleSchema.default('member'),
});
export type CreateInviteInput = z.infer<typeof CreateInviteSchema>;

export interface InviteSummary {
  id: string;
  email: string;
  role: InviteRole | 'owner';
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
  invitedByEmail: string;
}

export interface MemberSummary {
  userId: string;
  email: string;
  name: string | null;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}

/**
 * GET /invite/:token/lookup — public; the token IS the bearer secret. Anyone
 * with the token sees what they'd be accepting. No PII leak beyond the org
 * name + the invited email (which the holder of the token presumably already
 * has, since they were emailed it).
 */
export interface InviteLookupResponse {
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  orgName: string | null;
  role: InviteRole | 'owner';
  invitedEmail: string;
  expiresAt: string;
}
