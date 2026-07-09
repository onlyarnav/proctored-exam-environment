import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

describe('AuthController (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
    await prisma.refreshToken.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  afterAll(async () => {
    try {
      await prisma.refreshToken.deleteMany({});
      await prisma.auditLog.deleteMany({});
      await prisma.user.deleteMany({});
      await prisma.$disconnect();
    } catch (e) {
      // ignore teardown errors if db isn't active
    }
    await app.close();
  });

  describe('Registration & Authentication Flow', () => {
    const testUser = {
      email: 'student@example.com',
      password: 'password123',
    };

    it('should register a new student successfully', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CREATED);

      expect(response.body.email).toBe(testUser.email);
      expect(response.body.role).toBe('STUDENT');
      expect(response.body.passwordHash).toBeUndefined();
    });

    it('should reject registration if email already exists', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CONFLICT);

      expect(response.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    });

    it('should login and return access & refresh tokens', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CREATED);

      const response = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send(testUser)
        .expect(HttpStatus.OK);

      expect(response.body.accessToken).toBeDefined();
      expect(response.body.refreshToken).toBeDefined();
    });

    it('should allow accessing protected routes with access token', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CREATED);

      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send(testUser)
        .expect(HttpStatus.OK);

      const token = loginRes.body.accessToken;

      const profileRes = await request(app.getHttpServer())
        .get('/v1/auth/profile')
        .set('Authorization', `Bearer ${token}`)
        .expect(HttpStatus.OK);

      expect(profileRes.body.email).toBe(testUser.email);
    });

    it('should deny access to routes with wrong role (RBAC)', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CREATED);

      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send(testUser)
        .expect(HttpStatus.OK);

      const token = loginRes.body.accessToken;

      const adminRes = await request(app.getHttpServer())
        .get('/v1/auth/admin-only')
        .set('Authorization', `Bearer ${token}`)
        .expect(HttpStatus.FORBIDDEN);

      expect(adminRes.body.error.code).toBe('FORBIDDEN');
    });

    it('should rotate refresh token', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CREATED);

      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send(testUser)
        .expect(HttpStatus.OK);

      const { refreshToken } = loginRes.body;

      const refreshRes = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.OK);

      expect(refreshRes.body.accessToken).toBeDefined();
      expect(refreshRes.body.refreshToken).toBeDefined();
      expect(refreshRes.body.refreshToken).not.toBe(refreshToken);
    });

    it('should trigger reuse detection on revoked refresh token', async () => {
      await request(app.getHttpServer())
        .post('/v1/auth/register')
        .send(testUser)
        .expect(HttpStatus.CREATED);

      const loginRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send(testUser)
        .expect(HttpStatus.OK);

      const { refreshToken } = loginRes.body;

      // First refresh succeeds and revokes the token
      await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.OK);

      // Second refresh using the same token (reuse) must fail and revoke all tokens
      const reuseRes = await request(app.getHttpServer())
        .post('/v1/auth/refresh')
        .send({ refreshToken })
        .expect(HttpStatus.UNAUTHORIZED);

      expect(reuseRes.body.error.code).toBe('REFRESH_TOKEN_REUSE_DETECTED');
    });

    it('should rate limit login attempts', async () => {
      // Send 5 quick login attempts
      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/v1/auth/login')
          .send({ email: 'fake@example.com', password: 'wrong' })
          .expect(HttpStatus.UNAUTHORIZED);
      }

      // The 6th attempt must be rate-limited
      const rateLimitRes = await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'fake@example.com', password: 'wrong' })
        .expect(HttpStatus.TOO_MANY_REQUESTS);

      expect(rateLimitRes.body.error.code).toBe('TOO_MANY_REQUESTS');
    });
  });
});
