import { Injectable, NotFoundException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateExamDto } from './dto/create-exam.dto';
import { ErrorCode } from 'shared-types';
import { RedisService } from '../common/redis.service';

@Injectable()
export class ExamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
  ) {}

  // ==========================================
  // QUESTIONS CRUD (ADMIN ONLY)
  // ==========================================

  async createQuestion(dto: CreateQuestionDto) {
    return this.prisma.question.create({
      data: {
        type: dto.type,
        prompt: dto.prompt,
        options: dto.options ? JSON.parse(JSON.stringify(dto.options)) : null,
        correctOption: dto.correctOption || null,
        starterCode: dto.starterCode ? JSON.parse(JSON.stringify(dto.starterCode)) : null,
        testCases: dto.testCases ? JSON.parse(JSON.stringify(dto.testCases)) : null,
        points: dto.points,
        topic: dto.topic || null,
        difficulty: dto.difficulty || null,
      },
    });
  }

  async getQuestion(id: string) {
    const question = await this.prisma.question.findUnique({
      where: { id },
    });
    if (!question) {
      throw new NotFoundException(`Question with ID ${id} not found`);
    }
    return question;
  }

  async listQuestions() {
    return this.prisma.question.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateQuestion(id: string, dto: CreateQuestionDto) {
    await this.getQuestion(id);
    return this.prisma.question.update({
      where: { id },
      data: {
        type: dto.type,
        prompt: dto.prompt,
        options: dto.options ? JSON.parse(JSON.stringify(dto.options)) : null,
        correctOption: dto.correctOption || null,
        starterCode: dto.starterCode ? JSON.parse(JSON.stringify(dto.starterCode)) : null,
        testCases: dto.testCases ? JSON.parse(JSON.stringify(dto.testCases)) : null,
        points: dto.points,
        topic: dto.topic || null,
        difficulty: dto.difficulty || null,
      },
    });
  }

  async deleteQuestion(id: string) {
    await this.getQuestion(id);
    return this.prisma.question.delete({
      where: { id },
    });
  }

  // ==========================================
  // EXAMS CRUD (ADMIN ONLY)
  // ==========================================

  async createExam(dto: CreateExamDto, createdBy: string) {
    return this.prisma.$transaction(async (tx) => {
      const exam = await tx.exam.create({
        data: {
          title: dto.title,
          description: dto.description || null,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          durationMinutes: dto.durationMinutes,
          createdBy,
        },
      });

      // Link questions
      if (dto.questions && dto.questions.length > 0) {
        await tx.examQuestion.createMany({
          data: dto.questions.map((q) => ({
            examId: exam.id,
            questionId: q.questionId,
            order: q.order,
            points: q.points,
          })),
        });
      }

      return tx.exam.findUnique({
        where: { id: exam.id },
        include: {
          questions: {
            include: { question: true },
            orderBy: { order: 'asc' },
          },
        },
      });
    });
  }

  async getExam(id: string) {
    const exam = await this.prisma.exam.findUnique({
      where: { id },
      include: {
        questions: {
          include: { question: true },
          orderBy: { order: 'asc' },
        },
      },
    });
    if (!exam) {
      throw new NotFoundException(`Exam with ID ${id} not found`);
    }
    return exam;
  }

  async listExams() {
    return this.prisma.exam.findMany({
      include: {
        questions: {
          include: { question: true },
          orderBy: { order: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateExam(id: string, dto: CreateExamDto) {
    await this.getExam(id);
    return this.prisma.$transaction(async (tx) => {
      // Clear current linked questions
      await tx.examQuestion.deleteMany({
        where: { examId: id },
      });

      // Update exam fields
      await tx.exam.update({
        where: { id },
        data: {
          title: dto.title,
          description: dto.description || null,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          durationMinutes: dto.durationMinutes,
        },
      });

      // Relink questions
      if (dto.questions && dto.questions.length > 0) {
        await tx.examQuestion.createMany({
          data: dto.questions.map((q) => ({
            examId: id,
            questionId: q.questionId,
            order: q.order,
            points: q.points,
          })),
        });
      }

      return tx.exam.findUnique({
        where: { id },
        include: {
          questions: {
            include: { question: true },
            orderBy: { order: 'asc' },
          },
        },
      });
    });
  }

  async deleteExam(id: string) {
    await this.getExam(id);
    return this.prisma.exam.delete({
      where: { id },
    });
  }

  // ==========================================
  // CANDIDATE EXAM SESSIONS
  // ==========================================

  async startExamSession(examId: string, userId: string) {
    const now = new Date();
    const exam = await this.prisma.exam.findUnique({
      where: { id: examId },
    });
    if (!exam) {
      throw new NotFoundException(`Exam with ID ${examId} not found`);
    }

    if (now < exam.startsAt) {
      throw new ConflictException({
        code: 'EXAM_NOT_STARTED',
        message: 'This exam has not started yet',
      });
    }
    if (now > exam.endsAt) {
      throw new ConflictException({
        code: 'EXAM_HAS_ENDED',
        message: 'This exam has already ended',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      // Row locking on ExamSession
      const sessions = await tx.$queryRaw<any[]>`
        SELECT * FROM "ExamSession" 
        WHERE "examId" = ${examId} AND "userId" = ${userId} 
        LIMIT 1 
        FOR UPDATE
      `;

      let session = sessions.length > 0 ? sessions[0] : null;

      if (!session) {
        // Create new session in IN_PROGRESS
        session = await tx.examSession.create({
          data: {
            examId,
            userId,
            status: 'IN_PROGRESS',
            startedAt: now,
          },
        });
      } else {
        if (session.status === 'NOT_STARTED') {
          session = await tx.examSession.update({
            where: { id: session.id },
            data: {
              status: 'IN_PROGRESS',
              startedAt: now,
            },
          });
        } else if (session.status === 'IN_PROGRESS') {
          // Already in progress, just return
        } else {
          // SUBMITTED or GRADED
          throw new ConflictException({
            code: 'INVALID_SESSION_TRANSITION',
            message: `Cannot start exam session in status ${session.status}`,
          });
        }
      }

      return session;
    });
  }

  async getExamSession(examId: string, userId: string, role: string) {
    const session = await this.prisma.examSession.findUnique({
      where: { examId_userId: { examId, userId } },
      include: {
        exam: {
          include: {
            questions: {
              include: { question: true },
              orderBy: { order: 'asc' },
            },
          },
        },
      },
    });

    if (!session) {
      throw new NotFoundException(`No exam session found for exam ${examId} and user ${userId}`);
    }

    // Strip answers/correct options if student
    if (role === 'STUDENT') {
      const strippedQuestions = session.exam.questions.map((eq: any) => {
        const q = eq.question;
        if (q.type === 'MCQ') {
          return {
            ...eq,
            question: {
              id: q.id,
              type: q.type,
              prompt: q.prompt,
              options: q.options,
              points: q.points,
              topic: q.topic,
              difficulty: q.difficulty,
            },
          };
        } else if (q.type === 'CODE') {
          const testCases = Array.isArray(q.testCases)
            ? q.testCases.filter((tc: any) => tc.isPublic !== false)
            : null;
          return {
            ...eq,
            question: {
              id: q.id,
              type: q.type,
              prompt: q.prompt,
              starterCode: q.starterCode,
              testCases,
              points: q.points,
              topic: q.topic,
              difficulty: q.difficulty,
            },
          };
        }
        return eq;
      });

      return {
        ...session,
        exam: {
          ...session.exam,
          questions: strippedQuestions,
        },
      };
    }

    return session;
  }

  async saveDraftAnswer(sessionId: string, userId: string, questionId: string, answer: any) {
    const now = new Date();
    
    // Fetch session and exam
    const session = await this.prisma.examSession.findUnique({
      where: { id: sessionId },
      include: { exam: true },
    });

    if (!session) {
      throw new NotFoundException(`Exam session ${sessionId} not found`);
    }

    if (session.userId !== userId) {
      throw new ForbiddenException('You do not have access to this session');
    }

    // Check if session is active
    const startedTime = new Date(session.startedAt!).getTime();
    const durationMs = session.exam.durationMinutes * 60 * 1000;
    const limitTime = startedTime + durationMs;
    const examEndsTime = new Date(session.exam.endsAt).getTime();

    if (session.status !== 'IN_PROGRESS' || now.getTime() > limitTime || now.getTime() > examEndsTime) {
      if (session.status === 'IN_PROGRESS') {
        await this.prisma.examSession.update({
          where: { id: sessionId },
          data: {
            status: 'SUBMITTED',
            submittedAt: new Date(Math.min(limitTime, examEndsTime)),
          },
        });
      }
      throw new ConflictException({
        code: 'SESSION_EXPIRED',
        message: 'This exam session has already expired or been submitted',
      });
    }

    // Perform upsert on Submission
    return this.prisma.submission.upsert({
      where: {
        sessionId_questionId: {
          sessionId,
          questionId,
        },
      },
      update: {
        answer: answer ? JSON.parse(JSON.stringify(answer)) : null,
        createdAt: now,
      },
      create: {
        sessionId,
        questionId,
        answer: answer ? JSON.parse(JSON.stringify(answer)) : null,
      },
    });
  }

  async submitExamSession(sessionId: string, userId: string, correlationId: string, idempotencyKey?: string) {
    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      // Row locking on ExamSession
      const sessions = await tx.$queryRaw<any[]>`
        SELECT * FROM "ExamSession" 
        WHERE "id" = ${sessionId} 
        LIMIT 1 
        FOR UPDATE
      `;

      if (sessions.length === 0) {
        throw new NotFoundException(`Exam session ${sessionId} not found`);
      }

      const session = sessions[0];

      if (session.userId !== userId) {
        throw new ForbiddenException('You do not have access to this session');
      }

      // Idempotency: If already submitted or graded
      if (session.status === 'SUBMITTED' || session.status === 'GRADED') {
        if (idempotencyKey && session.idempotencyKey === idempotencyKey) {
          return session;
        }
        throw new ConflictException({
          code: 'SESSION_ALREADY_SUBMITTED',
          message: 'This session has already been submitted',
        });
      }

      // Check time limit
      const startedTime = new Date(session.startedAt).getTime();
      const exam = await tx.exam.findUnique({ where: { id: session.examId } });
      if (!exam) {
        throw new NotFoundException('Exam not found');
      }
      const durationMs = exam.durationMinutes * 60 * 1000;
      const limitTime = startedTime + durationMs;
      const examEndsTime = new Date(exam.endsAt).getTime();

      if (now.getTime() > limitTime || now.getTime() > examEndsTime) {
        const finalSubmitTime = new Date(Math.min(limitTime, examEndsTime));
        const updated = await tx.examSession.update({
          where: { id: sessionId },
          data: {
            status: 'SUBMITTED',
            submittedAt: finalSubmitTime,
            idempotencyKey: idempotencyKey || null,
          },
        });
        
        await this.autoGradeMCQSubmissions(sessionId, tx);
        
        throw new ConflictException({
          code: 'SESSION_EXPIRED',
          message: 'The submission deadline has passed. The session was auto-submitted.',
        });
      }

      const updatedSession = await tx.examSession.update({
        where: { id: sessionId },
        data: {
          status: 'SUBMITTED',
          submittedAt: now,
          idempotencyKey: idempotencyKey || null,
        },
      });

      await this.autoGradeMCQSubmissions(sessionId, tx);
      await this.enqueueCodeSubmissions(sessionId, tx, correlationId);

      return updatedSession;
    });
  }

  async autoGradeMCQSubmissions(sessionId: string, tx: any) {
    const submissions = await tx.submission.findMany({
      where: { sessionId },
      include: {
        session: {
          include: {
            exam: {
              include: {
                questions: {
                  include: { question: true }
                }
              }
            }
          }
        }
      }
    });

    for (const sub of submissions) {
      const examQuestion = sub.session.exam.questions.find((eq: any) => eq.questionId === sub.questionId);
      if (!examQuestion) continue;
      const q = examQuestion.question;
      if (q.type === 'MCQ') {
        const answerObj = sub.answer as any;
        const selected = answerObj?.selectedOption;
        const points = examQuestion.points !== null && examQuestion.points !== undefined ? examQuestion.points : q.points;
        const isCorrect = selected === q.correctOption;
        
        await tx.submission.update({
          where: { id: sub.id },
          data: {
            autoScore: isCorrect ? points : 0,
            gradedAt: new Date(),
          }
        });
      }
    }
  }

  async enqueueCodeSubmissions(sessionId: string, tx: any, correlationId: string) {
    const submissions = await tx.submission.findMany({
      where: { sessionId },
      include: {
        session: {
          include: {
            exam: {
              include: {
                questions: {
                  include: { question: true }
                }
              }
            }
          }
        }
      }
    });

    for (const sub of submissions) {
      const examQuestion = sub.session.exam.questions.find((eq: any) => eq.questionId === sub.questionId);
      if (!examQuestion) continue;
      const q = examQuestion.question;
      if (q.type === 'CODE') {
        const answerObj = sub.answer as any;
        const code = answerObj?.code;
        const language = answerObj?.language;

        const points = examQuestion.points !== null && examQuestion.points !== undefined ? examQuestion.points : q.points;
        const job = {
          submissionId: sub.id,
          language,
          code,
          testCases: q.testCases || [],
          points,
          idempotencyKey: sub.idempotencyKey || sub.id,
          correlationId,
        };

        await this.redisService.getClient().rpush('judge:queue:submissions', JSON.stringify(job));
      }
    }
  }
}
