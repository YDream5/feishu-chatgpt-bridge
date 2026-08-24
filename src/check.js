import { getFeishuConfig } from './config.js';
import { createFeishuChannel } from './feishu.js';

try {
  const { appId } = getFeishuConfig();
  createFeishuChannel();
  console.log(`Feishu SDK config ready: ${appId}`);
  console.log('Runtime dependency: @larksuiteoapi/node-sdk (no lark-cli).');
} catch (err) {
  console.error(String(err?.message || err));
  process.exitCode = 1;
}
