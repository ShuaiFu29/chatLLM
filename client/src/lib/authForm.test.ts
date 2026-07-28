import { describe, expect, test } from 'vitest';
import { validateAuthForm } from './authForm';

const validValues = {
  displayName: 'Ada',
  email: 'ada@example.com',
  password: 'correct horse',
  confirmPassword: 'correct horse',
};

describe('validateAuthForm', () => {
  test('accepts valid login and register values', () => {
    expect(validateAuthForm('login', validValues)).toEqual({});
    expect(validateAuthForm('register', validValues)).toEqual({});
  });

  test('requires registration-only fields and matching passwords', () => {
    expect(validateAuthForm('register', {
      ...validValues,
      displayName: ' ',
      confirmPassword: 'different password',
    })).toEqual({
      displayName: 'displayNameRequired',
      confirmPassword: 'passwordMismatch',
    });
  });

  test('validates email and password boundaries', () => {
    expect(validateAuthForm('login', {
      ...validValues,
      email: 'not-an-email',
      password: 'short',
    })).toEqual({
      email: 'emailInvalid',
      password: 'passwordTooShort',
    });

    expect(validateAuthForm('register', {
      ...validValues,
      displayName: 'a'.repeat(121),
      password: 'a'.repeat(129),
      confirmPassword: 'a'.repeat(129),
    })).toEqual({
      displayName: 'displayNameTooLong',
      password: 'passwordTooLong',
    });
  });
});
