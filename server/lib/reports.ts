// AI-drafted progress reports for parents, written from the tutor's own session notes.
// The model only drafts; the tutor edits and decides whether to send.
import Anthropic from '@anthropic-ai/sdk';
import type { SessionRow, StudentRow } from '../types.ts';
import { type DateStr, fmtWhen } from './time.ts';

type NoteSession = Pick<SessionRow, 'start_at' | 'end_at' | 'status' | 'topics' | 'notes' | 'next_plan'>;
type ReportStudent = Pick<StudentRow, 'name'> & Partial<Pick<StudentRow, 'grade' | 'subject' | 'next_plan'>>;
/** The slice of the Anthropic client this module uses (lets tests pass a stand-in). */
export type ReportClient = Pick<Anthropic, 'beta'>;
export interface Reporter {
  draft(student: ReportStudent, sessions: NoteSession[], from: DateStr, to: DateStr): Promise<{ body: string; truncated: boolean }>;
}

export const REPORT_MODEL = 'claude-opus-5';

const SYSTEM = `You help a private math tutor write short progress reports to a student's parents.

Write from the tutor's point of view ("I", "we worked on"), warm but specific, in plain language a busy parent can read in under a minute. Use only facts that appear in the session notes you're given. Never invent test scores, grades, or events. If the notes are thin, write a shorter report rather than padding it.

Structure it as four short paragraphs, without headings:
1. What we worked on this period.
2. Where the student is doing well (concrete examples from the notes).
3. What is still challenging, framed constructively.
4. The plan for the coming weeks, and one simple way the parent can help at home if the notes support it.

Keep it to 120-220 words. Plain text only: no markdown, no bullet points, no greeting line and no sign-off (those are added separately). Output only the report.`;

export function aiAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ANTHROPIC_API_KEY;
}

// Session notes -> the user message. Only first name, subject/grade and notes are sent.
export function buildPrompt(student: ReportStudent, sessions: NoteSession[], from: DateStr, to: DateStr): string {
  const firstName = student.name.split(/\s+/)[0];
  const lines = sessions.map((s) => {
    const parts = [`${fmtWhen(s.start_at, s.end_at)}`];
    if (s.status === 'no_show') parts.push('(no-show)');
    if (s.topics) parts.push(`Covered: ${s.topics}`);
    if (s.notes) parts.push(`Notes: ${s.notes}`);
    if (s.next_plan) parts.push(`Next time: ${s.next_plan}`);
    return `- ${parts.join(' | ')}`;
  });
  return [
    `Student: ${firstName}${student.grade ? `, grade ${student.grade}` : ''}${student.subject ? `, ${student.subject}` : ''}`,
    `Period: ${from} to ${to} (${sessions.filter((s) => s.status === 'completed').length} sessions)`,
    student.next_plan ? `Current plan: ${student.next_plan}` : '',
    '',
    'Session notes:',
    ...lines,
  ].filter((l, i) => l !== '' || i > 0).join('\n');
}

export class ReportError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export function createReporter({ client }: { client?: ReportClient } = {}): Reporter {
  let api = client;
  const getClient = (): ReportClient => {
    if (!api) api = new Anthropic(); // reads ANTHROPIC_API_KEY
    return api;
  };

  return {
    async draft(student, sessions, from, to) {
      if (!sessions.some((s) => s.topics || s.notes || s.next_plan)) {
        throw new ReportError('No session notes in this period to write from. Log a few sessions with notes first.', 400);
      }
      let response;
      try {
        response = await getClient().beta.messages.create({
          model: REPORT_MODEL,
          max_tokens: 16000,
          // Server-side fallback: if a safety classifier declines, Anthropic re-runs the
          // request on its recommended fallback model instead of returning a refusal.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system: SYSTEM,
          messages: [{ role: 'user', content: buildPrompt(student, sessions, from, to) }],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new ReportError('The Anthropic API key on the server is invalid.', 502);
        if (err instanceof Anthropic.RateLimitError) throw new ReportError('The AI service is busy. Try again in a minute.', 503);
        if (err instanceof Anthropic.BadRequestError) throw new ReportError(`The AI service rejected the request: ${err.message}`, 502);
        if (err instanceof Anthropic.APIError) throw new ReportError(`AI service error (${err.status ?? 'network'}). Try again.`, 502);
        throw err;
      }
      if (response.stop_reason === 'refusal') {
        throw new ReportError('The AI declined to write this report. Write it manually instead.', 422);
      }
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (!text) throw new ReportError('The AI returned an empty draft. Try again or write it manually.', 502);
      return { body: text, truncated: response.stop_reason === 'max_tokens' };
    },
  };
}
