import { Injectable, UnauthorizedException, ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ErrorCode } from 'shared-types';
import * as argon2 from 'argon2';
import { randomBytes, createHash } from 'crypto';
import { Role } from '@prisma/client';

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  // Helper: Hash a string using SHA-256
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException({
        code: ErrorCode.EMAIL_ALREADY_EXISTS,
        message: 'A user with this email already exists',
      });
    }

    // Hash the password with argon2id (argon2id is the default mode for node-argon2)
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        role: Role.STUDENT, // default role
      },
    });

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async login(dto: LoginDto, correlationId: string) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      });
    }

    const isPasswordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      });
    }

    // Generate Tokens
    const accessToken = this.generateAccessToken(user.id, user.email, user.role, correlationId);
    const rawRefreshToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawRefreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiration

    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    // Write audit log
    await this.prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: 'USER_LOGIN',
        correlationId,
        metadata: { ip: 'localhost' },
      },
    });

    return {
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  async refresh(refreshToken: string, correlationId: string) {
    const tokenHash = this.hashToken(refreshToken);

    // Look up the refresh token row
    const existingToken = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!existingToken) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_TOKEN,
        message: 'Invalid refresh token',
      });
    }

    // REUSE DETECTION: If token is already revoked, revoke the entire token chain for the user
    if (existingToken.revokedAt || existingToken.expiresAt < new Date()) {
      // If it's expired but not revoked, we just throw expired.
      if (existingToken.expiresAt < new Date() && !existingToken.revokedAt) {
        throw new UnauthorizedException({
          code: ErrorCode.TOKEN_EXPIRED,
          message: 'Refresh token has expired',
        });
      }

      // It is revoked. This is a potential token reuse threat!
      await this.prisma.refreshToken.updateMany({
        where: { userId: existingToken.userId },
        data: { revokedAt: new Date() },
      });

      // Log the event
      await this.prisma.auditLog.create({
        data: {
          actorId: existingToken.userId,
          action: 'REFRESH_TOKEN_REUSE_DETECTED',
          correlationId,
          metadata: {
            tokenId: existingToken.id,
            tokenHash: existingToken.tokenHash,
          },
        },
      });

      this.logger.warn(
        JSON.stringify({
          message: 'Refresh token reuse detected. Revoking all tokens for user.',
          userId: existingToken.userId,
          correlationId,
        })
      );

      throw new UnauthorizedException({
        code: ErrorCode.REFRESH_TOKEN_REUSE_DETECTED,
        message: 'Security warning: Refresh token reuse detected. Please log in again.',
      });
    }

    // Token is valid. Rotate it.
    const user = existingToken.user;
    const newRawRefreshToken = randomBytes(32).toString('hex');
    const newHash = this.hashToken(newRawRefreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    // We do this in a database transaction to prevent concurrent race conditions
    const result = await this.prisma.$transaction(async (tx) => {
      // Re-read current token inside transaction to lock the row and check revoked status
      const tokenInTx = await tx.refreshToken.findUnique({
        where: { id: existingToken.id },
      });

      if (!tokenInTx || tokenInTx.revokedAt) {
        throw new UnauthorizedException({
          code: ErrorCode.INVALID_TOKEN,
          message: 'Refresh token invalid or already rotated',
        });
      }

      // Mark current token as revoked and replaced by the new one
      await tx.refreshToken.update({
        where: { id: existingToken.id },
        data: {
          revokedAt: new Date(),
          replacedBy: newHash,
        },
      });

      // Create new token
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: newHash,
          expiresAt,
        },
      });

      // Generate access token
      const accessToken = this.generateAccessToken(user.id, user.email, user.role, correlationId);

      return {
        accessToken,
        refreshToken: newRawRefreshToken,
      };
    });

    return result;
  }

  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    
    // Revoke the token
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date() },
    });
  }

  private generateAccessToken(userId: string, email: string, role: Role, correlationId: string): string {
    const payload = {
      sub: userId,
      email,
      role,
      correlationId,
    };
    return this.jwtService.sign(payload, {
      secret: process.env.JWT_ACCESS_SECRET || 'dev_access_secret_do_not_use_in_prod_1234567890',
      expiresIn: '15m',
    });
  }
}
