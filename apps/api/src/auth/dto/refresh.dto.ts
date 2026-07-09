import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshDto {
  @IsString({ message: 'Refresh token must be a string' })
  @IsNotEmpty({ message: 'Refresh token is required' })
  refreshToken!: string;
}
