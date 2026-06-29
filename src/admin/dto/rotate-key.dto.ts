import { IsString, IsNotEmpty, MinLength } from 'class-validator';

export class RotateKeyDto {
  @IsString()
  @IsNotEmpty()
  provider: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  newValue: string;
}
