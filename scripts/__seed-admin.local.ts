/** THROWAWAY: local admin user for the calibration visual check. */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/mongodb';

async function main() {
  process.env.MONGODB_URI = 'mongodb://localhost:27017/cryptowithalgo';
  await connectDB();
  const users = mongoose.connection.collection('users');
  const email = 'local-admin@test.local';
  await users.deleteOne({ email });
  await users.insertOne({
    name: 'Local Admin',
    email,
    password: await bcrypt.hash('LocalAdmin123!', 10),
    emailVerified: new Date(),
    tosAcceptedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log('admin ready:', email);
  await mongoose.disconnect();
}
main();
