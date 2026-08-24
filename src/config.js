import fs from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';

const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) loadEnvFile(envPath);

export function getFeishuConfig() {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error('Missing FEISHU_APP_ID / FEISHU_APP_SECRET. Run npm run register:feishu first.');
  }
  return { appId, appSecret };
}
