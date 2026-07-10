'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api-client';

interface Exam {
  id: string;
  title: string;
  description?: string;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
}

interface ExamSession {
  id: string;
  examId: string;
  status: string;
  startedAt?: string;
  submittedAt?: string;
  score?: number;
}

export default function DashboardPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [sessions, setSessions] = useState<Record<string, ExamSession>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDashboardData() {
      try {
        // Fetch exams
        const examsRes = await apiClient.get('/exams');
        const examsList = examsRes.data;
        setExams(examsList);

        // Fetch session state for each exam
        const sessionMap: Record<string, ExamSession> = {};
        for (const exam of examsList) {
          try {
            const sessionRes = await apiClient.get(`/exams/${exam.id}/session`);
            if (sessionRes.data) {
              sessionMap[exam.id] = sessionRes.data;
            }
          } catch (err) {
            // Ignore if no session has been started yet (usually 404 or empty)
          }
        }
        setSessions(sessionMap);
      } catch (err: any) {
        setError(err.response?.data?.error?.message || 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    }
    loadDashboardData();
  }, []);

  const handleStartExam = async (examId: string) => {
    try {
      const existingSession = sessions[examId];
      if (existingSession) {
        // Redirect to exam environment if already in progress
        window.location.href = `/exam/${examId}`;
        return;
      }

      // Start new exam session
      const res = await apiClient.post(`/exams/${examId}/start`);
      if (res.data) {
        window.location.href = `/exam/${examId}`;
      }
    } catch (err: any) {
      alert(err.response?.data?.error?.message || 'Failed to start exam session');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    window.location.href = '/login';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-slate-300">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-12 h-12 border-4 border-t-teal-400 border-r-transparent border-b-purple-500 border-l-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium tracking-wide">Loading portal...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative min-h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Dynamic Background */}
      <div className="absolute top-0 left-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" />
      <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-teal-600/10 rounded-full blur-3xl" />

      {/* Navbar */}
      <header className="relative z-10 border-b border-slate-800 bg-slate-900/40 backdrop-blur-md px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-gradient-to-tr from-purple-500/20 to-teal-500/20 border border-slate-800 rounded-lg">
            <svg className="w-6 h-6 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-purple-400 via-teal-400 to-emerald-400 bg-clip-text text-transparent">
            AI Olympiad Portal
          </span>
        </div>
        <button
          onClick={handleLogout}
          className="px-4 py-2 border border-slate-800 hover:border-red-500/50 hover:bg-red-950/20 rounded-lg text-sm text-slate-400 hover:text-red-400 transition duration-150"
        >
          Logout
        </button>
      </header>

      {/* Main Content */}
      <main className="relative z-10 max-w-6xl mx-auto px-6 py-12 space-y-8">
        <div className="space-y-2">
          <h1 className="text-4xl font-extrabold tracking-tight">Your Exams</h1>
          <p className="text-slate-400">Select an exam session below to begin or resume your test.</p>
        </div>

        {error && (
          <div className="bg-red-950/30 border border-red-800/50 rounded-xl p-4 text-red-400">
            {error}
          </div>
        )}

        {exams.length === 0 ? (
          <div className="text-center py-16 bg-slate-900/30 border border-slate-800 rounded-2xl">
            <p className="text-slate-400">No scheduled exams available at this time.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {exams.map((exam) => {
              const session = sessions[exam.id];
              const isFinished = session?.status === 'SUBMITTED' || session?.status === 'GRADED';
              const isInProgress = session?.status === 'IN_PROGRESS';
              const examStart = new Date(exam.startsAt);
              const examEnd = new Date(exam.endsAt);
              const now = new Date();
              const isBeforeStart = now < examStart;
              const isAfterEnd = now > examEnd;

              return (
                <div
                  key={exam.id}
                  className="bg-slate-900/50 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 flex flex-col justify-between hover:border-slate-700 transition duration-200"
                >
                  <div className="space-y-4">
                    <div className="flex justify-between items-start">
                      <h3 className="text-xl font-bold text-slate-100">{exam.title}</h3>
                      {session && (
                        <span
                          className={`text-xs px-2.5 py-1 rounded-full font-semibold border ${
                            isFinished
                              ? 'bg-emerald-950/30 border-emerald-800 text-emerald-400'
                              : 'bg-purple-950/30 border-purple-800 text-purple-400'
                          }`}
                        >
                          {session.status}
                        </span>
                      )}
                    </div>
                    {exam.description && <p className="text-sm text-slate-400">{exam.description}</p>}

                    <div className="grid grid-cols-2 gap-4 text-xs text-slate-400 border-t border-slate-800/50 pt-4">
                      <div>
                        <span className="block font-medium text-slate-500 uppercase">Starts</span>
                        <span>{examStart.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="block font-medium text-slate-500 uppercase">Ends</span>
                        <span>{examEnd.toLocaleString()}</span>
                      </div>
                      <div>
                        <span className="block font-medium text-slate-500 uppercase">Duration</span>
                        <span>{exam.durationMinutes} Minutes</span>
                      </div>
                      {session?.score !== undefined && (
                        <div>
                          <span className="block font-medium text-slate-500 uppercase">Score</span>
                          <span className="text-teal-400 font-bold">{session.score.toFixed(1)} pts</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-slate-800/50">
                    <button
                      disabled={isFinished || (isBeforeStart && !session) || (isAfterEnd && !session)}
                      onClick={() => handleStartExam(exam.id)}
                      className={`w-full py-2 px-4 rounded-xl text-sm font-semibold transition active:scale-[0.98] ${
                        isFinished
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          : isInProgress
                          ? 'bg-gradient-to-r from-purple-500 to-indigo-600 hover:opacity-90 text-slate-100'
                          : isBeforeStart
                          ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                          : 'bg-gradient-to-r from-teal-400 to-emerald-400 hover:opacity-90 text-slate-950'
                      }`}
                    >
                      {isFinished
                        ? 'Completed'
                        : isInProgress
                        ? 'Resume Exam'
                        : isBeforeStart
                        ? 'Not Yet Started'
                        : 'Start Exam'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
