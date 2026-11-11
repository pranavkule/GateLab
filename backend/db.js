require('dotenv').config();
const mongoose = require('mongoose');

async function connectDb(uri) {
  const mongoUri = uri || process.env.MONGO_URI || 'mongodb://localhost:27017/edgegate';
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

module.exports = { connectDb, disconnectDb, mongoose };
