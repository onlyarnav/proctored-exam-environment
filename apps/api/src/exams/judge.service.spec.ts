import { Test, TestingModule } from '@nestjs/testing';
import { JudgeService } from './judge.service';
import { PrismaService } from '../prisma.service';
import { RedisService } from '../common/redis.service';

describe('JudgeService', () => {
  let service: JudgeService;
  let prisma: PrismaService;

  const mockPrismaService: any = {
    submission: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    examQuestion: {
      findMany: jest.fn(),
    },
    examSession: {
      update: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: any) => any) => callback(mockPrismaService)),
  };

  const mockRedisService = {
    getClient: jest.fn().mockReturnValue({
      blpop: jest.fn(),
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JudgeService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<JudgeService>(JudgeService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  describe('processResult', () => {
    it('should update submission and roll up session score', async () => {
      const mockSub = {
        id: 'sub_123',
        sessionId: 'session_123',
        questionId: 'q_code',
        session: { examId: 'exam_123', status: 'IN_PROGRESS' },
      };

      mockPrismaService.submission.findUnique.mockResolvedValue(mockSub);
      mockPrismaService.submission.findMany.mockResolvedValue([
        { id: 'sub_123', questionId: 'q_code', autoScore: 20, gradedAt: new Date() },
        { id: 'sub_mcq', questionId: 'q_mcq', autoScore: 10, gradedAt: new Date() },
      ]);

      mockPrismaService.examQuestion.findMany.mockResolvedValue([
        { questionId: 'q_code' },
        { questionId: 'q_mcq' },
      ]);

      mockPrismaService.submission.update.mockResolvedValue({});
      mockPrismaService.examSession.update.mockResolvedValue({});

      await service.processResult({
        submissionId: 'sub_123',
        results: [{ input: '1', expectedOutput: '1', passed: true }],
        score: 20,
      });

      expect(prisma.submission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub_123' },
          data: expect.objectContaining({ autoScore: 20 }),
        }),
      );

      // Verify roll up totals are correct (20 + 10 = 30)
      expect(prisma.examSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session_123' },
          data: expect.objectContaining({ score: 30, status: 'GRADED' }), // both submissions are graded
        }),
      );
    });
  });
});
