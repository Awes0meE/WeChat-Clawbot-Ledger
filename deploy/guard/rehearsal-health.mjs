try { process.exit((await fetch('http://127.0.0.1:18789/readyz', { signal: AbortSignal.timeout(1000) })).ok ? 0 : 1); }
catch { process.exit(1); }
