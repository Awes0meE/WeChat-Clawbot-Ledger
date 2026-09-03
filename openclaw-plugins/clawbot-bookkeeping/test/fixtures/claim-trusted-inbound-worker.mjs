import { parentPort, workerData } from 'node:worker_threads';

import { SqliteReceiptStore } from '../../adapter.mjs';

const store = new SqliteReceiptStore(workerData.path);
parentPort.postMessage({ ready: true });
Atomics.wait(new Int32Array(workerData.barrier), 0, 0);

try {
  const result = store.claimTrustedInbound([workerData.lookupKey], workerData.now);
  parentPort.postMessage({ result: result ?? null });
} finally {
  store.close();
}
