import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RequestAccountDeletionDto } from './request-account-deletion.dto';

describe('RequestAccountDeletionDto', () => {
  it('accepts a non-empty current password', async () => {
    const dto = plainToInstance(RequestAccountDeletionDto, {
      currentPassword: 'CurrentPassword1!',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([{}, { currentPassword: '' }, { currentPassword: 123 }])(
    'rejects invalid input %#',
    async (input) => {
      const dto = plainToInstance(RequestAccountDeletionDto, input);

      await expect(validate(dto)).resolves.not.toHaveLength(0);
    },
  );
});
