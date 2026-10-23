import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  registerSchema,
  resetSchema,
  safeCallbackUrl,
} from './schemas';

describe('safeCallbackUrl', () => {
  it('keeps allowed same-site paths', () => {
    expect(safeCallbackUrl('/portfolio?tab=performance')).toBe('/portfolio?tab=performance');
    expect(safeCallbackUrl('/dashboard')).toBe('/dashboard');
  });

  it('rejects off-site and malformed urls returning /dashboard', () => {
    expect(safeCallbackUrl('https://evil.example')).toBe('/dashboard');
    expect(safeCallbackUrl('//evil.example')).toBe('/dashboard');
    expect(safeCallbackUrl('/\\evil.example')).toBe('/dashboard');
    expect(safeCallbackUrl('javascript:alert(1)')).toBe('/dashboard');
    expect(safeCallbackUrl(null)).toBe('/dashboard');
    expect(safeCallbackUrl('')).toBe('/dashboard');
    expect(safeCallbackUrl(undefined)).toBe('/dashboard');
    expect(safeCallbackUrl('/path\\with\\backslash')).toBe('/dashboard');
  });
});

describe('loginSchema', () => {
  it('accepts valid credentials', () => {
    const result = loginSchema.safeParse({
      email: 'user@example.com',
      password: 'password123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid email with representative message', () => {
    const result = loginSchema.safeParse({
      email: 'not-an-email',
      password: 'password123',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Invalid email address');
    }
  });

  it('rejects short password with representative message', () => {
    const result = loginSchema.safeParse({
      email: 'user@example.com',
      password: '123',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Password must be at least 6 characters'
      );
    }
  });
});

describe('registerSchema', () => {
  const validData = {
    name: 'Jane Doe',
    email: 'jane@example.com',
    password: 'Secret123!',
    confirmPassword: 'Secret123!',
    tosAccepted: true,
  };

  it('accepts valid registration data', () => {
    const result = registerSchema.safeParse(validData);
    expect(result.success).toBe(true);
  });

  it('rejects short name with representative message', () => {
    const result = registerSchema.safeParse({
      ...validData,
      name: 'A',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Name must be at least 2 characters'
      );
    }
  });

  it('rejects invalid email with representative message', () => {
    const result = registerSchema.safeParse({
      ...validData,
      email: 'invalid-email',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Invalid email address');
    }
  });

  it('rejects weak password with representative message', () => {
    const result = registerSchema.safeParse({
      ...validData,
      password: 'weakpassword',
      confirmPassword: 'weakpassword',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Password must contain at least one uppercase letter, one digit, and one special character'
      );
    }
  });

  it('rejects password mismatch with representative message', () => {
    const result = registerSchema.safeParse({
      ...validData,
      confirmPassword: 'MismatchPassword123!',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Passwords do not match');
    }
  });

  it('rejects unaccepted terms with representative message', () => {
    const result = registerSchema.safeParse({
      ...validData,
      tosAccepted: false,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'You must accept the Terms of Service and Privacy Policy'
      );
    }
  });
});

describe('resetSchema', () => {
  const validReset = {
    password: 'NewPassword123!',
    confirm: 'NewPassword123!',
  };

  it('accepts valid password reset data', () => {
    const result = resetSchema.safeParse(validReset);
    expect(result.success).toBe(true);
  });

  it('rejects weak password with representative message', () => {
    const result = resetSchema.safeParse({
      password: 'passwordonly',
      confirm: 'passwordonly',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Password must contain at least one uppercase letter, one digit, and one special character'
      );
    }
  });

  it('rejects mismatched passwords with representative message', () => {
    const result = resetSchema.safeParse({
      password: 'NewPassword123!',
      confirm: 'DifferentPassword123!',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Passwords do not match');
    }
  });
});
