import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Invite } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type {
  CreateInviteInput,
  InviteLookupResponse,
  InviteRole,
  InviteSummary,
  MemberSummary,
} from './invites.dto';

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_BYTES = 32;

/**
 * Web base URL where the user lands to accept. Same pattern as the
 * magic-link delivery hook: dev hard-codes to localhost, prod must set it.
 */
function inviteAcceptUrl(token: string): string {
  const base =
    process.env.WEB_BASE_URL ??
    (process.env.NODE_ENV === 'production'
      ? throwLoud('WEB_BASE_URL must be set in production')
      : 'http://localhost:3001');
  return `${base.replace(/\/$/, '')}/invite/${token}`;
}

function throwLoud(message: string): never {
  throw new Error(message);
}

/**
 * Send the invite email. Dev = stdout; prod = Resend (later). Same shape as
 * sendMagicLink in auth.config.ts so the wiring is identical when Resend
 * lands. Throws loudly in non-dev environments until a real transport is
 * wired — silent breakage is impossible.
 */
async function deliverInviteEmail(args: {
  email: string;
  url: string;
  orgName: string | null;
  inviterEmail: string;
  role: string;
}): Promise<void> {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    if (process.env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.log(
        `\n[invites] Invite for ${args.email}:\n` +
          `  to join ${args.orgName ?? '(unnamed org)'} as ${args.role}\n` +
          `  from ${args.inviterEmail}\n` +
          `  ${args.url}\n`,
      );
    }
    return;
  }
  throw new Error(
    'Invite email delivery is not configured for non-development environments. ' +
      'Wire Resend (RESEND_API_KEY) before inviting users.',
  );
}

