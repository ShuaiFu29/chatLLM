import {
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { TFunction } from 'i18next';
import {
  Eye,
  EyeOff,
  Github,
  Loader2,
  LockKeyhole,
  Mail,
  UserRound,
} from 'lucide-react';
import Navigate from '../components/Navigate';
import { useTranslation } from 'react-i18next';
import {
  getAuthFieldOrder,
  getAuthTabForKey,
  getFirstInvalidAuthField,
  validateAuthForm,
  type AuthField,
  type AuthFormErrors,
  type AuthMode,
  type AuthValidationError,
} from '../lib/authForm';
import { toSafeError } from '../lib/safeError';
import { useAuthStore } from '../stores/useAuthStore';

const inputClassName = 'h-11 w-full rounded-xl border border-border bg-bg-base/70 pl-10 pr-11 text-sm text-text-main outline-none transition placeholder:text-text-muted/70 focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60';

const getValidationMessage = (error: AuthValidationError, t: TFunction) => {
  switch (error) {
    case 'displayNameRequired': return t('auth.errors.displayNameRequired');
    case 'displayNameTooLong': return t('auth.errors.displayNameTooLong');
    case 'emailRequired': return t('auth.errors.emailRequired');
    case 'emailInvalid': return t('auth.errors.emailInvalid');
    case 'passwordRequired': return t('auth.errors.passwordRequired');
    case 'passwordTooShort': return t('auth.errors.passwordTooShort');
    case 'passwordTooLong': return t('auth.errors.passwordTooLong');
    case 'confirmPasswordRequired': return t('auth.errors.confirmPasswordRequired');
    case 'passwordMismatch': return t('auth.errors.passwordMismatch');
  }
};

const getRequestErrorMessage = (mode: AuthMode, error: unknown, t: TFunction) => {
  const { status } = toSafeError(error);
  if (status === 429) return t('auth.errors.tooManyAttempts');
  if (mode === 'register' && status === 409) return t('auth.errors.emailAlreadyUsed');
  if (mode === 'login' && (status === 400 || status === 401)) {
    return t('auth.errors.invalidCredentials');
  }
  return mode === 'register'
    ? t('auth.errors.registerFailed')
    : t('auth.errors.loginFailed');
};

interface PasswordFieldProps {
  autoComplete: 'current-password' | 'new-password';
  disabled: boolean;
  error?: string;
  id: string;
  inputRef: (element: HTMLInputElement | null) => void;
  label: string;
  onChange: (value: string) => void;
  placeholder: string;
  value: string;
}

function PasswordField({
  autoComplete,
  disabled,
  error,
  id,
  inputRef,
  label,
  onChange,
  placeholder,
  value,
}: PasswordFieldProps) {
  const [isVisible, setIsVisible] = useState(false);
  const { t } = useTranslation();
  const errorId = `${id}-error`;

  return (
    <div className="space-y-1.5">
      <label className="block text-left text-sm font-medium text-text-main" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <LockKeyhole aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          ref={inputRef}
          id={id}
          type={isVisible ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          minLength={8}
          maxLength={128}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={inputClassName}
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setIsVisible((visible) => !visible)}
          disabled={disabled}
          aria-label={isVisible ? t('auth.hidePassword') : t('auth.showPassword')}
          aria-pressed={isVisible}
          className="absolute right-2.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-text-muted transition-colors hover:bg-bg-surface hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isVisible
            ? <EyeOff aria-hidden="true" className="h-4 w-4" />
            : <Eye aria-hidden="true" className="h-4 w-4" />}
        </button>
      </div>
      {error ? <p id={errorId} className="text-left text-xs text-red-300">{error}</p> : null}
    </div>
  );
}

