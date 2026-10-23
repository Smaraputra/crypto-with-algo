import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export const registerSchema = z
  .object({
    name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Invalid email address'),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(
        /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/,
        'Password must contain at least one uppercase letter, one digit, and one special character'
      ),
    confirmPassword: z.string(),
    tosAccepted: z.literal(true, {
      message: 'You must accept the Terms of Service and Privacy Policy',
    }),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

export const resetSchema = z
  .object({
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .regex(
        /^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?])/,
        'Password must contain at least one uppercase letter, one digit, and one special character'
      ),
    confirm: z.string(),
  })
  .refine((data) => data.password === data.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

export function safeCallbackUrl(raw: string | null | undefined): string {
  if (
    typeof raw === 'string' &&
    raw.startsWith('/') &&
    !raw.startsWith('//') &&
    !raw.startsWith('/\\') &&
    !raw.includes('\\')
  ) {
    return raw;
  }
  return '/dashboard';
}
