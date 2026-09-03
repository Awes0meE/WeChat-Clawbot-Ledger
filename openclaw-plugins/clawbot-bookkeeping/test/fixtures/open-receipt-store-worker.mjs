import { parentPort, workerData } from 'node:worker_threads';

import { SqliteReceiptStore } from '../../adapter.mjs';

parentPort.postMessage({ ready: true });
Atomics.wait(new Int32Array(workerData.barrier), 0, 0);

const store = new SqliteReceiptStore(workerData.path);
store.close();
parentPort.postMessage({ opened: true });
parentPort.close();
