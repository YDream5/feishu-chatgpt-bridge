import fs from 'node:fs';
import path from 'node:path';

export const RUNTIME_DIR = path.join(process.cwd(), '.runtime');
export const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readPid() {
  try {
    return Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}
export function registerRuntime() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const existing = readPid();
  if (existing && existing !== process.pid && isPidAlive(existing)) {
    throw new Error(`Bridge already running (PID ${existing})`);
  }

  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => {
    try {
      if (readPid() === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
  };

  process.once('exit', cleanup);
  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));
  return { pid: process.pid, pidFile: PID_FILE };
}
