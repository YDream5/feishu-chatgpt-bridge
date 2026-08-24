import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const runtimeDir = path.join(root, '.runtime');
const pidFile = path.join(runtimeDir, 'bridge.pid');
const logFile = path.join(runtimeDir, 'bridge.log');
const entry = path.join(root, 'src', 'index.js');

fs.mkdirSync(runtimeDir, { recursive: true });

function readPid() {
  try { return Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); }
  catch { return null; }
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}
function cleanStalePid() {
  const pid = readPid();
  if (pid && !isAlive(pid)) {
    try { fs.unlinkSync(pidFile); } catch {}
    return null;
  }
  return pid;
}

function startBackground() {
  const existing = cleanStalePid();
  if (existing && isAlive(existing)) {
    console.log(`Bridge already running (PID ${existing})`);
    return;
  }

  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  fs.writeFileSync(pidFile, String(child.pid));
  child.unref();
  fs.closeSync(out);
  console.log(`Bridge started in background (PID ${child.pid})`);
  console.log(`Log: ${logFile}`);
}
function stopBridge() {
  const pid = cleanStalePid();
  if (!pid || !isAlive(pid)) {
    console.log('Bridge is not running.');
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'inherit' });
  } else {
    try { process.kill(-pid, 'SIGTERM'); }
    catch { process.kill(pid, 'SIGTERM'); }
  }
  try { fs.unlinkSync(pidFile); } catch {}
  console.log(`Bridge stopped (PID ${pid})`);
}

function status() {
  const pid = cleanStalePid();
  if (pid && isAlive(pid)) console.log(`RUNNING pid=${pid}`);
  else console.log('STOPPED');
  console.log(`Log: ${logFile}`);
}

function logs() {
  if (!fs.existsSync(logFile)) return console.log('No background log yet.');
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/);
  console.log(lines.slice(-120).join('\n'));
}
const command = process.argv[2] || 'status';

if (command === 'start') startBackground();
else if (command === 'stop') stopBridge();
else if (command === 'restart') {
  stopBridge();
  setTimeout(startBackground, 500);
} else if (command === 'status') status();
else if (command === 'logs') logs();
else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
