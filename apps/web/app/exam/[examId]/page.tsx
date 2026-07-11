'use client';

import { useEffect, useState, useRef, use } from 'react';
import dynamic from 'next/dynamic';
import { apiClient } from '@/lib/api-client';

// Dynamically import Monaco Editor with SSR disabled
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface Question {
  id: string;
  type: 'MCQ' | 'CODE';
  prompt: string;
  options?: { id: string; text: string }[];
  starterCode?: Record<string, string>;
}

interface ExamQuestionRelation {
  questionId: string;
  order: number;
  points: number;
  question: Question;
}

interface ExamSession {
  id: string;
  examId: string;
  status: string;
  startedAt: string;
  exam: {
    title: string;
    durationMinutes: number;
    endsAt: string;
    questions: ExamQuestionRelation[];
  };
}

export default function ExamPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = use(params);

  const [session, setSession] = useState<ExamSession | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [savingStatus, setSavingStatus] = useState<Record<string, 'saved' | 'saving' | 'error'>>({});
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [submitting, setSubmitting] = useState(false);
  const [showConfirmSubmit, setShowConfirmSubmit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const saveTimeoutRef = useRef<Record<string, NodeJS.Timeout>>({});

  // 1. Fetch Exam Session & initial answer drafts
  const fetchSession = async (isSync = false) => {
    try {
      const res = await apiClient.get(`/exams/${examId}/session`);
      const sessionData: ExamSession = res.data;
      setSession(sessionData);

      // Set time left based on server clock & startedAt
      const durationMs = sessionData.exam.durationMinutes * 60 * 1000;
      const startedTime = new Date(sessionData.startedAt).getTime();
      const endsTime = new Date(sessionData.exam.endsAt).getTime();
      const expirationTime = Math.min(startedTime + durationMs, endsTime);
      const remainingSecs = Math.max(0, Math.floor((expirationTime - Date.now()) / 1000));
      setTimeLeft(remainingSecs);

      if (!isSync) {
        // Build initial answers from submissions if any
        // Since getExamSession doesn't return submissions, let's load them if they exist
        // or just rely on state. Actually, if they rejoin, we can populate default answers
        // from local state or initialize empty. If NestJS returns started sessions,
        // it doesn't return current draft answers in getExamSession payload.
        // Wait, does the API return submissions in getExamSession?
        // Let's check: in getExamSession implementation, we fetched the session including submissions:
        // `include: { exam: { include: { questions: { include: { question: true } } } }, submissions: true }`
        // YES! getExamSession returns the submissions list!
        // Let's populate answers map from returning submissions.
        const answersMap: Record<string, any> = {};
        const savedStatusMap: Record<string, 'saved' | 'saving' | 'error'> = {};
        const submissions = (sessionData as any).submissions || [];
        for (const sub of submissions) {
          answersMap[sub.questionId] = sub.answer;
          savedStatusMap[sub.questionId] = 'saved';
        }
        setAnswers(answersMap);
        setSavingStatus(savedStatusMap);
      }
    } catch (err: any) {
      if (err.response?.status === 403 || err.response?.status === 404) {
        setError(err.response?.data?.error?.message || 'Access Denied');
      } else {
        setError('Failed to fetch exam session');
      }
    } finally {
      if (!isSync) setLoading(false);
    }
  };

  useEffect(() => {
    fetchSession();

    // Re-sync with server every 45 seconds to align clocks
    const syncInterval = setInterval(() => {
      fetchSession(true);
    }, 45000);

    return () => clearInterval(syncInterval);
  }, [examId]);

  // 2. Countdown Timer
  useEffect(() => {
    if (timeLeft <= 0) return;
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleAutoSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [timeLeft]);

  // WebSocket references
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Helper to send integrity event with binary framing
  const sendIntegrityEvent = (ws: WebSocket, eventType: string) => {
    if (ws.readyState !== WebSocket.OPEN) return;

    const payload = JSON.stringify({
      eventType,
      clientTimestamp: Date.now(),
    });

    const encoder = new TextEncoder();
    const payloadBytes = encoder.encode(payload);

    const packet = new Uint8Array(9 + payloadBytes.byteLength);
    packet[0] = 0x02; // type integrity event

    const ts = Date.now();
    const tsView = new DataView(packet.buffer);
    const hi = Math.floor(ts / 0x100000000);
    const lo = ts % 0x100000000;
    tsView.setUint32(1, hi);
    tsView.setUint32(5, lo);

    packet.set(payloadBytes, 9);
    ws.send(packet);
  };

  // Proctoring WebSocket Connection & Capture Logic
  useEffect(() => {
    if (!session || session.status !== 'IN_PROGRESS' || !(session as any).wsToken) {
      return;
    }

    const wsToken = (session as any).wsToken;
    const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.hostname}:8080/ws?token=${wsToken}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Proctoring WebSocket connected');
    };

    ws.onclose = (e) => {
      console.log('Proctoring WebSocket closed', e.code, e.reason);
    };

    ws.onerror = (err) => {
      console.error('Proctoring WebSocket error', err);
    };

    // 1. Setup Webcam capturing
    let captureInterval: NodeJS.Timeout;
    const video = document.createElement('video');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } })
      .then((stream) => {
        streamRef.current = stream;
        video.srcObject = stream;
        video.play();

        // Capture webcam frame every 2 seconds
        captureInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;

          canvas.width = 320;
          canvas.height = 240;
          if (ctx) {
            ctx.drawImage(video, 0, 0, 320, 240);
            canvas.toBlob((blob) => {
              if (blob) {
                blob.arrayBuffer().then((buffer) => {
                  const packet = new Uint8Array(9 + buffer.byteLength);
                  packet[0] = 0x01; // type webcam frame

                  const ts = Date.now();
                  const tsView = new DataView(packet.buffer);
                  const hi = Math.floor(ts / 0x100000000);
                  const lo = ts % 0x100000000;
                  tsView.setUint32(1, hi);
                  tsView.setUint32(5, lo);

                  packet.set(new Uint8Array(buffer), 9);
                  ws.send(packet);
                });
              }
            }, 'image/jpeg', 0.6); // 0.6 quality compression
          }
        }, 2000);
      })
      .catch((err) => {
        console.warn('Failed to access webcam or webcam not available', err);
        // Report webcam permission issue or availability issue as an integrity event
        sendIntegrityEvent(ws, 'DEVTOOLS_SUSPECTED'); // default or a fallback event
      });

    // 2. Setup Integrity event listeners
    const handleVisibilityChange = () => {
      const state = document.visibilityState;
      const type = state === 'hidden' ? 'VISIBILITY_HIDDEN' : 'VISIBILITY_VISIBLE';
      sendIntegrityEvent(ws, type);
    };

    const handleBlur = () => sendIntegrityEvent(ws, 'TAB_BLUR');
    const handleFocus = () => sendIntegrityEvent(ws, 'TAB_FOCUS');
    const handleCopy = () => sendIntegrityEvent(ws, 'COPY');
    const handlePaste = () => sendIntegrityEvent(ws, 'PASTE');

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('copy', handleCopy);
    document.addEventListener('paste', handlePaste);

    return () => {
      clearInterval(captureInterval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('paste', handlePaste);

      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [session?.id, session?.status]);

  // 3. Debounced Autosave Answer
  const saveAnswerDraft = async (questionId: string, answer: any) => {
    // Clear previous timeout for this question
    if (saveTimeoutRef.current[questionId]) {
      clearTimeout(saveTimeoutRef.current[questionId]);
    }

    setSavingStatus((prev) => ({ ...prev, [questionId]: 'saving' }));

    saveTimeoutRef.current[questionId] = setTimeout(async () => {
      try {
        await apiClient.patch(`/exams/sessions/${session?.id}/answers`, {
          questionId,
          answer,
        });
        setSavingStatus((prev) => ({ ...prev, [questionId]: 'saved' }));
      } catch (err) {
        setSavingStatus((prev) => ({ ...prev, [questionId]: 'error' }));
      }
    }, 1200); // 1.2s debounce
  };

  const handleMCQSelect = (questionId: string, optionId: string) => {
    const newAnswer = { selectedOption: optionId };
    setAnswers((prev) => ({ ...prev, [questionId]: newAnswer }));
    saveAnswerDraft(questionId, newAnswer);
  };

  const handleCodeChange = (questionId: string, language: string, code: string) => {
    const currentAnswer = answers[questionId] || {};
    const newAnswer = { ...currentAnswer, language, code };
    setAnswers((prev) => ({ ...prev, [questionId]: newAnswer }));
    saveAnswerDraft(questionId, newAnswer);
  };

  const handleLanguageChange = (questionId: string, language: string, starterCode: string) => {
    const currentAnswer = answers[questionId] || {};
    const newAnswer = {
      language,
      code: currentAnswer.code || starterCode || '',
    };
    setAnswers((prev) => ({ ...prev, [questionId]: newAnswer }));
    saveAnswerDraft(questionId, newAnswer);
  };

  // 4. Final Submission
  const handleSubmitExam = async () => {
    if (!session) return;
    setSubmitting(true);
    try {
      const idempotencyKey = `submit_${session.id}_${Date.now()}`;
      await apiClient.post(`/exams/sessions/${session.id}/submit`, { idempotencyKey });
      window.location.href = '/exam/success';
    } catch (err: any) {
      alert(err.response?.data?.error?.message || 'Failed to submit exam');
    } finally {
      setSubmitting(false);
    }
  };

  const handleAutoSubmit = async () => {
    if (!session) return;
    try {
      const idempotencyKey = `autosubmit_${session.id}`;
      await apiClient.post(`/exams/sessions/${session.id}/submit`, { idempotencyKey });
      window.location.href = '/exam/success';
    } catch (e) {
      window.location.href = '/exam/success';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-slate-300">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-12 h-12 border-4 border-t-teal-400 border-r-transparent border-b-purple-500 border-l-transparent rounded-full animate-spin" />
          <p className="text-sm font-medium tracking-wide">Starting exam environment...</p>
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-950 text-slate-300 px-6 text-center">
        <div className="max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-8 space-y-6">
          <div className="text-red-500 text-5xl">⚠️</div>
          <h2 className="text-2xl font-bold">{error || 'Exam Session Invalid'}</h2>
          <button
            onClick={() => (window.location.href = '/dashboard')}
            className="px-6 py-2 bg-slate-800 hover:bg-slate-700 rounded-xl font-medium text-sm transition"
          >
            Return to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const questions = session.exam.questions;
  const activeQuestionRel = questions[activeIdx];
  const activeQ = activeQuestionRel?.question;
  const activePoints = activeQuestionRel?.points;

  // Format countdown timer (MM:SS)
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex flex-col h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Header bar */}
      <header className="flex items-center justify-between border-b border-slate-800 bg-slate-900/60 backdrop-blur-md px-6 py-3">
        <div className="flex items-center space-x-4">
          <span className="font-extrabold text-lg tracking-tight bg-gradient-to-r from-purple-400 via-teal-400 to-emerald-400 bg-clip-text text-transparent">
            {session.exam.title}
          </span>
        </div>

        {/* Countdown Timer */}
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2 bg-slate-950 border border-slate-800 px-4 py-1.5 rounded-full shadow-inner">
            <svg className="w-4 h-4 text-teal-400 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className={`font-mono font-bold text-sm ${timeLeft < 300 ? 'text-red-400 animate-pulse' : 'text-slate-300'}`}>
              {formatTime(timeLeft)}
            </span>
          </div>

          <button
            onClick={() => setShowConfirmSubmit(true)}
            className="px-5 py-1.5 bg-gradient-to-r from-teal-400 to-emerald-400 hover:opacity-90 active:scale-[0.98] text-slate-950 font-bold text-sm rounded-xl transition"
          >
            Submit Exam
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="flex flex-1 overflow-hidden">
        {/* Navigation Sidebar */}
        <aside className="w-64 border-r border-slate-800 bg-slate-900/20 p-6 flex flex-col justify-between overflow-y-auto">
          <div className="space-y-6">
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Questions</h4>
            <div className="grid grid-cols-4 gap-3">
              {questions.map((qRel, idx) => {
                const isAnswered = !!answers[qRel.questionId];
                const isActive = idx === activeIdx;
                const status = savingStatus[qRel.questionId];

                return (
                  <button
                    key={qRel.questionId}
                    onClick={() => setActiveIdx(idx)}
                    className={`relative aspect-square rounded-xl font-bold text-sm border flex items-center justify-center transition-all ${
                      isActive
                        ? 'bg-gradient-to-tr from-purple-500/20 to-teal-500/20 border-teal-400 text-teal-300 shadow-lg shadow-teal-500/5'
                        : isAnswered
                        ? 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-600'
                        : 'bg-slate-950 border-slate-800 text-slate-500 hover:border-slate-700'
                    }`}
                  >
                    {idx + 1}
                    {isAnswered && (
                      <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-teal-400 rounded-full border border-slate-950" />
                    )}
                    {status === 'saving' && (
                      <span className="absolute -bottom-1 -right-1 w-2 h-2 bg-yellow-500 rounded-full animate-ping" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Status Panel */}
          <div className="border-t border-slate-800/60 pt-4 text-xs text-slate-500 space-y-2">
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 bg-teal-400 rounded-full" />
              <span>Answered</span>
            </div>
            <div className="flex items-center space-x-2">
              <span className="w-2.5 h-2.5 bg-slate-800 rounded-full border border-slate-700" />
              <span>Unanswered</span>
            </div>
          </div>
        </aside>

        {/* Workspace Panel */}
        <main className="flex-1 flex flex-col justify-between bg-slate-950 overflow-hidden">
          {activeQ ? (
            <div className="flex-1 flex flex-col p-8 space-y-6 overflow-y-auto">
              {/* Question title & prompt */}
              <div className="flex items-center justify-between border-b border-slate-800/60 pb-4">
                <span className="text-sm font-semibold text-slate-400">
                  Question {activeIdx + 1} of {questions.length} ({activePoints} points)
                </span>
                {savingStatus[activeQ.id] && (
                  <span className="text-xs font-mono text-slate-500">
                    {savingStatus[activeQ.id] === 'saving' && 'Saving draft...'}
                    {savingStatus[activeQ.id] === 'saved' && 'Draft saved'}
                    {savingStatus[activeQ.id] === 'error' && '⚠️ Connection issue'}
                  </span>
                )}
              </div>

              <div className="space-y-4">
                <p className="text-lg text-slate-200 leading-relaxed font-medium whitespace-pre-wrap">
                  {activeQ.prompt}
                </p>
              </div>

              {/* Answers Workspace */}
              <div className="flex-1 pt-4">
                {activeQ.type === 'MCQ' ? (
                  // MCQ Layout
                  <div className="space-y-3 max-w-2xl">
                    {activeQ.options?.map((opt) => {
                      const isSelected = answers[activeQ.id]?.selectedOption === opt.id;
                      return (
                        <button
                          key={opt.id}
                          onClick={() => handleMCQSelect(activeQ.id, opt.id)}
                          className={`w-full text-left p-4 rounded-xl border flex items-center justify-between transition-all ${
                            isSelected
                              ? 'bg-teal-500/10 border-teal-400 text-teal-200'
                              : 'bg-slate-900/30 border-slate-800 text-slate-300 hover:border-slate-700 hover:bg-slate-900/50'
                          }`}
                        >
                          <span>{opt.text}</span>
                          <span
                            className={`w-5 h-5 rounded-full border flex items-center justify-center ${
                              isSelected
                                ? 'border-teal-400 bg-teal-400 text-slate-950'
                                : 'border-slate-700'
                            }`}
                          >
                            {isSelected && (
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  // CODE Layout with Monaco Editor
                  <div className="flex flex-col h-[50vh] border border-slate-800 rounded-xl overflow-hidden bg-slate-950">
                    <div className="bg-slate-900 px-4 py-2 border-b border-slate-800 flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <label htmlFor={`lang-${activeQ.id}`} className="text-xs text-slate-500 font-medium uppercase">
                          Language:
                        </label>
                        <select
                          id={`lang-${activeQ.id}`}
                          value={answers[activeQ.id]?.language || 'python'}
                          onChange={(e) => {
                            const newLang = e.target.value;
                            const starter = activeQ.starterCode?.[newLang] || '';
                            handleLanguageChange(activeQ.id, newLang, starter);
                          }}
                          className="bg-slate-950 border border-slate-800 text-slate-300 text-xs rounded-lg px-2 py-1 focus:outline-none focus:border-teal-500"
                        >
                          <option value="python">Python</option>
                          <option value="javascript">JavaScript</option>
                          <option value="cpp">C++</option>
                          <option value="java">Java</option>
                        </select>
                      </div>
                    </div>
                    <div className="flex-1">
                      <MonacoEditor
                        height="100%"
                        language={
                          answers[activeQ.id]?.language === 'cpp'
                            ? 'cpp'
                            : answers[activeQ.id]?.language === 'java'
                            ? 'java'
                            : answers[activeQ.id]?.language === 'javascript'
                            ? 'javascript'
                            : 'python'
                        }
                        theme="vs-dark"
                        value={answers[activeQ.id]?.code ?? activeQ.starterCode?.[answers[activeQ.id]?.language || 'python'] ?? ''}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 14,
                          lineHeight: 22,
                          scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
                          padding: { top: 12 },
                          automaticLayout: true,
                        }}
                        onChange={(value) => {
                          const lang = answers[activeQ.id]?.language || 'python';
                          handleCodeChange(activeQ.id, lang, value || '');
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-slate-500">
              Select a question to begin.
            </div>
          )}

          {/* Footer Navigation Bar */}
          <footer className="border-t border-slate-800/60 bg-slate-900/20 px-8 py-4 flex items-center justify-between">
            <button
              disabled={activeIdx === 0}
              onClick={() => setActiveIdx((prev) => prev - 1)}
              className="px-4 py-2 border border-slate-800 hover:border-slate-700 disabled:opacity-30 rounded-xl text-sm font-medium transition"
            >
              Previous Question
            </button>
            <button
              disabled={activeIdx === questions.length - 1}
              onClick={() => setActiveIdx((prev) => prev + 1)}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-30 rounded-xl text-sm font-medium transition"
            >
              Next Question
            </button>
          </footer>
        </main>
      </div>

      {/* Confirm Submission Dialog */}
      {showConfirmSubmit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm px-4">
          <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6 shadow-2xl">
            <h3 className="text-xl font-bold text-slate-100">Submit Exam?</h3>
            <p className="text-slate-400 text-sm leading-relaxed">
              Are you sure you want to submit your exam? All draft answers have been autosaved. You will not be able to return to this exam session once submitted.
            </p>
            <div className="flex items-center space-x-3 justify-end pt-2">
              <button
                disabled={submitting}
                onClick={() => setShowConfirmSubmit(false)}
                className="px-4 py-2 text-slate-400 hover:text-slate-200 text-sm font-medium"
              >
                Cancel
              </button>
              <button
                disabled={submitting}
                onClick={handleSubmitExam}
                className="px-6 py-2 bg-gradient-to-r from-teal-400 to-emerald-400 text-slate-950 font-bold text-sm rounded-xl hover:opacity-90 disabled:opacity-50 transition"
              >
                {submitting ? 'Submitting...' : 'Confirm Submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