export default function LoginPage() {
  const loginWithPassword = useAuthStore((state) => state.loginWithPassword);
  const register = useAuthStore((state) => state.register);
  const loginWithGithub = useAuthStore((state) => state.loginWithGithub);
  const user = useAuthStore((state) => state.user);
  const loading = useAuthStore((state) => state.loading);
  const { t } = useTranslation();
  const [mode, setMode] = useState<AuthMode>('login');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<AuthFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const tabRefs = useRef<Record<AuthMode, HTMLButtonElement | null>>({
    login: null,
    register: null,
  });
  const fieldRefs = useRef<Record<AuthField, HTMLInputElement | null>>({
    displayName: null,
    email: null,
    password: null,
    confirmPassword: null,
  });

  const clearFieldError = (field: AuthField) => {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
    setSubmitError(null);
  };

  const changeMode = (nextMode: AuthMode) => {
    if (nextMode === mode || isSubmitting) return;
    setMode(nextMode);
    setPassword('');
    setConfirmPassword('');
    setFieldErrors({});
    setSubmitError(null);
  };

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentMode: AuthMode,
  ) => {
    const nextMode = getAuthTabForKey(currentMode, event.key);
    if (!nextMode) return;
    event.preventDefault();
    changeMode(nextMode);
    tabRefs.current[nextMode]?.focus();
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting) return;

    const values = { displayName, email, password, confirmPassword };
    const validationErrors = validateAuthForm(mode, values);
    setFieldErrors(validationErrors);
    setSubmitError(null);
    const firstInvalidField = getFirstInvalidAuthField(mode, validationErrors);
    if (firstInvalidField) {
      fieldRefs.current[firstInvalidField]?.focus();
      return;
    }

    setIsSubmitting(true);
    try {
      const normalizedEmail = email.trim().toLowerCase();
      if (mode === 'register') {
        await register({
          displayName: displayName.trim(),
          email: normalizedEmail,
          password,
          rememberMe,
        });
      } else {
        await loginWithPassword({ email: normalizedEmail, password, rememberMe });
      }
    } catch (error: unknown) {
      setSubmitError(getRequestErrorMessage(mode, error, t));
    } finally {
      setIsSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg-base text-text-muted" role="status">
        <Loader2 aria-hidden="true" className="mr-2 h-5 w-5 animate-spin text-primary" />
        {t('common.loading')}
      </div>
    );
  }
  if (user) return <Navigate to="/" replace />;

  const fieldErrorMessage = (field: AuthField) => {
    const error = fieldErrors[field];
    return error ? getValidationMessage(error, t) : undefined;
  };
  const validationMessages = getAuthFieldOrder(mode).flatMap((field) => {
    const message = fieldErrorMessage(field);
    return message ? [{ field, message }] : [];
  });

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg-base px-4 py-8 transition-colors duration-300 sm:py-12">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.14),transparent_42%),radial-gradient(circle_at_bottom_right,rgba(99,102,241,0.1),transparent_38%)]" />
      <section className="relative w-full max-w-md rounded-2xl border border-border bg-bg-sidebar/95 p-5 shadow-2xl backdrop-blur sm:p-8" aria-labelledby="auth-title">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-primary text-lg font-bold text-white shadow-lg shadow-primary/20">
            C
          </div>
          <h1 id="auth-title" className="text-3xl font-bold tracking-tight text-text-main">
            {t('auth.loginTitle')}
          </h1>
          <p className="mt-2 text-sm text-text-muted">{t('auth.loginSubtitle')}</p>
        </div>

        <div className="mb-6 grid grid-cols-2 rounded-xl border border-border bg-bg-base/70 p-1" role="tablist" aria-label={t('auth.accountAccess')}>
          {(['login', 'register'] as const).map((tabMode) => (
            <button
              key={tabMode}
              ref={(element) => { tabRefs.current[tabMode] = element; }}
              id={`auth-${tabMode}-tab`}
              type="button"
              role="tab"
              aria-selected={mode === tabMode}
              aria-controls="auth-form-panel"
              tabIndex={mode === tabMode ? 0 : -1}
              disabled={isSubmitting}
              onClick={() => changeMode(tabMode)}
              onKeyDown={(event) => handleTabKeyDown(event, tabMode)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${
                mode === tabMode
                  ? 'bg-bg-surface text-text-main shadow-sm'
                  : 'text-text-muted hover:text-text-main'
              }`}
            >
              {tabMode === 'login' ? t('auth.loginTab') : t('auth.registerTab')}
            </button>
          ))}
        </div>

        <div
          id="auth-form-panel"
          role="tabpanel"
          aria-labelledby={`auth-${mode}-tab`}
        >
          <form className="space-y-4" noValidate onSubmit={handleSubmit}>
            {validationMessages.length > 0 ? (
              <div
                id="auth-validation-summary"
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
                className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-left text-sm text-red-300"
              >
                <p className="font-medium">{t('auth.validationSummary')}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                  {validationMessages.map(({ field, message }) => (
                    <li key={field}>{message}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {mode === 'register' ? (
              <div className="space-y-1.5">
                <label className="block text-left text-sm font-medium text-text-main" htmlFor="auth-display-name">
                  {t('auth.displayName')}
                </label>
                <div className="relative">
                  <UserRound aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                  <input
                    ref={(element) => { fieldRefs.current.displayName = element; }}
                    id="auth-display-name"
                    type="text"
                    value={displayName}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                      clearFieldError('displayName');
                    }}
                    autoComplete="name"
                    maxLength={120}
                    disabled={isSubmitting}
                    aria-invalid={Boolean(fieldErrors.displayName)}
                    aria-describedby={fieldErrors.displayName ? 'auth-display-name-error' : undefined}
                    className={`${inputClassName} pr-4`}
                    placeholder={t('auth.displayNamePlaceholder')}
                  />
                </div>
                {fieldErrors.displayName ? (
                  <p id="auth-display-name-error" className="text-left text-xs text-red-300">
                    {fieldErrorMessage('displayName')}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label className="block text-left text-sm font-medium text-text-main" htmlFor="auth-email">
                {t('auth.email')}
              </label>
              <div className="relative">
                <Mail aria-hidden="true" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                <input
                  ref={(element) => { fieldRefs.current.email = element; }}
                  id="auth-email"
                  type="email"
                  inputMode="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    clearFieldError('email');
                  }}
                  autoComplete="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={254}
                  disabled={isSubmitting}
                  aria-invalid={Boolean(fieldErrors.email)}
                  aria-describedby={fieldErrors.email ? 'auth-email-error' : undefined}
                  className={`${inputClassName} pr-4`}
                  placeholder={t('auth.emailPlaceholder')}
                />
              </div>
              {fieldErrors.email ? (
                <p id="auth-email-error" className="text-left text-xs text-red-300">
                  {fieldErrorMessage('email')}
                </p>
              ) : null}
            </div>

            <PasswordField
              key={`auth-password-${mode}`}
              id="auth-password"
              inputRef={(element) => { fieldRefs.current.password = element; }}
              label={t('auth.password')}
              placeholder={t('auth.passwordPlaceholder')}
              value={password}
              onChange={(value) => {
                setPassword(value);
                clearFieldError('password');
                if (fieldErrors.confirmPassword) clearFieldError('confirmPassword');
              }}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              disabled={isSubmitting}
              error={fieldErrorMessage('password')}
            />

            {mode === 'register' ? (
              <PasswordField
                id="auth-confirm-password"
                inputRef={(element) => { fieldRefs.current.confirmPassword = element; }}
                label={t('auth.confirmPassword')}
                placeholder={t('auth.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(value) => {
                  setConfirmPassword(value);
                  clearFieldError('confirmPassword');
                }}
                autoComplete="new-password"
                disabled={isSubmitting}
                error={fieldErrorMessage('confirmPassword')}
              />
            ) : null}

            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-transparent p-1 text-left transition-colors hover:border-border hover:bg-bg-base/40">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
                disabled={isSubmitting}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-border bg-bg-base accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed"
              />
              <span>
                <span className="block text-sm font-medium text-text-main">{t('auth.rememberSevenDays')}</span>
                <span className="mt-0.5 block text-xs leading-5 text-text-muted">{t('auth.rememberHint')}</span>
              </span>
            </label>

            {submitError ? (
              <div
                role="alert"
                aria-live="assertive"
                aria-atomic="true"
                className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-left text-sm text-red-300"
              >
                {submitError}
              </div>
            ) : null}

            <button
              type="submit"
              data-testid="auth-submit"
              disabled={isSubmitting}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-white shadow-lg shadow-primary/15 transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-sidebar disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
              {isSubmitting
                ? t('auth.submitting')
                : mode === 'login' ? t('auth.loginAction') : t('auth.registerAction')}
            </button>
          </form>

          <div className="my-5 flex items-center gap-3" aria-hidden="true">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-text-muted">{t('auth.or')}</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <button
            type="button"
            onClick={() => loginWithGithub(rememberMe)}
            disabled={isSubmitting}
            className="flex h-11 w-full items-center justify-center gap-3 rounded-xl border border-border bg-bg-surface text-sm font-semibold text-text-main transition-colors hover:border-primary hover:bg-bg-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Github aria-hidden="true" className="h-5 w-5" />
            {t('auth.continueWithGithub')}
          </button>

          <p className="mt-5 text-center text-xs leading-5 text-text-muted">
            {t('auth.agreement')}
          </p>
        </div>
      </section>
    </main>
  );
}
