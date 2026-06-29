import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class SetKeyDto {
  @IsString()
  @IsNotEmpty()
  provider: string;  // e.g. "NVIDIA_49B_API_KEY"

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  value: string;     // Raw API key — encrypted before storage
}
