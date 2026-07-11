import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { Role } from '@prisma/client';
import { RateLimitMiddleware } from '../src/common/middleware/rate-limit.middleware';

const describeIf = (condition: boolean) => (condition ? describe : describe.skip);

describeIf(!process.env.CI)('Concurrency Smoke Test (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  const CONCURRENT_STUDENTS = 50;
  const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'dev_access_secret_do_not_use_in_prod_1234567890';

  beforeAll(async () => {
    // Disable rate limiting for concurrency load tests
    RateLimitMiddleware.store.get = () => undefined;

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
    // Clear databases
    await prisma.submission.deleteMany({});
    await prisma.examSession.deleteMany({});
    await prisma.examQuestion.deleteMany({});
    await prisma.exam.deleteMany({});
    await prisma.question.deleteMany({});
    await prisma.user.deleteMany({});

    // Create Admin User directly in DB to bypass Argon2 registration latency
    const adminUser = await prisma.user.create({
      data: {
        email: 'admin@example.com',
        passwordHash: 'mock_hash',
        role: Role.ADMIN,
      },
    });

    adminToken = jwt.sign(
      { sub: adminUser.id, email: adminUser.email, role: adminUser.role },
      JWT_SECRET,
    );
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

  it(`should support ${CONCURRENT_STUDENTS} students starting, autosaving, and submitting concurrently`, async () => {
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
        prompt: 'Write square.',
        starterCode: { python: 'def sq(n):\n  pass' },
        testCases: [{ input: '2', expectedOutput: '4', isPublic: true }],
        points: 20,
      })
      .expect(HttpStatus.CREATED);
    const codeId = qCodeRes.body.id;

    // 3. Create Exam
    const examRes = await request(app.getHttpServer())
      .post('/v1/exams')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        title: 'Concurrent Load Test Exam',
        startsAt: new Date(Date.now() - 3600000).toISOString(),
        endsAt: new Date(Date.now() + 3600000).toISOString(),
        durationMinutes: 60,
        questions: [
          { questionId: mcqId, order: 1, points: 10 },
          { questionId: codeId, order: 2, points: 20 },
        ],
      })
      .expect(HttpStatus.CREATED);
    const examId = examRes.body.id;

    // 4. Directly seed 50 Students in the DB and generate their JWTs instantly
    const studentData = Array.from({ length: CONCURRENT_STUDENTS }).map((_, idx) => ({
      email: `student_${idx}@example.com`,
      passwordHash: 'mock_student_hash',
      role: Role.STUDENT,
    }));

    await prisma.user.createMany({
      data: studentData,
    });

    const studentsInDb = await prisma.user.findMany({
      where: { role: Role.STUDENT },
    });
    expect(studentsInDb).toHaveLength(CONCURRENT_STUDENTS);

    const studentTokens = studentsInDb.map((student) => {
      return jwt.sign(
        { sub: student.id, email: student.email, role: student.role },
        JWT_SECRET,
      );
    });

    // 5. Start sessions concurrently for all 50 students
    const sessionStartPromises = studentTokens.map(async (token) => {
      const res = await request(app.getHttpServer())
        .post(`/v1/exams/${examId}/start`)
        .set('Authorization', `Bearer ${token}`)
        .expect(HttpStatus.CREATED);
      return res.body.id;
    });

    const sessionIds = await Promise.all(sessionStartPromises);
    expect(sessionIds).toHaveLength(CONCURRENT_STUDENTS);

    // 6. Autosave answers concurrently
    const autosavePromises = sessionIds.map(async (sessionId, idx) => {
      const token = studentTokens[idx];
      // Autosave MCQ
      await request(app.getHttpServer())
        .patch(`/v1/exams/sessions/${sessionId}/answers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ questionId: mcqId, answer: { selectedOption: 'b' } })
        .expect(HttpStatus.OK);

      // Autosave CODE
      await request(app.getHttpServer())
        .patch(`/v1/exams/sessions/${sessionId}/answers`)
        .set('Authorization', `Bearer ${token}`)
        .send({ questionId: codeId, answer: { language: 'python', code: 'def sq(n):\n  return n * n' } })
        .expect(HttpStatus.OK);
    });

    await Promise.all(autosavePromises);

    // 7. Submit sessions concurrently
    const submitPromises = sessionIds.map(async (sessionId, idx) => {
      const token = studentTokens[idx];
      const res = await request(app.getHttpServer())
        .post(`/v1/exams/sessions/${sessionId}/submit`)
        .set('Authorization', `Bearer ${token}`)
        .send({ idempotencyKey: `load_${sessionId}` })
        .expect(HttpStatus.OK);
      expect(res.body.status).toBe('SUBMITTED');
    });

    await Promise.all(submitPromises);

    // 8. Assert DB status for all 50 sessions
    const sessionsInDb = await prisma.examSession.findMany({
      where: { examId },
    });
    expect(sessionsInDb).toHaveLength(CONCURRENT_STUDENTS);
    for (const sess of sessionsInDb) {
      expect(sess.status).toBe('SUBMITTED');
    }

    const mcqSubmissions = await prisma.submission.findMany({
      where: { questionId: mcqId },
    });
    expect(mcqSubmissions).toHaveLength(CONCURRENT_STUDENTS);
    for (const sub of mcqSubmissions) {
      expect(sub.autoScore).toBe(10); // Auto graded successfully!
    }
  }, 300000); // 300s timeout for load test
});
