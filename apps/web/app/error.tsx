'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log exception to standard console tracing
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-950 p-6">
      <div className="max-w-md w-full text-center space-y-6 bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-950/50 text-red-400 border border-red-800/60">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        
        <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-red-400 to-orange-400 bg-clip-text text-transparent">
          Something went wrong
        </h1>
        
        <p className="text-sm text-slate-400">
          An unexpected error occurred in the application. Tracing logs have been recorded for audit.
        </p>
        
        {error.message && (
          <div className="bg-slate-950 rounded-lg p-3 text-xs font-mono text-red-400 border border-slate-800/80 max-h-32 overflow-auto text-left">
            {error.message}
          </div>
        )}
        
        <div className="flex gap-4">
          <button
            onClick={() => reset()}
            className="flex-1 px-4 py-2 text-sm font-medium text-slate-100 bg-slate-800 hover:bg-slate-700 active:bg-slate-900 rounded-lg border border-slate-700 transition duration-150"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.href = '/login'}
            className="flex-1 px-4 py-2 text-sm font-medium text-slate-950 bg-gradient-to-r from-teal-400 to-emerald-400 hover:from-teal-300 hover:to-emerald-300 rounded-lg transition duration-150 shadow-md"
          >
            Return to Login
          </button>
        </div>
      </div>
    </div>
  );
}
