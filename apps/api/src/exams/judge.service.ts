import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../common/redis.service';
import Redis from 'ioredis';

@Injectable()
export class JudgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('JudgeService');
  private isClosed = false;
  private consumerClient?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    this.listenForResults().catch((err) => {
      this.logger.error('Failed to run judge results listener loop', err.stack);
    });
  }

  onModuleDestroy() {
    this.isClosed = true;
    if (this.consumerClient) {
      this.consumerClient.disconnect();
    }
  }

  async listenForResults() {
    this.consumerClient = this.redisService.getClient().duplicate();
    this.logger.log('Starting judge results consumer loop...');

    while (!this.isClosed) {
      try {
        const res = await this.consumerClient.blpop('judge:results', 0);
        if (this.isClosed) break;
        if (!res || res.length < 2) continue;
        
        const payload = JSON.parse(res[1]);
        await this.processResult(payload);
      } catch (err) {
        this.logger.error('Error processing judge result', err instanceof Error ? err.stack : err);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async processResult(payload: any) {
    const { submissionId, results, score, error } = payload;
    this.logger.log(`Received result for submission ${submissionId}: score=${score}, error=${error}`);

    await this.prisma.$transaction(async (tx) => {
      const sub = await tx.submission.findUnique({
        where: { id: submissionId },
        include: { session: true },
      });

      if (!sub) {
        this.logger.warn(`Submission ${submissionId} not found`);
        return;
      }

      await tx.submission.update({
        where: { id: submissionId },
        data: {
          autoScore: score,
          results: results ? JSON.parse(JSON.stringify(results)) : { error },
          gradedAt: new Date(),
        },
      });

      const allSubmissions = await tx.submission.findMany({
        where: { sessionId: sub.sessionId },
      });

      const examQuestions = await tx.examQuestion.findMany({
        where: { examId: sub.session.examId },
      });

      let totalScore = 0;
      for (const s of allSubmissions) {
        if (s.autoScore !== null && s.autoScore !== undefined) {
          totalScore += s.autoScore;
        }
      }

      const totalQuestionCount = examQuestions.length;
      const gradedSubmissionCount = allSubmissions.filter((s: any) => s.gradedAt !== null).length;
      const shouldMarkGraded = gradedSubmissionCount >= totalQuestionCount;

      await tx.examSession.update({
        where: { id: sub.sessionId },
        data: {
          score: totalScore,
          status: shouldMarkGraded ? 'GRADED' : sub.session.status,
        },
      });
    });
  }
}
