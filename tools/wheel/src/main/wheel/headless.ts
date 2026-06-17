import { spawn } from 'node:child_process';

export const CLAUDE = process.env.CLAUDE_BIN || 'claude';
export const CWD = process.env.WHEEL_CWD || process.cwd();

export interface ClaudeResult {
  result: string;
  is_error: boolean;
}

export function spawnClaude(args: string[], killMs: number): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, {
      cwd: CWD,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let out = '';
    let err = '';
    const t = setTimeout(() => {
      child.kill();
      reject(new Error('claude timed out'));
    }, killMs);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(t);
      try {
        resolve(JSON.parse(out) as ClaudeResult);
      } catch {
        reject(new Error(`claude exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`));
      }
    });

    child.stdin.end('');
  });
}

export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

export function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
