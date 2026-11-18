const mockUser = {
  findOne: jest.fn(),
  create: jest.fn(),
  countDocuments: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
};

jest.mock('../backend/models', () => ({ User: mockUser }));
jest.mock('../backend/utils/password', () => ({
  hashPassword: jest.fn(async () => 'scrypt:hashed-password'),
  verifyPassword: jest.fn(async () => true),
}));

const {
  provisionStudent,
  validateStudent,
  requireProductionConfirmation,
} = require('../backend/scripts/provisionStudent');
const {
  inventory,
  migrateStudentPasswords,
} = require('../backend/scripts/migrateStudentPasswords');

describe('Student account utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('provisioning validates input and rejects duplicate usernames', async () => {
    expect(() => validateStudent('ab', 'long-enough-password')).toThrow(/Username/);
    expect(() => validateStudent('student1', 'short')).toThrow(/Password/);

    mockUser.findOne.mockReturnValue({
      select: () => ({ lean: async () => ({ _id: 'existing' }) }),
    });
    await expect(provisionStudent('student1', 'safe-password')).rejects.toThrow('Username already exists');
  });

  test('provisioning creates only hashed student accounts', async () => {
    mockUser.findOne.mockReturnValue({
      select: () => ({ lean: async () => null }),
    });
    mockUser.create.mockResolvedValue({});

    await expect(provisionStudent('student1', 'safe-password')).resolves.toBe('student1');
    expect(mockUser.create).toHaveBeenCalledWith({
      username: 'student1',
      passwordHash: 'scrypt:hashed-password',
      role: 'student',
    });
  });

  test('production provisioning requires the opt-in flag and exact interactive confirmation', async () => {
    const prompt = jest.fn().mockResolvedValue('PROVISION PRODUCTION STUDENT');
    await expect(requireProductionConfirmation(true, false, prompt)).rejects.toThrow('--allow-production');
    expect(prompt).not.toHaveBeenCalled();

    await expect(requireProductionConfirmation(true, true, async () => 'no')).rejects.toThrow('confirmation did not match');
    await expect(requireProductionConfirmation(true, true, prompt)).resolves.toBeUndefined();
    expect(prompt).toHaveBeenCalledTimes(1);
    await expect(requireProductionConfirmation(false, false, prompt)).resolves.toBeUndefined();
  });

  test('migration inventory reports plaintext and migrated counts', async () => {
    mockUser.countDocuments
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    await expect(inventory()).resolves.toEqual({ plaintext: 2, migrated: 3 });
  });

  test('migration converts plaintext records and is safe for already migrated records', async () => {
    mockUser.find.mockReturnValue({
      select: () => ({
        lean: async () => [
          { _id: 'one', password: 'first-secret' },
          { _id: 'two', password: 'second-secret' },
        ],
      }),
    });
    mockUser.updateOne.mockResolvedValue({ modifiedCount: 1 });

    await expect(migrateStudentPasswords()).resolves.toBe(2);
    expect(mockUser.updateOne).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockUser.updateOne.mock.calls)).not.toContain('first-secret');
    expect(JSON.stringify(mockUser.updateOne.mock.calls)).not.toContain('second-secret');

    mockUser.find.mockReturnValue({
      select: () => ({ lean: async () => [] }),
    });
    await expect(migrateStudentPasswords()).resolves.toBe(0);
  });
});
