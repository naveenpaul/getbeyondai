import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthGuard } from './auth.guard';
import { CurrentUser, type CurrentUserPayload } from './current-user.decorator';

/**
 * /me endpoints — identity payload + active-org switcher.
 *
 * Surfaces the full multi-org picture the web client needs to render an org
 * switcher: the orgs the user is a member of, the role they hold in each,
 * and which one is currently active. AuthGuard already verified the active
 * org's membership before this handler runs, so the switcher is the only
 * mutation here.
 */

const SwitchOrgSchema = z.object({
  orgId: z.string().min(1),
});

interface MeResponse {
  userId: string;
  email: string;
  activeOrgId: string;
  orgs: Array<{ id: string; name: string | null; role: 'owner' | 'member' }>;
}

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  private readonly prisma: PrismaService;

  constructor(@Inject(PrismaService) prisma: PrismaService) {
    this.prisma = prisma;
  }

  @Get()
  async me(@CurrentUser() user: CurrentUserPayload): Promise<MeResponse> {
    const memberships = await this.prisma.orgMembership.findMany({
      where: { userId: user.userId },
      include: { org: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      userId: user.userId,
      email: user.email,
      activeOrgId: user.orgId,
      orgs: memberships.map((m) => ({
        id: m.org.id,
        name: m.org.name,
        role: m.role,
      })),
    };
  }

  @Post('active-org')
  async switchActiveOrg(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<MeResponse> {
    const parsed = SwitchOrgSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid body');
    }
    const { orgId } = parsed.data;

    const membership = await this.prisma.orgMembership.findUnique({
      where: { userId_orgId: { userId: user.userId, orgId } },
    });
    if (!membership) {
      throw new ForbiddenException('Not a member of that org');
    }

    await this.prisma.user.update({
      where: { id: user.userId },
      data: { activeOrgId: orgId },
    });

    return this.me({ ...user, orgId, role: membership.role });
  }
}
