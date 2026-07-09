import {
  Controller,
  Post,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  Get,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(@Body() loginDto: LoginDto, @Req() req: Request) {
    const correlationId = (req as any).correlationId || 'unknown';
    return this.authService.login(loginDto, correlationId);
  }

  @Public()
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  async refresh(@Body() refreshDto: RefreshDto, @Req() req: Request) {
    const correlationId = (req as any).correlationId || 'unknown';
    return this.authService.refresh(refreshDto.refreshToken, correlationId);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  async logout(@Body() refreshDto: RefreshDto) {
    await this.authService.logout(refreshDto.refreshToken);
  }

  // Stubs for verification and testing
  @Get('profile')
  @Roles(Role.STUDENT, Role.PROCTOR, Role.ADMIN)
  getProfile(@Req() req: Request) {
    return req.user;
  }

  @Get('admin-only')
  @Roles(Role.ADMIN)
  getAdminData(@Req() req: Request) {
    return { adminSecret: 'gridixa_olympiad_secrets', user: req.user };
  }
}
