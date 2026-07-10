'use client';

export default function ExamSuccessPage() {
  return (
    <div className="relative flex items-center justify-center min-h-screen bg-slate-950 overflow-hidden px-4 text-slate-100">
      {/* Background gradients */}
      <div className="absolute top-1/4 left-1/4 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" />
      <div className="absolute bottom-1/4 right-1/4 translate-x-1/2 translate-y-1/2 w-96 h-96 bg-teal-600/10 rounded-full blur-3xl" />

      <div className="relative max-w-md w-full space-y-6 bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl p-8 shadow-2xl text-center">
        <div className="inline-flex p-4 bg-emerald-500/10 border border-emerald-800/30 rounded-full text-emerald-400">
          <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>

        <div className="space-y-2">
          <h2 className="text-3xl font-extrabold tracking-tight bg-gradient-to-r from-purple-400 via-teal-400 to-emerald-400 bg-clip-text text-transparent">
            Exam Submitted!
          </h2>
          <p className="text-slate-400 text-sm leading-relaxed">
            Thank you for completing the exam. Your submissions have been securely uploaded, and the auto-grading pipeline has been triggered.
          </p>
        </div>

        <div className="pt-4">
          <button
            onClick={() => (window.location.href = '/dashboard')}
            className="w-full py-2 px-4 rounded-xl text-sm font-bold text-slate-950 bg-gradient-to-r from-purple-400 via-teal-400 to-emerald-400 hover:opacity-90 transition active:scale-[0.98]"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
