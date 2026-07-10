import { Module } from '@nestjs/common';
import { ExamsService } from './exams.service';
import { ExamsController } from './exams.controller';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../common/redis.service';
import { JudgeService } from './judge.service';

@Module({
  controllers: [ExamsController],
  providers: [ExamsService, PrismaService, RedisService, JudgeService],
  exports: [ExamsService],
})
export class ExamsModule {}
