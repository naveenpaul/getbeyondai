import {
  CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createAuth } from './auth.config';
import type { CurrentUserPayload } from './current-user.decorator';

/**
 * Session-based auth guard.
 *
 * Reads the session cookie, calls better-auth's `getSession`, then verifies
 * the user still has an OrgMembership for their current activeOrgId before
 * attaching `{ userId, orgId, email, role }` to the request. The membership
 * lookup is the trust boundary: a stale session whose org the user has been
 * removed from is rejected here, not later in business logic.
 *
 * Throws 401 when no session is present, the cookie is invalid, or no
 * matching membership exists. Routes that need to be reachable anonymously
 * (the auth handler itself, health checks) simply don't apply this guard.
 *
 * Why not a global guard via APP_GUARD: applying it globally would also
 * block /api/auth/sign-in/magic-link before better-auth ever sees it.
 * Explicit @UseGuards at the controller level is one line per controller
 * and keeps the public/private boundary visible at the call site.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly prisma: PrismaService;
  private readonly auth: ReturnType<typeof createAuth>;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
    // The auth instance is cheap to construct; we cache one per guard
    // instance so we don't re-init better-auth on every request.
    this.auth = createAuth(prisma);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();

    // Fastify headers are Node's IncomingHttpHeaders; better-auth wants a
    // Web Headers object. Coerce + flatten.
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
    }

    const result = await this.auth.api.getSession({ headers });
    if (!result || !result.user) {
      throw new UnauthorizedException('Sign in to access this resource');
    }

    const user = result.user as {
      id: string;
      email: string;
      activeOrgId?: string;
    };
    if (!user.activeOrgId) {
      // The user.create hooks set activeOrgId atomically with the row.
      // A missing value means the session predates this migration — force
      // a fresh sign-in.
      throw new UnauthorizedException(
        'Session is missing an active org — sign in again',
      );
    }

    const membership = await this.prisma.orgMembership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId: user.activeOrgId } },
      select: { role: true },
    });
    if (!membership) {
      // The user no longer belongs to their active org (revoked or org
      // deleted). Reject the request — the client should re-fetch /me and
      // either pick another org or sign out.
      throw new UnauthorizedException(
        'No membership for the active org — switch orgs or sign in again',
      );
    }

    const payload: CurrentUserPayload = {
      userId: user.id,
      orgId: user.activeOrgId,
      email: user.email,
      role: membership.role,
    };
    (req as FastifyRequest & { user?: CurrentUserPayload }).user = payload;
    return true;
  }
}
