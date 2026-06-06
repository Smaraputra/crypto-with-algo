import mongoose, { Schema, type Document, type Types } from 'mongoose';

export type AuthTokenType = 'verify' | 'reset';

export interface IAuthToken extends Document {
  userId: Types.ObjectId;
  type: AuthTokenType;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const authTokenSchema = new Schema<IAuthToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ['verify', 'reset'], required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

authTokenSchema.index({ tokenHash: 1 });
authTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthToken =
  mongoose.models.AuthToken ||
  mongoose.model<IAuthToken>('AuthToken', authTokenSchema);
