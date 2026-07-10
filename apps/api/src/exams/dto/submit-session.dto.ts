import { IsString, IsOptional } from 'class-validator';

export class SubmitSessionDto {
  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
