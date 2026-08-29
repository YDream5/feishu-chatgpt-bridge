import * as Lark from '@larksuiteoapi/node-sdk';
import { getFeishuConfig } from '../src/config.js';

const { appId, appSecret } = getFeishuConfig();
console.log(`[finalize] requesting temporary app-management scope for ${appId}`);

await Lark.registerApp({
  appId,
  source: 'feishu-chatgpt-finalize',
  addons: {
    scopes: { tenant: ['application:application:patch'] },
  },
  onQRCodeReady(info) {
    console.log(`[finalize] URL ${info.url}`);
    console.log(`[finalize] expires_in=${info.expireIn}`);
  },
  onStatusChange(info) {
    console.log(`[finalize] ${info.status}`);
  },
});

const client = new Lark.Client({ appId, appSecret });
console.log('[finalize] temporary scope granted');

await client.application.v7.applicationConfig.patch({
  path: { app_id: appId },
  data: {
    visibility: { is_visible_to_all: true },
    scope: {
      remove_scopes: [
        { scope_name: 'application:application:patch', token_type: 'tenant' },
      ],
    },
  },
});
console.log('[finalize] visibility staged; temporary scope staged for removal');
const published = await client.application.v7.applicationPublish.create({
  path: { app_id: appId },
  data: {
    mobile_default_ability: 'bot',
    pc_default_ability: 'bot',
    remark: 'feishu-chatgpt initial release',
    changelog: 'Minimal ChatGPT bridge using official Feishu Node SDK.',
  },
});
console.log(`[finalize] publish submitted: ${published.data?.version || '(auto)'} ${published.data?.version_id || ''}`);
console.log('[finalize] temporary app-management scope is removed in the submitted version');
