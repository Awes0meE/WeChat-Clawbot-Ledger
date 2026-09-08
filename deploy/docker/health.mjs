const response = await fetch('http://127.0.0.1:18789/readyz', { signal: AbortSignal.timeout(2500), redirect: 'error' });
process.exit(response.ok ? 0 : 1);
