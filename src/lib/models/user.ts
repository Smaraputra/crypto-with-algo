import mongoose, { Schema, type Document } from 'mongoose';

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  image?: string;
  emailVerified?: Date;
  tosAcceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String },
    image: { type: String },
    emailVerified: { type: Date },
    tosAcceptedAt: { type: Date },
  },
  { timestamps: true }
);

export const User =
  mongoose.models.User || mongoose.model<IUser>('User', userSchema);
