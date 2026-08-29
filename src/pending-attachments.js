const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTACHMENTS = 10;

function resourceRefs(message) {
  return (message.resources || [])
    .filter(resource => resource?.fileKey &&
      (resource.type === 'image' || resource.type === 'file'))
    .map(resource => ({
      ...resource,
      sourceMessageId: message.messageId,
    }));
}

export function pendingAttachmentKey(message) {
  return `${message.chatId || 'dm'}:${message.senderId || 'unknown'}`;
}

export class PendingAttachmentStore {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxAttachments = DEFAULT_MAX_ATTACHMENTS,
    now = () => Date.now(),
  } = {}) {
    this.ttlMs = ttlMs;
    this.maxAttachments = maxAttachments;
    this.now = now;
    this.batches = new Map();
  }
  add(message) {
    this.sweep();
    const refs = resourceRefs(message);
    if (!refs.length) return { added: 0, total: this.get(message).length };

    const key = pendingAttachmentKey(message);
    const current = this.batches.get(key) || {
      refs: [],
      createdAt: this.now(),
      updatedAt: this.now(),
      overflow: 0,
    };
    const seen = new Set(current.refs.map(ref =>
      `${ref.sourceMessageId}:${ref.fileKey}`
    ));

    let added = 0;
    for (const ref of refs) {
      const id = `${ref.sourceMessageId}:${ref.fileKey}`;
      if (seen.has(id)) continue;
      if (current.refs.length >= this.maxAttachments) {
        current.overflow++;
        continue;
      }
      current.refs.push(ref);
      seen.add(id);
      added++;
    }
    current.updatedAt = this.now();
    this.batches.set(key, current);
    return {
      added,
      total: current.refs.length,
      overflow: current.overflow,
    };
  }

  get(message) {
    const key = pendingAttachmentKey(message);
    const batch = this.batches.get(key);
    if (!batch) return [];
    if (this.now() - batch.updatedAt > this.ttlMs) {
      this.batches.delete(key);
      return [];
    }
    return batch.refs.map(ref => ({ ...ref }));
  }

  info(message) {
    const refs = this.get(message);
    const batch = this.batches.get(pendingAttachmentKey(message));
    return {
      refs,
      overflow: batch?.overflow || 0,
    };
  }
  clear(message) {
    return this.batches.delete(pendingAttachmentKey(message));
  }

  sweep() {
    const now = this.now();
    let removed = 0;
    for (const [key, batch] of this.batches) {
      if (now - batch.updatedAt <= this.ttlMs) continue;
      this.batches.delete(key);
      removed++;
    }
    return removed;
  }

  size() {
    this.sweep();
    return this.batches.size;
  }
}

export const pendingAttachmentDefaults = Object.freeze({
  ttlMs: DEFAULT_TTL_MS,
  maxAttachments: DEFAULT_MAX_ATTACHMENTS,
});
