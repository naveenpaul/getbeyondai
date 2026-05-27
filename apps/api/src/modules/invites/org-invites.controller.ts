import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import {
  CurrentUser,
  type CurrentUserPayload,
} from '../auth/current-user.decorator';
import { CreateInviteSchema } from './invites.dto';
import type { InviteSummary, MemberSummary } from './invites.dto';
import { InvitesService } from './invites.service';

/**
 * Guarded org-management endpoints. The active org is whatever the session
 * says — AuthGuard already verified the caller's membership before the
 * handler runs. Role checks happen inside InvitesService.
 */
@Controller('org')
@UseGuards(AuthGuard)
export class OrgInvitesController {
  private readonly invites: InvitesService;

  constructor(@Inject(InvitesService) invites: InvitesService) {
    this.invites = invites;
  }

  @Post('invites')
  async create(
    @CurrentUser() user: CurrentUserPayload,
    @Body() body: unknown,
  ): Promise<InviteSummary> {
    const parsed = CreateInviteSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues[0]?.message ?? 'invalid body',
      );
    }
    return this.invites.createInvite({
      orgId: user.orgId,
      actorUserId: user.userId,
      actorRole: user.role,
      input: parsed.data,
    });
  }

  @Get('invites')
  async list(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<InviteSummary[]> {
    return this.invites.listInvites(user.orgId);
  }

  @Delete('invites/:id')
  async revoke(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.invites.revokeInvite({
      orgId: user.orgId,
      actorRole: user.role,
      inviteId: id,
    });
    return { ok: true };
  }

  @Get('members')
  async members(
    @CurrentUser() user: CurrentUserPayload,
  ): Promise<MemberSummary[]> {
    return this.invites.listMembers(user.orgId);
  }
}
