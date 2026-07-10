import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Req,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import { Request } from 'express';
import { ExamsService } from './exams.service';
import { CreateQuestionDto } from './dto/create-question.dto';
import { CreateExamDto } from './dto/create-exam.dto';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller()
export class ExamsController {
  constructor(private readonly examsService: ExamsService) {}

  // ==========================================
  // QUESTIONS CRUD (ADMIN ONLY)
  // ==========================================

  @Post('questions')
  @Roles(Role.ADMIN)
  async createQuestion(@Body() dto: CreateQuestionDto) {
    return this.examsService.createQuestion(dto);
  }

  @Get('questions')
  @Roles(Role.ADMIN)
  async listQuestions() {
    return this.examsService.listQuestions();
  }

  @Get('questions/:id')
  @Roles(Role.ADMIN)
  async getQuestion(@Param('id') id: string) {
    return this.examsService.getQuestion(id);
  }

  @Put('questions/:id')
  @Roles(Role.ADMIN)
  async updateQuestion(
    @Param('id') id: string,
    @Body() dto: CreateQuestionDto,
  ) {
    return this.examsService.updateQuestion(id, dto);
  }

  @Delete('questions/:id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteQuestion(@Param('id') id: string) {
    await this.examsService.deleteQuestion(id);
  }

  // ==========================================
  // EXAMS CRUD (ADMIN ONLY)
  // ==========================================

  @Post('exams')
  @Roles(Role.ADMIN)
  async createExam(@Body() dto: CreateExamDto, @Req() req: Request) {
    const adminId = (req.user as any).id;
    return this.examsService.createExam(dto, adminId);
  }

  @Get('exams')
  @Roles(Role.ADMIN, Role.PROCTOR)
  async listExams() {
    return this.examsService.listExams();
  }

  @Get('exams/:id')
  @Roles(Role.ADMIN, Role.PROCTOR)
  async getExam(@Param('id') id: string) {
    return this.examsService.getExam(id);
  }

  @Put('exams/:id')
  @Roles(Role.ADMIN)
  async updateExam(@Param('id') id: string, @Body() dto: CreateExamDto) {
    return this.examsService.updateExam(id, dto);
  }

  @Delete('exams/:id')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteExam(@Param('id') id: string) {
    await this.examsService.deleteExam(id);
  }

  // ==========================================
  // CANDIDATE SESSION ENDPOINTS
  // ==========================================

  @Post('exams/:id/start')
  @Roles(Role.STUDENT, Role.PROCTOR, Role.ADMIN)
  async startSession(@Param('id') examId: string, @Req() req: Request) {
    const userId = (req.user as any).id;
    return this.examsService.startExamSession(examId, userId);
  }

  @Get('exams/:id/session')
  @Roles(Role.STUDENT, Role.PROCTOR, Role.ADMIN)
  async getSession(@Param('id') examId: string, @Req() req: Request) {
    const userId = (req.user as any).id;
    const role = (req.user as any).role;
    return this.examsService.getExamSession(examId, userId, role);
  }
}
