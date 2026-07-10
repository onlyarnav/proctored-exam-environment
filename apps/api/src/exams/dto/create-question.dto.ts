import { IsEnum, IsString, IsNotEmpty, IsInt, Min, IsOptional, IsArray, IsObject, ValidateNested } from 'class-validator';
import { QuestionType } from '@prisma/client';
import { Type } from 'class-transformer';

export class McqOptionDto {
  @IsString()
  @IsNotEmpty()
  id: string;

  @IsString()
  @IsNotEmpty()
  text: string;
}

export class TestCaseDto {
  @IsString()
  input: string;

  @IsString()
  expectedOutput: string;

  @IsOptional()
  isPublic?: boolean = true;
}

export class CreateQuestionDto {
  @IsEnum(QuestionType)
  type: QuestionType;

  @IsString()
  @IsNotEmpty()
  prompt: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => McqOptionDto)
  options?: McqOptionDto[];

  @IsOptional()
  @IsString()
  correctOption?: string;

  @IsOptional()
  @IsObject()
  starterCode?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TestCaseDto)
  testCases?: TestCaseDto[];

  @IsInt()
  @Min(0)
  points: number;

  @IsOptional()
  @IsString()
  topic?: string;

  @IsOptional()
  @IsString()
  difficulty?: string;
}
