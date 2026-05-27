import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { MeController } from './me.controller';

@Module({
  imports: [PrismaModule],
  controllers: [AuthController, MeController],
  providers: [AuthGuard],
  exports: [AuthGuard],
})
export class AuthModule {}
