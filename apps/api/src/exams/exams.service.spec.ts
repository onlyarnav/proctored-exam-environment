import { Test, TestingModule } from '@nestjs/testing';
import { ExamsService } from './exams.service';
import { PrismaService } from '../prisma.service';
import { NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { QuestionType } from '@prisma/client';
import { RedisService } from '../common/redis.service';

describe('ExamsService', () => {
  let service: ExamsService;
  let prisma: PrismaService;

  const mockPrismaService: any = {
    question: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    exam: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    examQuestion: {
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback: (tx: any) => any) => callback(mockPrismaService)),
  };

  const mockRedisService = {
    getClient: jest.fn().mockReturnValue({
      rpush: jest.fn().mockResolvedValue(1),
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<ExamsService>(ExamsService);
    prisma = module.get<PrismaService>(PrismaService);

    jest.clearAllMocks();
  });

  describe('createQuestion', () => {
    it('should successfully create a question', async () => {
      const qDto = {
        type: QuestionType.MCQ,
        prompt: 'What is 2+2?',
        options: [{ id: 'a', text: '4' }, { id: 'b', text: '5' }],
        correctOption: 'a',
        points: 5,
      };

      mockPrismaService.question.create.mockResolvedValue({
        id: 'q_123',
        ...qDto,
      });

      const result = await service.createQuestion(qDto);

      expect(result.id).toBe('q_123');
      expect(prisma.question.create).toHaveBeenCalled();
    });
  });

  describe('getQuestion', () => {
    it('should return question if found', async () => {
      mockPrismaService.question.findUnique.mockResolvedValue({ id: 'q_123', prompt: 'test' });

      const result = await service.getQuestion('q_123');
      expect(result.id).toBe('q_123');
    });

    it('should throw NotFoundException if not found', async () => {
      mockPrismaService.question.findUnique.mockResolvedValue(null);

      await expect(service.getQuestion('q_123')).rejects.toThrow(NotFoundException);
    });
  });

  describe('createExam', () => {
    it('should create an exam and links questions in transaction', async () => {
      const examDto = {
        title: 'Math Exam',
        startsAt: new Date().toISOString(),
        endsAt: new Date().toISOString(),
        durationMinutes: 60,
        questions: [{ questionId: 'q_123', order: 1, points: 5 }],
      };

      mockPrismaService.exam.create.mockResolvedValue({ id: 'exam_123', ...examDto });
      mockPrismaService.examQuestion.createMany.mockResolvedValue({ count: 1 });
      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam_123',
        title: 'Math Exam',
        questions: [{ questionId: 'q_123', order: 1, points: 5 }],
      });

      const result = await service.createExam(examDto, 'admin_123');

      expect(result?.id).toBe('exam_123');
      expect(prisma.exam.create).toHaveBeenCalled();
      expect(prisma.examQuestion.createMany).toHaveBeenCalled();
    });
  });

  describe('startExamSession', () => {
    it('should throw ConflictException if exam has not started yet', async () => {
      const startsAt = new Date();
      startsAt.setDate(startsAt.getDate() + 1); // tomorrow

      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam_123',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 60000),
      });

      await expect(service.startExamSession('exam_123', 'user_123')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw ConflictException if exam has ended', async () => {
      const endsAt = new Date();
      endsAt.setDate(endsAt.getDate() - 1); // yesterday

      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam_123',
        startsAt: new Date(endsAt.getTime() - 60000),
        endsAt,
      });

      await expect(service.startExamSession('exam_123', 'user_123')).rejects.toThrow(
        ConflictException,
      );
    });

    it('should create session if active and no session exists', async () => {
      const startsAt = new Date(Date.now() - 3600000);
      const endsAt = new Date(Date.now() + 3600000);

      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam_123',
        startsAt,
        endsAt,
      });

      mockPrismaService.$queryRaw.mockResolvedValue([]); // no session locked
      mockPrismaService.examSession = {
        create: jest.fn().mockResolvedValue({
          id: 'session_123',
          status: 'IN_PROGRESS',
        }),
        update: jest.fn(),
      };

      const result = await service.startExamSession('exam_123', 'user_123');
      expect(result.id).toBe('session_123');
      expect(result.status).toBe('IN_PROGRESS');
    });

    it('should throw ConflictException if session is already SUBMITTED', async () => {
      const startsAt = new Date(Date.now() - 3600000);
      const endsAt = new Date(Date.now() + 3600000);

      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam_123',
        startsAt,
        endsAt,
      });

      mockPrismaService.$queryRaw.mockResolvedValue([{ id: 'session_123', status: 'SUBMITTED' }]);

      await expect(service.startExamSession('exam_123', 'user_123')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('getExamSession', () => {
    it('should strip correctOption and non-public test cases for STUDENT role', async () => {
      const mockSession = {
        id: 'session_123',
        exam: {
          questions: [
            {
              question: {
                id: 'q_mcq',
                type: 'MCQ',
                prompt: 'Q1',
                options: [{ id: 'a', text: 'Ans' }],
                correctOption: 'a',
              },
            },
            {
              question: {
                id: 'q_code',
                type: 'CODE',
                prompt: 'Q2',
                testCases: [
                  { input: '1', expectedOutput: '2', isPublic: true },
                  { input: '3', expectedOutput: '4', isPublic: false },
                ],
              },
            },
          ],
        },
      };

      mockPrismaService.examSession = {
        findUnique: jest.fn().mockResolvedValue(mockSession),
      };

      const result = await service.getExamSession('exam_123', 'user_123', 'STUDENT');

      const mcqQ = result.exam.questions[0].question;
      const codeQ = result.exam.questions[1].question;

      expect(mcqQ.correctOption).toBeUndefined();
      expect(codeQ.testCases).toHaveLength(1);
      expect(codeQ.testCases[0].isPublic).toBe(true);
    });
  });

  describe('saveDraftAnswer', () => {
    it('should throw ForbiddenException if user does not match session', async () => {
      mockPrismaService.examSession.findUnique.mockResolvedValue({
        id: 'session_123',
        userId: 'user_other',
        exam: { durationMinutes: 60, endsAt: new Date(Date.now() + 3600000) },
      });

      await expect(
        service.saveDraftAnswer('session_123', 'user_123', 'q_123', { selectedOption: 'a' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw ConflictException if session status is not IN_PROGRESS', async () => {
      mockPrismaService.examSession.findUnique.mockResolvedValue({
        id: 'session_123',
        userId: 'user_123',
        status: 'SUBMITTED',
        startedAt: new Date(),
        exam: { durationMinutes: 60, endsAt: new Date(Date.now() + 3600000) },
      });

      await expect(
        service.saveDraftAnswer('session_123', 'user_123', 'q_123', { selectedOption: 'a' }),
      ).rejects.toThrow(ConflictException);
    });

    it('should upsert submission if active and valid', async () => {
      mockPrismaService.examSession.findUnique.mockResolvedValue({
        id: 'session_123',
        userId: 'user_123',
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        exam: { durationMinutes: 60, endsAt: new Date(Date.now() + 3600000) },
      });

      mockPrismaService.submission = {
        upsert: jest.fn().mockResolvedValue({ id: 'sub_123' }),
      };

      const result = await service.saveDraftAnswer('session_123', 'user_123', 'q_123', {
        selectedOption: 'a',
      });
      expect(result.id).toBe('sub_123');
      expect(prisma.submission.upsert).toHaveBeenCalled();
    });
  });

  describe('submitExamSession', () => {
    it('should successfully submit exam and run MCQ auto-grading', async () => {
      const mockSession = {
        id: 'session_123',
        userId: 'user_123',
        status: 'IN_PROGRESS',
        startedAt: new Date(),
        examId: 'exam_123',
      };

      mockPrismaService.$queryRaw.mockResolvedValue([mockSession]);
      mockPrismaService.exam.findUnique.mockResolvedValue({
        id: 'exam_123',
        durationMinutes: 60,
        endsAt: new Date(Date.now() + 3600000),
      });

      mockPrismaService.examSession.update = jest.fn().mockResolvedValue({
        ...mockSession,
        status: 'SUBMITTED',
      });

      mockPrismaService.submission.findMany = jest.fn().mockResolvedValue([
        {
          id: 'sub_mcq',
          questionId: 'q_mcq',
          answer: { selectedOption: 'a' },
          session: {
            exam: {
              questions: [
                {
                  questionId: 'q_mcq',
                  points: 5,
                  question: { type: 'MCQ', correctOption: 'a', points: 5 },
                },
              ],
            },
          },
        },
      ]);

      mockPrismaService.submission.update = jest.fn().mockResolvedValue({});

      const result = await service.submitExamSession('session_123', 'user_123', 'corr_123');

      expect(result.status).toBe('SUBMITTED');
      expect(prisma.submission.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'sub_mcq' },
          data: expect.objectContaining({ autoScore: 5 }),
        }),
      );
    });

    it('should allow submit replay if idempotency key matches', async () => {
      const mockSession = {
        id: 'session_123',
        userId: 'user_123',
        status: 'SUBMITTED',
        idempotencyKey: 'key_123',
      };

      mockPrismaService.$queryRaw.mockResolvedValue([mockSession]);

      const result = await service.submitExamSession('session_123', 'user_123', 'corr_123', 'key_123');
      expect(result.status).toBe('SUBMITTED');
    });
  });
});
