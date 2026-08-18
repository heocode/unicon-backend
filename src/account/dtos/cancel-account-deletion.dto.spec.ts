import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CancelAccountDeletionDto } from './cancel-account-deletion.dto';

describe('CancelAccountDeletionDto', () => {
  it('normalizes the email and accepts a non-empty password', async () => {
    const dto = plainToInstance(CancelAccountDeletionDto, {
      email: '  Student@College.CA ',
      currentPassword: 'CurrentPassword1!',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.email).toBe('student@college.ca');
  });

  it.each([
    {},
    { email: 'not-an-email', currentPassword: 'Password1!' },
    { email: 'student@college.ca', currentPassword: '' },
    { email: 'student@college.ca', currentPassword: 123 },
  ])('rejects invalid input %#', async (input) => {
    const dto = plainToInstance(CancelAccountDeletionDto, input);

    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});
