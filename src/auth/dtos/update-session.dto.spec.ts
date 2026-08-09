import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSessionDto } from './update-session.dto';

describe('UpdateSessionDto', () => {
  it('trims a session name', async () => {
    const dto = plainToInstance(UpdateSessionDto, {
      sessionName: '  Personal phone  ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.sessionName).toBe('Personal phone');
  });

  it('accepts null to clear a session name', async () => {
    const dto = plainToInstance(UpdateSessionDto, { sessionName: null });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.sessionName).toBeNull();
  });

  it.each([
    {},
    { sessionName: '' },
    { sessionName: '   ' },
    { sessionName: 123 },
    { sessionName: 'a'.repeat(51) },
  ])('rejects an invalid session name: %p', async (value) => {
    const dto = plainToInstance(UpdateSessionDto, value);

    await expect(validate(dto)).resolves.not.toHaveLength(0);
  });
});
