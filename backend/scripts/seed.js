// Seeds the initial routing configuration and demo user (idempotent).
require('dotenv').config();
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed the development demo user in production.');
  process.exit(1);
}
const { connectDb, disconnectDb } = require('../db');
const manager = require('../config/manager');
const { User } = require('../models');

(async () => {
  await connectDb();
  const config = await manager.seedIfEmpty();
  console.log(`Active configuration: v${config.version}`);
  const username = process.env.DEMO_USER || 'admin';
  const password = process.env.DEMO_PASSWORD || 'admin123';
  const exists = await User.findOne({ username });
  if (!exists) {
    await User.create({ username, password, role: 'student' });
    console.log(`Seeded demo user: ${username}`);
  } else {
    console.log(`Demo user exists: ${username}`);
  }
  await disconnectDb();
  process.exit(0);
})().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
