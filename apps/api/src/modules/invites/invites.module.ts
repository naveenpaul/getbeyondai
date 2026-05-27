import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { InvitesService } from './invites.service';
import { OrgInvitesController } from './org-invites.controller';
import { PublicInvitesController } from './public-invites.controller';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [OrgInvitesController, PublicInvitesController],
  providers: [InvitesService],
  exports: [InvitesService],
})
export class InvitesModule {}
