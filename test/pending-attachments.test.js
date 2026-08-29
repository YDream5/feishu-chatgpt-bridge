import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingAttachmentStore,
  pendingAttachmentKey,
} from '../src/pending-attachments.js';

function message({ chat = 'oc_group', sender = 'ou_user', id, files = [] }) {
  return {
    chatId: chat,
    senderId: sender,
    messageId: id,
    resources: files.map((fileKey, index) => ({
      type: 'file',
      fileKey,
      fileName: `${index + 1}.pdf`,
    })),
  };
}

test('groups multiple attachments by chat and sender', () => {
  const store = new PendingAttachmentStore();
  const first = message({ id: 'm1', files: ['a'] });
  const second = message({ id: 'm2', files: ['b', 'c'] });

  store.add(first);
  store.add(second);
  assert.equal(store.get(second).length, 3);
  assert.deepEqual(store.get(second).map(x => x.sourceMessageId), ['m1', 'm2', 'm2']);
});
test('isolates different users in the same group', () => {
  const store = new PendingAttachmentStore();
  const alice = message({ sender: 'alice', id: 'm1', files: ['a'] });
  const bob = message({ sender: 'bob', id: 'm2', files: ['b'] });

  store.add(alice);
  store.add(bob);
  assert.equal(store.get(alice)[0].fileKey, 'a');
  assert.equal(store.get(bob)[0].fileKey, 'b');
  assert.notEqual(pendingAttachmentKey(alice), pendingAttachmentKey(bob));
});

test('expires pending batches after TTL', () => {
  let now = 1_000;
  const store = new PendingAttachmentStore({
    ttlMs: 300_000,
    now: () => now,
  });
  const msg = message({ id: 'm1', files: ['a'] });
  store.add(msg);

  now += 299_999;
  assert.equal(store.get(msg).length, 1);
  now += 2;
  assert.equal(store.get(msg).length, 0);
});
test('caps a pending batch without storing file bytes', () => {
  const store = new PendingAttachmentStore({ maxAttachments: 2 });
  const msg = message({ id: 'm1', files: ['a', 'b', 'c'] });
  const state = store.add(msg);

  assert.equal(state.total, 2);
  assert.equal(state.overflow, 1);
  assert.deepEqual(store.get(msg).map(x => x.fileKey), ['a', 'b']);
  assert.equal('dataBase64' in store.get(msg)[0], false);
});
