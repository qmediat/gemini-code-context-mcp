/**
 * Minimal leveled logger. Writes to stderr so it never collides with MCP stdio transport.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const PREFIX = '[gemini-code-context-mcp]';

function currentLevel(): number {
  const raw = (process.env.GEMINI_CODE_CONTEXT_LOG_LEVEL ?? 'info').toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.info;
}

function write(level: LogLevel, message: string): void {
  if (LEVELS[level] < currentLevel()) return;
  process.stderr.write(`${PREFIX} [${level}] ${message}\n`);
}

export const logger = {
  debug: (msg: string): void => write('debug', msg),
  info: (msg: string): void => write('info', msg),
  warn: (msg: string): void => write('warn', msg),
  error: (msg: string): void => write('error', msg),
};
