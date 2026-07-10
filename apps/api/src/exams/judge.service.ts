import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../common/redis.service';

@Injectable()
export class JudgeService implements OnModuleInit {
  private readonly logger = new Logger('JudgeService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  onModuleInit() {
    this.listenForResults().catch((err) => {
      this.logger.error('Failed to run judge results listener loop', err.stack);
    });
  }

  async listenForResults() {
    const redis = this.redisService.getClient();
    this.logger.log('Starting judge results consumer loop...');

    while (true) {
      try {
        const res = await redis.blpop('judge:results', 0);
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
