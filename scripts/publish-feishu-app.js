import * as Lark from '@larksuiteoapi/node-sdk';
import { getFeishuConfig } from '../src/config.js';

const { appId, appSecret } = getFeishuConfig();
const client = new Lark.Client({ appId, appSecret });

const configResult = await client.application.v7.applicationConfig.patch({
  path: { app_id: appId },
  data: { visibility: { is_visible_to_all: true } },
});
if (configResult.code && configResult.code !== 0) {
  throw new Error(`visibility update failed: ${configResult.code} ${configResult.msg}`);
}
console.log(`[publish] visibility updated for ${appId}`);

const publishResult = await client.application.v7.applicationPublish.create({
  path: { app_id: appId },
  data: {
    mobile_default_ability: 'bot',
    pc_default_ability: 'bot',
    remark: 'feishu-chatgpt initial release',
    changelog: 'Minimal ChatGPT bridge bot using official Feishu Node SDK.',
  },
});
if (publishResult.code && publishResult.code !== 0) {
  throw new Error(`publish failed: ${publishResult.code} ${publishResult.msg}`);
}
console.log(`[publish] submitted version ${publishResult.data?.version || '(auto)'} id=${publishResult.data?.version_id || '(unknown)'}`);
