import { useState } from 'react';
import { ArrowRight, AlertCircle } from 'lucide-react';
import type { CrmPlatform } from '../types/support';
import { SUPPORTED_LANGUAGES } from '../lib/language';
import backdropImage from '../assets/images/meridian_signup_backdrop_1794670382165.jpg';

export interface CustomerIntakeData {
  displayName: string;
  email: string;
  company: string;
  preferredLanguage: string;
  targetPlatform: CrmPlatform;
}

interface SignUpGateProps {
  onCompleteSignUp: (data: CustomerIntakeData) => void;
  onGoogleSignIn: (draftProfile?: Partial<CustomerIntakeData>) => Promise<void>;
  isSigningIn: boolean;
  authReady: boolean;
  errorMessage: string | null;
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 shrink-0">
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
      />
    </svg>
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignUpGate({
  onCompleteSignUp,
  onGoogleSignIn,
  isSigningIn,
  authReady,
  errorMessage,
}: SignUpGateProps) {
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [preferredLanguage, setPreferredLanguage] = useState('auto');
  const [targetPlatform, setTargetPlatform] = useState<CrmPlatform>('salesforce');
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = displayName.trim();
    const cleanEmail = email.trim();
    if (!cleanName) {
      setValidationError('Please enter your full name to continue.');
      return;
    }
    if (!EMAIL_PATTERN.test(cleanEmail)) {
      setValidationError('Please enter a valid Gmail or work email address.');
      return;
    }
    setValidationError(null);
    onCompleteSignUp({
      displayName: cleanName,
      email: cleanEmail,
      company: company.trim() || 'Personal Account',
      preferredLanguage,
      targetPlatform,
    });
  };

  const activeError = validationError || errorMessage;

  return (
    <div className="relative min-h-screen flex items-center justify-center bg-slate-950 px-4 py-10 sm:px-8 overflow-hidden">
      {/* Generated studio backdrop + fallback gradient & measured contrast scrim */}
      <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800">
        <img
          src={backdropImage}
          alt="Meridian Voice acoustic studio environment"
          referrerPolicy="no-referrer"
          className="h-full w-full object-cover opacity-55"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-slate-950/90 via-slate-950/75 to-slate-950/80" />
      </div>

      {/* Main Split Container */}
      <div className="relative z-10 w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-center">
        {/* Left: Workspace Overview */}
        <div className="lg:col-span-6 space-y-6 text-slate-100">
          <div className="text-sm font-bold tracking-tight text-white">
            Meridian Voice
          </div>

          <div className="space-y-3">
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-white leading-tight text-balance">
              Sign up to start your real-time Voice AI session
            </h1>
            <p className="text-sm sm:text-base text-slate-300 leading-relaxed max-w-lg">
              Enter your name and Gmail ID to launch the full-duplex Live Voice console. Speak or chat naturally in any language for instant answers, sentiment analysis, and CRM ticket triage.
            </p>
          </div>

          <div className="pt-2 border-t border-white/15 grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div>
              <div className="font-semibold text-white">Live Voice AI</div>
              <p className="mt-1 text-slate-300 leading-relaxed">
                Start talking via microphone or text right after sign up.
              </p>
            </div>
            <div>
              <div className="font-semibold text-white">Single-Language Lock</div>
              <p className="mt-1 text-slate-300 leading-relaxed">
                Replies stay in your chosen language until you ask to switch.
              </p>
            </div>
            <div>
              <div className="font-semibold text-white">CRM Auto-Tagging</div>
              <p className="mt-1 text-slate-300 leading-relaxed">
                Syncs Salesforce &amp; Zendesk priority tags automatically.
              </p>
            </div>
          </div>
        </div>

        {/* Right: Sign-Up Form Card */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-6 sm:p-8 text-slate-900">
          <div className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              Customer Sign Up
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Your details personalise the Live Voice session and saved CRM history.
            </p>
          </div>

          {activeError && (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2.5 px-3.5 py-2.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-800"
            >
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-red-600" />
              <span>{activeError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="signup-name"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Full Name
              </label>
              <input
                id="signup-name"
                type="text"
                autoComplete="name"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Nikhil Sinha"
                className="w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
              />
            </div>

            <div>
              <label
                htmlFor="signup-email"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Gmail ID / Email Address
              </label>
              <input
                id="signup-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="e.g. yourname@gmail.com"
                className="w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
              />
            </div>

            <div>
              <label
                htmlFor="signup-company"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Company or Account Name (optional)
              </label>
              <input
                id="signup-company"
                type="text"
                autoComplete="organization"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                placeholder="e.g. Acme Cloud Systems"
                className="w-full px-3.5 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label
                  htmlFor="signup-language"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  Preferred Language
                </label>
                <select
                  id="signup-language"
                  value={preferredLanguage}
                  onChange={(e) => setPreferredLanguage(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
                >
                  {SUPPORTED_LANGUAGES.map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="signup-crm"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  Target CRM Queue
                </label>
                <select
                  id="signup-crm"
                  value={targetPlatform}
                  onChange={(e) => setTargetPlatform(e.target.value as CrmPlatform)}
                  className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-600"
                >
                  <option value="salesforce">Salesforce Service Cloud</option>
                  <option value="zendesk">Zendesk Support</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              data-testid="signup-submit-button"
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 transition-colors whitespace-nowrap"
            >
              <span>Sign Up &amp; Start Live Voice</span>
              <ArrowRight className="h-4 w-4 shrink-0" />
            </button>
          </form>

          <div className="my-5 flex items-center gap-3 text-xs text-slate-400">
            <div className="h-px flex-1 bg-slate-200" />
            <span>or sign in with Google to sync history</span>
            <div className="h-px flex-1 bg-slate-200" />
          </div>

          <button
            type="button"
            disabled={!authReady || isSigningIn}
            onClick={() =>
              void onGoogleSignIn({
                displayName: displayName.trim() || undefined,
                company: company.trim() || undefined,
                preferredLanguage,
                targetPlatform,
              })
            }
            data-testid="gate-google-signin-button"
            className="w-full inline-flex items-center justify-center gap-2.5 px-4 py-2.5 text-sm font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            <GoogleMark />
            <span>
              {isSigningIn ? 'Connecting Google Account...' : 'Continue with Google'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
