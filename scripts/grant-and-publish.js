import * as Lark from '@larksuiteoapi/node-sdk';
import { getFeishuConfig } from '../src/config.js';

const { appId, appSecret } = getFeishuConfig();
console.log(`[publish] requesting temporary management scope for ${appId}`);

await Lark.registerApp({
  appId,
  addons: {
    preset: false,
    scopes: { tenant: ['application:application:patch'] },
  },
  source: 'feishu-chatgpt-publish',
  onQRCodeReady(info) {
    console.log(`[publish] URL ${info.url}`);
    console.log(`[publish] expires_in=${info.expireIn}`);
  },
  onStatusChange(info) {
    console.log(`[publish] ${info.status}`);
  },
});

const client = new Lark.Client({ appId, appSecret });
const result = await client.application.v7.applicationPublish.create({
  path: { app_id: appId },
  data: {
    mobile_default_ability: 'bot',
    pc_default_ability: 'bot',
    remark: 'feishu-chatgpt initial release',
    changelog: 'Official Feishu Node SDK WebSocket ChatGPT bridge.',
  },
});
console.log(`[publish] submitted version=${result.data?.version || ''} id=${result.data?.version_id || ''}`);