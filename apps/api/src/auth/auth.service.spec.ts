import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma.service';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException, ConflictException } from '@nestjs/common';
import { Role } from '@prisma/client';
import * as argon2 from 'argon2';

jest.mock('argon2');

describe('AuthService', () => {
  let service: AuthService;
  let prisma: PrismaService;
  let jwtService: JwtService;

  const mockPrismaService: any = {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: any) => any) => callback(mockPrismaService)),
  };

  const mockJwtService = {
    sign: jest.fn(() => 'mock_jwt_access_token'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: JwtService, useValue: mockJwtService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    prisma = module.get<PrismaService>(PrismaService);
    jwtService = module.get<JwtService>(JwtService);

    jest.clearAllMocks();
  });

  describe('register', () => {
    it('should hash password and create user', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      (argon2.hash as jest.Mock).mockResolvedValue('hashed_password');
      mockPrismaService.user.create.mockResolvedValue({
        id: 'user_123',
        email: 'test@example.com',
        role: Role.STUDENT,
        createdAt: new Date(),
      });

      const result = await service.register({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(result.id).toBe('user_123');
      expect(argon2.hash).toHaveBeenCalledWith('password123', { type: argon2.argon2id });
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('should throw ConflictException if email exists', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({ id: 'existing_user' });

      await expect(
        service.register({ email: 'test@example.com', password: 'password123' })
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('login', () => {
    it('should issue tokens for valid credentials', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user_123',
        email: 'test@example.com',
        passwordHash: 'hashed_password',
        role: Role.STUDENT,
      });
      (argon2.verify as jest.Mock).mockResolvedValue(true);

      const result = await service.login(
        { email: 'test@example.com', password: 'password123' },
        'corr_123'
      );

      expect(result.accessToken).toBe('mock_jwt_access_token');
      expect(result.refreshToken).toBeDefined();
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it('should throw UnauthorizedException for invalid email', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);

      await expect(
        service.login({ email: 'test@example.com', password: 'password123' }, 'corr_123')
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException for invalid password', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue({
        id: 'user_123',
        email: 'test@example.com',
        passwordHash: 'hashed_password',
        role: Role.STUDENT,
      });
      (argon2.verify as jest.Mock).mockResolvedValue(false);

      await expect(
        service.login({ email: 'test@example.com', password: 'password123' }, 'corr_123')
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe('refresh', () => {
    it('should rotate tokens if valid', async () => {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 1);

      mockPrismaService.refreshToken.findUnique.mockResolvedValue({
        id: 'token_123',
        userId: 'user_123',
        tokenHash: 'hashed_token',
        expiresAt,
        revokedAt: null,
        user: { id: 'user_123', role: Role.STUDENT },
      });

      const result = await service.refresh('raw_refresh_token', 'corr_123');

      expect(result.accessToken).toBe('mock_jwt_access_token');
      expect(result.refreshToken).toBeDefined();
      expect(prisma.refreshToken.update).toHaveBeenCalled();
    });

    it('should trigger reuse detection if token is already revoked', async () => {
      mockPrismaService.refreshToken.findUnique.mockResolvedValue({
        id: 'token_123',
        userId: 'user_123',
        tokenHash: 'hashed_token',
        expiresAt: new Date(),
        revokedAt: new Date(),
        user: { id: 'user_123', role: Role.STUDENT },
      });

      await expect(service.refresh('raw_refresh_token', 'corr_123')).rejects.toThrow(
        UnauthorizedException
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user_123' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'REFRESH_TOKEN_REUSE_DETECTED',
          }),
        })
      );
    });
  });
});
