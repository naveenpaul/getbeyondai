import {
  Controller,
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
import type { InviteLookupResponse, InviteRole } from './invites.dto';
import { InvitesService } from './invites.service';

/**
 * /invite/:token endpoints.
 *
 * Lookup is public — the token IS the bearer secret. Anyone with the token
 * sees the org name + invited email, both of which they likely already
 * have from the invite email.
 *
 * Accept requires a session whose email matches the invite. AuthGuard
 * applies only to the accept route, not lookup.
 */
@Controller('invite')
export class PublicInvitesController {
  private readonly invites: InvitesService;

  constructor(@Inject(InvitesService) invites: InvitesService) {
    this.invites = invites;
  }

  @Get(':token/lookup')
  async lookup(@Param('token') token: string): Promise<InviteLookupResponse> {
    return this.invites.lookupByToken(token);
  }

  @Post(':token/accept')
  @UseGuards(AuthGuard)
  async accept(
    @CurrentUser() user: CurrentUserPayload,
    @Param('token') token: string,
  ): Promise<{ orgId: string; role: InviteRole | 'owner' }> {
    return this.invites.acceptByToken({
      token,
      actorUserId: user.userId,
      actorEmail: user.email,
    });
  }
}
