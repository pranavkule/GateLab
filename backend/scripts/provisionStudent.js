require('dotenv').config();

const readline = require('readline');
const { connectDb, disconnectDb } = require('../db');
const { User } = require('../models');
const { hashPassword } = require('../utils/password');

const PRODUCTION_CONFIRMATION = 'PROVISION PRODUCTION STUDENT';

function promptProductionConfirmation() {
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error('Production confirmation requires an interactive terminal'));
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    terminal.question(`Type "${PRODUCTION_CONFIRMATION}" to continue: `, (answer) => {
      terminal.close();
      resolve(answer);
    });
  });
}

async function requireProductionConfirmation(isProduction, allowProduction, prompt = promptProductionConfirmation) {
  if (!isProduction) return;
  if (!allowProduction) {
    throw new Error('Production student provisioning requires the --allow-production flag');
  }
  if ((await prompt()).trim() !== PRODUCTION_CONFIRMATION) {
    throw new Error('Production provisioning confirmation did not match');
  }
}

function promptPassword(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Student password must be entered in an interactive terminal'));
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
        if (key === '\u0003') return finish(new Error('Student provisioning cancelled'));
        if (key === '\r' || key === '\n') return finish();
        if (key === '\u007f' || key === '\b') {
          value = value.slice(0, 1) ? value.slice(0, -1) : '';
          continue;
        }
        if (key >= ' ') value += key;
      }
    };
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

function validateStudent(username, password) {
  if (typeof username !== 'string' || username.trim().length < 3 || username.trim().length > 80) {
    throw new Error('Username must be 3-80 characters');
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new Error('Password must be 8-128 characters');
  }
  return username.trim();
}

async function provisionStudent(username, password) {
  const normalizedUsername = validateStudent(username, password);
  const existing = await User.findOne({ username: normalizedUsername }).select('_id').lean();
  if (existing) throw new Error('Username already exists');
  const passwordHash = await hashPassword(password);
  await User.create({ username: normalizedUsername, passwordHash, role: 'student' });
  return normalizedUsername;
}

async function main() {
  const args = process.argv.slice(2);
  const allowProduction = args.includes('--allow-production');
  const usernames = args.filter((arg) => arg !== '--allow-production');
  if (usernames.length !== 1 || usernames[0].startsWith('--')) {
    throw new Error('Usage: npm run student:provision -- [--allow-production] <username>');
  }
  const username = usernames[0];
  validateStudent(username, 'placeholder-valid-password');
  await requireProductionConfirmation(process.env.NODE_ENV === 'production', allowProduction);
  await connectDb();
  const password = await promptPassword('Student password (hidden): ');
  await provisionStudent(username, password);
  console.log('Student account provisioned.');
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Student provisioning failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await disconnectDb(); } catch (_) {}
    });
}

module.exports = { provisionStudent, validateStudent, requireProductionConfirmation };
