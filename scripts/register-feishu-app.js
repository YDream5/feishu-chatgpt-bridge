import fs from 'node:fs';
import path from 'node:path';
import * as Lark from '@larksuiteoapi/node-sdk';

const root = path.resolve(import.meta.dirname, '..');
const runtimeDir = path.join(root, '.runtime');
const envPath = path.join(root, '.env');
const appName = process.argv[2]?.trim() || process.env.FEISHU_APP_NAME?.trim() || 'feishu-chatgpt';

fs.mkdirSync(runtimeDir, { recursive: true });

function saveEnv(appId, appSecret) {
  const content = [
    `FEISHU_APP_ID=${appId}`,
    `FEISHU_APP_SECRET=${appSecret}`,
    `FEISHU_APP_NAME=${appName}`,
    '',
  ].join('\n');
  fs.writeFileSync(envPath, content, { mode: 0o600 });
}

console.log(`[register] creating Feishu bot: ${appName}`);
const result = await Lark.registerApp({
  source: 'feishu-chatgpt-bridge',
  createOnly: true,
  appPreset: {
    name: appName,
    desc: 'Bridge Feishu messages to a locally logged-in ChatGPT web session.',
  },
  addons: {
    preset: false,
    scopes: {
      tenant: [
        'im:message.group_at_msg:readonly',
        'im:message.p2p_msg:readonly',
        'im:message:send_as_bot',
      ],
    },
    events: {
      items: { tenant: ['im.message.receive_v1'] },
    },
  },
  onQRCodeReady(info) {
    fs.writeFileSync(
      path.join(runtimeDir, 'feishu-register.json'),
      JSON.stringify(info, null, 2),
    );
    console.log(`[register] URL ${info.url}`);
    console.log(`[register] expires_in=${info.expireIn}`);
  },
  onStatusChange(info) {
    console.log(`[register] ${info.status}`);
  },
});

saveEnv(result.client_id, result.client_secret);
fs.writeFileSync(
  path.join(runtimeDir, 'feishu-app.json'),
  JSON.stringify({
    appId: result.client_id,
    createdAt: new Date().toISOString(),
  }, null, 2),
);
console.log(`[register] created ${result.client_id}`);
console.log('[register] credentials saved to .env');
