import { IsString, Matches, MinLength } from 'class-validator';

export class LoginDto {
  @IsString()
  @Matches(/^[A-Za-z0-9]+$/, {
    message: 'Employee ID must contain only letters and numbers.',
  })
  employeeId!: string;

  @IsString()
  @MinLength(4)
  @Matches(/^[A-Za-z0-9]+$/, {
    message: 'Password must contain only letters and numbers.',
  })
  password!: string;
}
