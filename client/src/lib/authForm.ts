export type AuthMode = 'login' | 'register';

export type AuthField = 'displayName' | 'email' | 'password' | 'confirmPassword';

export type AuthValidationError =
  | 'displayNameRequired'
  | 'displayNameTooLong'
  | 'emailRequired'
  | 'emailInvalid'
  | 'passwordRequired'
  | 'passwordTooShort'
  | 'passwordTooLong'
  | 'confirmPasswordRequired'
  | 'passwordMismatch';

export interface AuthFormValues {
  displayName: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export type AuthFormErrors = Partial<Record<AuthField, AuthValidationError>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_FIELD_ORDER: readonly AuthField[] = ['email', 'password'];
const REGISTER_FIELD_ORDER: readonly AuthField[] = [
  'displayName',
  'email',
  'password',
  'confirmPassword',
];

export const getAuthTabForKey = (
  currentMode: AuthMode,
  key: string,
): AuthMode | null => {
  if (key === 'Home') return 'login';
  if (key === 'End') return 'register';
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    return currentMode === 'login' ? 'register' : 'login';
  }
  return null;
};

export const getAuthFieldOrder = (mode: AuthMode) => (
  mode === 'register' ? REGISTER_FIELD_ORDER : LOGIN_FIELD_ORDER
);

export const getFirstInvalidAuthField = (
  mode: AuthMode,
  errors: AuthFormErrors,
) => getAuthFieldOrder(mode).find((field) => errors[field]) ?? null;

export const validateAuthForm = (
  mode: AuthMode,
  values: AuthFormValues,
): AuthFormErrors => {
  const errors: AuthFormErrors = {};
  const email = values.email.trim();

  if (mode === 'register') {
    const displayName = values.displayName.trim();
    if (!displayName) errors.displayName = 'displayNameRequired';
    else if (displayName.length > 120) errors.displayName = 'displayNameTooLong';
  }

  if (!email) errors.email = 'emailRequired';
  else if (!EMAIL_PATTERN.test(email) || email.length > 254) errors.email = 'emailInvalid';

  if (!values.password) errors.password = 'passwordRequired';
  else if (values.password.length < 8) errors.password = 'passwordTooShort';
  else if (values.password.length > 128) errors.password = 'passwordTooLong';

  if (mode === 'register') {
    if (!values.confirmPassword) errors.confirmPassword = 'confirmPasswordRequired';
    else if (values.confirmPassword !== values.password) {
      errors.confirmPassword = 'passwordMismatch';
    }
  }

  return errors;
};
