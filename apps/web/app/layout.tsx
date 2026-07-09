import './globals.css';
import { Inter } from 'next/font/google';

const inter = Inter({ subsets: ['latin'] });

export const metadata = {
  title: 'AI Olympiad Proctored Exam Platform',
  description: 'Secure, polyglot proctored online exam environment',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-950 text-slate-100 min-h-screen antialiased`}>
        {children}
      </body>
    </html>
  );
}
