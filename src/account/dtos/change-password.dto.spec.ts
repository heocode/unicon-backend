import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ChangePasswordDto } from './change-password.dto';

describe('ChangePasswordDto', () => {
  it('accepts current credentials and a strong new password', async () => {
    const dto = plainToInstance(ChangePasswordDto, {
      currentPassword: 'CurrentPassword1!',
      newPassword: 'NewPassword2!',
      confirmNewPassword: 'NewPassword2!',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it('rejects a weak new password', async () => {
    const dto = plainToInstance(ChangePasswordDto, {
      currentPassword: 'CurrentPassword1!',
      newPassword: 'weak',
      confirmNewPassword: 'weak',
    });

    const errors = await validate(dto);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'newPassword' }),
      ]),
    );
  });

  it('requires all three fields', async () => {
    const dto = plainToInstance(ChangePasswordDto, {});

    const errors = await validate(dto);

    expect(errors.map(({ property }) => property).sort()).toEqual([
      'confirmNewPassword',
      'currentPassword',
      'newPassword',
    ]);
  });
});
