require('dotenv').config();

const readline = require('readline');
const { connectDb, disconnectDb } = require('../db');
const { UserProfile } = require('../models');
const { hashPassword } = require('../utils/password');

function prompt(label) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(label, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function promptPassword(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Administrator password must be entered in an interactive terminal'));
  }

  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error) => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const key of chunk.toString('utf8')) {
        if (key === '\u0003') return finish(new Error('Administrator provisioning cancelled'));
        if (key === '\r' || key === '\n') return finish();
        if (key === '\u007f' || key === '\b') {
          value = value.slice(0, -1);
          process.stdout.write('\b \b');
        } else if (key >= ' ') {
          value += key;
          process.stdout.write('*');
        }
      }
    };

    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

async function main() {
  const name = await prompt('Administrator name: ');
  const email = (await prompt('Administrator email: ')).toLowerCase();
  const password = await promptPassword('Administrator password (hidden): ');
  if (name.length < 2 || name.length > 80) throw new Error('Name must be 2-80 characters');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid administrator email');
  if (password.length < 12 || password.length > 128) throw new Error('Administrator password must be 12-128 characters');

  await connectDb();
  const existingAdmin = await UserProfile.findOne({ role: 'admin' }).select('_id').lean();
  if (existingAdmin) throw new Error('An administrator already exists; refusing to create or promote another account');
  const existingUser = await UserProfile.findOne({ email }).select('_id').lean();
  if (existingUser) throw new Error('That email is already registered; refusing to change its role');

  await UserProfile.create({
    name,
    email,
    passwordHash: await hashPassword(password),
    role: 'admin',
  });
  console.log(`Administrator provisioned for ${email}`);
}

main()
  .catch((error) => {
    console.error(`Administrator provisioning failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await disconnectDb(); } catch (_) {}
  });
