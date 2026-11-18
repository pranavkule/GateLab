require('dotenv').config();

const { connectDb, disconnectDb } = require('../db');
const { User } = require('../models');
const { hashPassword } = require('../utils/password');

async function inventory() {
  const plaintext = await User.countDocuments({
    role: 'student',
    password: { $exists: true, $nin: [null, ''] },
    $or: [{ passwordHash: { $exists: false } }, { passwordHash: null }, { passwordHash: '' }],
  });
  const migrated = await User.countDocuments({
    role: 'student',
    passwordHash: { $type: 'string', $ne: '' },
  });
  return { plaintext, migrated };
}

async function migrateStudentPasswords() {
  const records = await User.find({
    role: 'student',
    password: { $exists: true, $nin: [null, ''] },
    $or: [{ passwordHash: { $exists: false } }, { passwordHash: null }, { passwordHash: '' }],
  }).select('_id password').lean();

  let converted = 0;
  for (const record of records) {
    if (typeof record.password !== 'string' || record.password.length === 0) continue;
    const passwordHash = await hashPassword(record.password);
    const result = await User.updateOne(
      {
        _id: record._id,
        passwordHash: { $in: [null, ''] },
        $or: [{ passwordHash: { $exists: false } }, { passwordHash: null }, { passwordHash: '' }],
      },
      { $set: { passwordHash }, $unset: { password: '' } }
    );
    if (result.modifiedCount === 1) converted += 1;
  }
  return converted;
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to migrate student passwords in production');
  }
  await connectDb();
  const args = new Set(process.argv.slice(2));
  const migrate = args.has('--migrate');
  if (migrate) {
    const converted = await migrateStudentPasswords();
    console.log(`Student password migration: ${converted} converted`);
  } else {
    const counts = await inventory();
    console.log(`Student password inventory: ${counts.plaintext} plaintext, ${counts.migrated} migrated`);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Student password migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await disconnectDb(); } catch (_) {}
    });
}

module.exports = { inventory, migrateStudentPasswords };
