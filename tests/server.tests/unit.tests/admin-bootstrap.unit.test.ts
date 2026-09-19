import bcrypt from 'bcrypt';
import mongoose, { HydratedDocument } from 'mongoose';
import { IUserAccount } from '../../../common/user.interface';
import { MongoDB } from '../../../server/db/mongo.db';
import { INITIAL_ADMIN_PASSWORD } from '../../../server/env';

jest.mock('../../../server/env', () => ({
  INITIAL_ADMIN_PASSWORD: 'test-only bootstrap passphrase'
}));

describe('Initial administrator bootstrap', () => {
  const UserModel = mongoose.model<IUserAccount>('User');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('stores a hash of the configured password without logging it', async () => {
    jest.spyOn(UserModel, 'findOne').mockResolvedValue(null);
    const savedUsers: IUserAccount[] = [];
    jest.spyOn(UserModel.prototype, 'save').mockImplementation(async function (
      this: HydratedDocument<IUserAccount>
    ) {
      savedUsers.push(this.toObject());
      return this;
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await new MongoDB('mongodb://unused/test').seedDefaultAdmin();

    expect(savedUsers).toHaveLength(1);
    const admin = savedUsers[0];
    expect(admin.credentials.username).toBe('admin');
    expect(admin.privilegeLevel).toBe('Administrator');
    expect(
      await bcrypt.compare(INITIAL_ADMIN_PASSWORD, admin.credentials.password)
    ).toBe(true);
    expect(await bcrypt.compare('admin', admin.credentials.password)).toBe(
      false
    );
    expect(log.mock.calls.flat().join(' ')).not.toContain(
      INITIAL_ADMIN_PASSWORD
    );
    expect(log.mock.calls.flat().join(' ')).not.toContain('password:');
  });

  test('does not reset an existing administrator on restart', async () => {
    jest.spyOn(UserModel, 'findOne').mockResolvedValue({
      credentials: { username: 'admin', password: 'existing-password-hash' }
    });
    const save = jest.spyOn(UserModel.prototype, 'save');
    const hash = jest.spyOn(bcrypt, 'hash');
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await new MongoDB('mongodb://unused/test').seedDefaultAdmin();

    expect(hash).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
