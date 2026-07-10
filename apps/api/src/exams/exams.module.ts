import { Module } from '@nestjs/common';
import { ExamsService } from './exams.service';
import { ExamsController } from './exams.controller';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../common/redis.service';

@Module({
  controllers: [ExamsController],
  providers: [ExamsService, PrismaService, RedisService],
  exports: [ExamsService],
})
export class ExamsModule {}
