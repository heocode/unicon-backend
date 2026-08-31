import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RegisterDto } from './register.dto';

describe('RegisterDto', () => {
  it('normalizes the email and accepts one strong password field', async () => {
    const dto = plainToInstance(RegisterDto, {
      email: ' Student@University.ca ',
      password: 'Password1!',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto.email).toBe('student@university.ca');
    expect(dto).not.toHaveProperty('confirmedPassword');
  });

  it('requires lowercase, uppercase, number, symbol, and eight characters', async () => {
    const passwords = [
      'PASSWORD1!',
      'password1!',
      'Password!',
      'Password1',
      'Pass1!',
    ];

    for (const password of passwords) {
      const dto = plainToInstance(RegisterDto, {
        email: 'student@university.ca',
        password,
      });
      const errors = await validate(dto);
      const passwordError = errors.find(
        (error) => error.property === 'password',
      );

      expect(passwordError?.constraints?.isStrongPassword).toBe(
        'Password must be at least 8 characters long and contain at least one lowercase letter, one uppercase letter, one number, and one special character.',
      );
    }
  });
});
