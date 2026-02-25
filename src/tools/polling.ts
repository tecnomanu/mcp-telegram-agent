/**
 * Internal polling state shared with await-reply.
 * No public tools are registered here — the background polling and sampling
 * experiment tools were removed after confirming Cursor lacks sampling support.
 * Backed-up originals live in _backup/.
 */

let lastUpdateId = 0;

export function getLastUpdateId(): number {
  return lastUpdateId;
}

export function setLastUpdateId(id: number): void {
  lastUpdateId = id;
}
