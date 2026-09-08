import { verifyGenerationReceipts } from './generation-receipts.mjs';
try {
  verifyGenerationReceipts('/generation', JSON.parse(process.argv[2]));
  console.log('CLAWBOT_RECOVERY_GENERATION_COMPLETE');
} catch { console.error('CLAWBOT_RECOVERY_GENERATION_INCOMPLETE'); process.exitCode = 1; }