@Injectable()
export class InvitesService {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  /**
   * Create or refresh an invite. Re-inviting the same address upserts: a
   * still-pending row gets a fresh token + expiry; a revoked row is
   * replaced; an already-accepted row 409s (use /org/members to confirm).
   */
  async createInvite(args: {
    orgId: string;
    actorUserId: string;
    actorRole: 'owner' | 'admin' | 'member';
    input: CreateInviteInput;
  }): Promise<InviteSummary> {
    const { orgId, actorUserId, actorRole, input } = args;
    if (actorRole === 'member') {
      throw new ForbiddenException('Only owners and admins can send invites');
    }
    if (input.role === 'admin' && actorRole !== 'owner') {
      throw new ForbiddenException('Only owners can invite admins');
    }

    // Don't invite someone who's already a member of this org.
    const existingUser = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: {
        id: true,
        memberships: {
          where: { orgId },
          select: { id: true },
        },
      },
    });
    if (existingUser && existingUser.memberships.length > 0) {
      throw new ConflictException(
        'That email is already a member of this organization',
      );
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITE_EXPIRY_MS);

    // Upsert — only one outstanding invite per (orgId, email). A pending or
    // revoked row is refreshed in place; an accepted row 409s.
    const existing = await this.prisma.invite.findUnique({
      where: { orgId_email: { orgId, email: input.email } },
    });
    if (existing?.acceptedAt) {
      throw new ConflictException(
        'That email already accepted an invite to this org',
      );
    }

    const invite = existing
      ? await this.prisma.invite.update({
          where: { id: existing.id },
          data: {
            role: input.role,
            token,
            expiresAt,
            invitedByUserId: actorUserId,
            revokedAt: null,
            acceptedAt: null,
            acceptedByUserId: null,
          },
          include: {
            invitedBy: { select: { email: true } },
            org: { select: { name: true } },
          },
        })
      : await this.prisma.invite.create({
          data: {
            orgId,
            email: input.email,
            role: input.role,
            token,
            expiresAt,
            invitedByUserId: actorUserId,
          },
          include: {
            invitedBy: { select: { email: true } },
            org: { select: { name: true } },
          },
        });

    await deliverInviteEmail({
      email: invite.email,
      url: inviteAcceptUrl(invite.token),
      orgName: invite.org.name,
      inviterEmail: invite.invitedBy.email,
      role: invite.role,
    });

    return toSummary(invite, invite.invitedBy.email);
  }

  async listInvites(orgId: string): Promise<InviteSummary[]> {
    const rows = await this.prisma.invite.findMany({
      where: { orgId },
      include: { invitedBy: { select: { email: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => toSummary(r, r.invitedBy.email));
  }

  async revokeInvite(args: {
    orgId: string;
    actorRole: 'owner' | 'admin' | 'member';
    inviteId: string;
  }): Promise<void> {
    const { orgId, actorRole, inviteId } = args;
    if (actorRole === 'member') {
      throw new ForbiddenException('Only owners and admins can revoke invites');
    }
    const invite = await this.prisma.invite.findUnique({
      where: { id: inviteId },
    });
    if (!invite || invite.orgId !== orgId) {
      throw new NotFoundException('Invite not found');
    }
    if (invite.acceptedAt) {
      throw new BadRequestException(
        'Cannot revoke an invite that was already accepted',
      );
    }
    if (invite.revokedAt) return; // idempotent
    await this.prisma.invite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });
  }

  async listMembers(orgId: string): Promise<MemberSummary[]> {
    const memberships = await this.prisma.orgMembership.findMany({
      where: { orgId },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return memberships.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    }));
  }

  /**
   * Public: look up an invite by token. Used by the /invite/[token] page to
   * decide what to render before the user signs in.
   */
  async lookupByToken(token: string): Promise<InviteLookupResponse> {
    const invite = await this.prisma.invite.findUnique({
      where: { token },
      include: { org: { select: { name: true } } },
    });
    if (!invite) {
      throw new NotFoundException('Invite not found');
    }
    return {
      status: deriveStatus(invite),
      orgName: invite.org.name,
      role: invite.role,
      invitedEmail: invite.email,
      expiresAt: invite.expiresAt.toISOString(),
    };
  }

  /**
   * Accept an invite as the currently signed-in user. The email on the
   * session must match the invite's email — preventing one user from
   * consuming another's invite even if they obtain the token.
   *
   * Returns the orgId the user now has a membership in so the client can
   * POST /me/active-org to switch.
   */
  async acceptByToken(args: {
    token: string;
    actorUserId: string;
    actorEmail: string;
  }): Promise<{ orgId: string; role: InviteRole | 'owner' }> {
    const { token, actorUserId, actorEmail } = args;
    const invite = await this.prisma.invite.findUnique({ where: { token } });
    if (!invite) throw new NotFoundException('Invite not found');
    const status = deriveStatus(invite);
    if (status !== 'pending') {
      throw new BadRequestException(`Invite is ${status}`);
    }
    if (invite.email.toLowerCase() !== actorEmail.toLowerCase()) {
      throw new ForbiddenException(
        `This invite is for a different address. Sign in as ${invite.email}.`,
      );
    }

    // Race-safe: if the user already has a membership in this org (e.g. they
    // clicked Accept twice), short-circuit to idempotent success.
    const existing = await this.prisma.orgMembership.findUnique({
      where: { userId_orgId: { userId: actorUserId, orgId: invite.orgId } },
    });
    if (existing) {
      // Still mark the invite consumed so we don't show it as pending.
      await this.prisma.invite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: invite.acceptedAt ?? new Date(),
          acceptedByUserId: invite.acceptedByUserId ?? actorUserId,
        },
      });
      return { orgId: invite.orgId, role: existing.role };
    }

    await this.prisma.$transaction([
      this.prisma.orgMembership.create({
        data: {
          userId: actorUserId,
          orgId: invite.orgId,
          role: invite.role,
        },
      }),
      this.prisma.invite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), acceptedByUserId: actorUserId },
      }),
    ]);

    return { orgId: invite.orgId, role: invite.role };
  }
}

function deriveStatus(
  invite: Invite,
): 'pending' | 'accepted' | 'revoked' | 'expired' {
  if (invite.acceptedAt) return 'accepted';
  if (invite.revokedAt) return 'revoked';
  if (invite.expiresAt.getTime() < Date.now()) return 'expired';
  return 'pending';
}

function toSummary(invite: Invite, invitedByEmail: string): InviteSummary {
  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: deriveStatus(invite),
    expiresAt: invite.expiresAt.toISOString(),
    createdAt: invite.createdAt.toISOString(),
    invitedByEmail,
  };
}
