'use client';

import { useState } from 'react';
import { apiClient } from '@/lib/api-client';

export default function LoginPage() {
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setLoading(true);

    try {
      if (isRegistering) {
        await apiClient.post('/auth/register', { email, password });
        setSuccess('Registration successful! You can now log in.');
        setIsRegistering(false);
        setPassword('');
      } else {
        const res = await apiClient.post('/auth/login', { email, password });
        const { accessToken, refreshToken } = res.data;
        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', refreshToken);
        setSuccess('Login successful! Redirecting...');
        
        setTimeout(() => {
          window.location.href = '/dashboard';
        }, 1500);
      }
    } catch (err: any) {
      const errMsg = err.response?.data?.error?.message || 'Something went wrong';
      setError(errMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex items-center justify-center min-h-screen bg-slate-950 overflow-hidden px-4">
      {/* Background gradients */}
      <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 bg-teal-600/10 rounded-full blur-3xl" />

      <div className="relative max-w-md w-full space-y-8 bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl p-8 shadow-2xl transition-all duration-300">
        <div className="text-center space-y-2">
          <div className="inline-flex p-3 bg-gradient-to-tr from-purple-500/10 to-teal-500/10 border border-slate-800 rounded-xl">
            <svg className="w-8 h-8 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <h2 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-purple-400 via-teal-400 to-emerald-400 bg-clip-text text-transparent">
            {isRegistering ? 'Create your Account' : 'AI Olympiad Exam'}
          </h2>
          <p className="text-sm text-slate-400">
            {isRegistering ? 'Register to access your exam session' : 'Log in to start your secure exam'}
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          {error && (
            <div className="bg-red-950/30 border border-red-800/50 rounded-xl p-3 text-sm text-red-400 text-center">
              {error}
            </div>
          )}
          {success && (
            <div className="bg-emerald-950/30 border border-emerald-800/50 rounded-xl p-3 text-sm text-emerald-400 text-center">
              {success}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-500/50 focus:border-teal-500 transition duration-150 text-sm"
                placeholder="you@example.com"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-300">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-teal-500/50 focus:border-teal-500 transition duration-150 text-sm"
                placeholder="••••••••"
              />
            </div>
          </div>

          <div>
            <button
              type="submit"
              disabled={loading}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-lg text-slate-950 bg-gradient-to-r from-purple-400 via-teal-400 to-emerald-400 hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-teal-500 transition duration-150 active:scale-[0.98] disabled:opacity-50"
            >
              {loading ? 'Processing...' : isRegistering ? 'Register' : 'Sign in'}
            </button>
          </div>

          <div className="text-center text-sm">
            <button
              type="button"
              onClick={() => {
                setIsRegistering(!isRegistering);
                setError(null);
                setSuccess(null);
              }}
              className="font-medium text-teal-400 hover:text-teal-300 transition duration-150"
            >
              {isRegistering ? 'Already have an account? Sign in' : "Don't have an account? Register"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
