import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readProcessStartIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      return startTicks && /^\d+$/.test(startTicks) ? `linux:${startTicks}` : null;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 2_000 });
      const value = stdout.trim();
      return value ? `darwin:${value}` : null;
    }
    if (process.platform === 'win32') {
      const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3_000 });
      const value = stdout.trim();
      return /^\d+$/.test(value) ? `win32:${value}` : null;
    }
  } catch {
    return null;
  }
  return null;
}
