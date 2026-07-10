import { IsString, IsNotEmpty, IsOptional, IsInt, Min, IsDateString, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class ExamQuestionRelationDto {
  @IsString()
  @IsNotEmpty()
  questionId: string;

  @IsInt()
  @Min(0)
  order: number;

  @IsInt()
  @Min(0)
  points: number;
}

export class CreateExamDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsDateString()
  startsAt: string;

  @IsDateString()
  endsAt: string;

  @IsInt()
  @Min(1)
  durationMinutes: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExamQuestionRelationDto)
  questions: ExamQuestionRelationDto[];
}
