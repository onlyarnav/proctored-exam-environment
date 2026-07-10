import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { Role } from '@prisma/client';

describe('ExamsController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let studentToken: string;
  let studentUserId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('v1');
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    // Clean database before each test
    await prisma.submission.deleteMany({});
    await prisma.examSession.deleteMany({});
    await prisma.examQuestion.deleteMany({});
    await prisma.exam.deleteMany({});
    await prisma.question.deleteMany({});
    await prisma.user.deleteMany({});

    // Create Admin User & Login
    const adminCredentials = { email: 'admin@example.com', password: 'password123' };
    const adminRegisterRes = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send(adminCredentials)
      .expect(HttpStatus.CREATED);

    // Promote to Admin
    await prisma.user.update({
      where: { id: adminRegisterRes.body.id },
      data: { role: Role.ADMIN },
    });

    const adminLoginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send(adminCredentials)
      .expect(HttpStatus.OK);
    adminToken = adminLoginRes.body.accessToken;

    // Create Student User & Login
    const studentCredentials = { email: 'student@example.com', password: 'password123' };
    const studentRegisterRes = await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send(studentCredentials)
      .expect(HttpStatus.CREATED);
    studentUserId = studentRegisterRes.body.id;

    const studentLoginRes = await request(app.getHttpServer())
      .post('/v1/auth/login')
      .send(studentCredentials)
      .expect(HttpStatus.OK);
    studentToken = studentLoginRes.body.accessToken;
  });

  afterAll(async () => {
    try {
      await prisma.submission.deleteMany({});
      await prisma.examSession.deleteMany({});
      await prisma.examQuestion.deleteMany({});
      await prisma.exam.deleteMany({});
      await prisma.question.deleteMany({});
      await prisma.user.deleteMany({});
      await prisma.$disconnect();
    } catch (e) {
      // ignore teardown errors
    }
    await app.close();
  });

  describe('Full Exam Lifecycle', () => {
    it('should complete a student exam session end-to-end', async () => {
      // 1. Create MCQ Question
      const qMcqRes = await request(app.getHttpServer())
        .post('/v1/questions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'MCQ',
          prompt: 'What is 2 + 2?',
          options: [{ id: 'a', text: '3' }, { id: 'b', text: '4' }],
          correctOption: 'b',
          points: 10,
        })
        .expect(HttpStatus.CREATED);

      const mcqId = qMcqRes.body.id;

      // 2. Create CODE Question
      const qCodeRes = await request(app.getHttpServer())
        .post('/v1/questions')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: 'CODE',
          prompt: 'Write a function returning square of number.',
          starterCode: { python: 'def sq(n):\n  pass' },
          testCases: [
            { input: '2', expectedOutput: '4', isPublic: true },
            { input: '5', expectedOutput: '25', isPublic: false },
          ],
          points: 20,
        })
        .expect(HttpStatus.CREATED);

      const codeId = qCodeRes.body.id;

      // 3. Create Exam linking both questions
      const startsAt = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      const endsAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

      const examRes = await request(app.getHttpServer())
        .post('/v1/exams')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'AI Olympiad Exam 1',
          startsAt,
          endsAt,
          durationMinutes: 60,
          questions: [
            { questionId: mcqId, order: 1, points: 10 },
            { questionId: codeId, order: 2, points: 20 },
          ],
        })
        .expect(HttpStatus.CREATED);

      const examId = examRes.body.id;

      // 4. Student starts exam session
      const startRes = await request(app.getHttpServer())
        .post(`/v1/exams/${examId}/start`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(HttpStatus.CREATED);

      const sessionId = startRes.body.id;
      expect(startRes.body.status).toBe('IN_PROGRESS');

      // 5. Student fetches exam session - verify stripped content
      const getSessionRes = await request(app.getHttpServer())
        .get(`/v1/exams/${examId}/session`)
        .set('Authorization', `Bearer ${studentToken}`)
        .expect(HttpStatus.OK);

      const questions = getSessionRes.body.exam.questions;
      expect(questions).toHaveLength(2);

      const mcqQuestion = questions[0].question;
      expect(mcqQuestion.correctOption).toBeUndefined(); // Stripped!

      const codeQuestion = questions[1].question;
      expect(codeQuestion.testCases).toHaveLength(1); // Only public!
      expect(codeQuestion.testCases[0].isPublic).toBe(true);

      // 6. Student autosaves MCQ answer (correct choice: 'b')
      await request(app.getHttpServer())
        .patch(`/v1/exams/sessions/${sessionId}/answers`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          questionId: mcqId,
          answer: { selectedOption: 'b' },
        })
        .expect(HttpStatus.OK);

      // 7. Student autosaves CODE answer
      await request(app.getHttpServer())
        .patch(`/v1/exams/sessions/${sessionId}/answers`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({
          questionId: codeId,
          answer: { language: 'python', code: 'def sq(n):\n  return n * n' },
        })
        .expect(HttpStatus.OK);

      // 8. Student submits the exam manually
      const submitRes = await request(app.getHttpServer())
        .post(`/v1/exams/sessions/${sessionId}/submit`)
        .set('Authorization', `Bearer ${studentToken}`)
        .send({ idempotencyKey: 'session_submit_123' })
        .expect(HttpStatus.OK);

      expect(submitRes.body.status).toBe('SUBMITTED');

      // Verify MCQ autoScore is graded correctly (points = 10)
      const mcqSub = await prisma.submission.findFirst({
        where: { sessionId, questionId: mcqId },
      });
      expect(mcqSub?.autoScore).toBe(10);
      expect(mcqSub?.gradedAt).toBeDefined();

      // Verify CODE submission has no score yet (needs judge-worker)
      const codeSub = await prisma.submission.findFirst({
        where: { sessionId, questionId: codeId },
      });
      expect(codeSub?.autoScore).toBeNull();
      expect(codeSub?.gradedAt).toBeNull();
    });
  });
});
