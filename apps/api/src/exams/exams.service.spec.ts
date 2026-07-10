import { Test, TestingModule } from '@nestjs/testing';
import { ExamsService } from './exams.service';
import { PrismaService } from '../prisma.service';
import { NotFoundException } from '@nestjs/common';
import { QuestionType } from '@prisma/client';

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
    $transaction: jest.fn((callback: (tx: any) => any) => callback(mockPrismaService)),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExamsService,
        { provide: PrismaService, useValue: mockPrismaService },
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
});
