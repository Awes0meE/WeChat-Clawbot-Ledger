import { createHash } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const LEDGER_HOST = 'ledger.66ccff-labs.com';
const PORTFOLIO_HOSTS = Object.freeze(['66ccff-labs.com', 'www.66ccff-labs.com']);
const ALLOWED_HOSTS = new Set([LEDGER_HOST, ...PORTFOLIO_HOSTS]);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code) {
  const error = new Error(code);
  error.safeCode = code;
  throw error;
}

function parseArguments(values) {
  const options = {
    timeoutMs: 10_000,
    capture: false,
    compare: false,
    baselinePath: '',
    apiTokenPath: '',
    mcpTokenPath: '',
    verifyRateLimit: false,
    validateFreeGate: false,
    freeRateLimitEvidencePath: '',
    expectLedgerUnavailable: false,
    preHstsValidation: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    const nextValue = () => {
      index += 1;
      if (index >= values.length || values[index].startsWith('--')) fail('LEDGER_PUBLIC_ARGUMENT_INVALID');
      return values[index];
    };
    switch (name) {
      case '--timeout-ms': options.timeoutMs = Number(nextValue()); break;
      case '--baseline': options.baselinePath = nextValue(); break;
      case '--capture': options.capture = true; break;
      case '--compare': options.compare = true; break;
      case '--api-token-path': options.apiTokenPath = nextValue(); break;
      case '--mcp-token-path': options.mcpTokenPath = nextValue(); break;
      case '--verify-rate-limit': options.verifyRateLimit = true; break;
      case '--validate-free-rate-limit-gate': options.validateFreeGate = true; break;
      case '--free-rate-limit-evidence': options.freeRateLimitEvidencePath = nextValue(); break;
      case '--expect-ledger-unavailable': options.expectLedgerUnavailable = true; break;
      case '--pre-hsts-validation': options.preHstsValidation = true; break;
      default: fail('LEDGER_PUBLIC_ARGUMENT_INVALID');
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000 || options.timeoutMs > 30_000) {
    fail('LEDGER_PUBLIC_TIMEOUT_INVALID');
  }
  if (options.capture && options.compare) fail('LEDGER_PUBLIC_BASELINE_MODE_CONFLICT');
  if ((options.capture || options.compare) && !options.baselinePath) fail('LEDGER_PUBLIC_BASELINE_REQUIRED');
  if (options.expectLedgerUnavailable
      && (!options.compare || options.apiTokenPath || options.mcpTokenPath || options.verifyRateLimit || options.validateFreeGate)) {
    fail('LEDGER_PUBLIC_ARGUMENT_INVALID');
  }
  if (options.validateFreeGate
      && (!options.freeRateLimitEvidencePath || options.capture || options.expectLedgerUnavailable
        || options.apiTokenPath || options.mcpTokenPath || options.verifyRateLimit)) {
    fail('LEDGER_PUBLIC_ARGUMENT_INVALID');
  }
  if (!options.validateFreeGate && options.freeRateLimitEvidencePath) fail('LEDGER_PUBLIC_ARGUMENT_INVALID');
  if (options.preHstsValidation && (options.capture || options.expectLedgerUnavailable || options.validateFreeGate)) {
    fail('LEDGER_PUBLIC_ARGUMENT_INVALID');
  }
  if (!options.capture && !options.expectLedgerUnavailable && !options.validateFreeGate && !options.apiTokenPath) {
    fail('LEDGER_PUBLIC_API_TOKEN_REQUIRED');
  }
  return options;
}

function normalizedExternalPath(path, code) {
  if (!path || typeof path !== 'string' || !isAbsolute(path) || /^[\\/]{2}/u.test(path)) fail(code);
  const fullPath = resolve(path);
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/u.test(fullPath)) fail(code);
  const relation = relative(REPOSITORY_ROOT, fullPath);
  if (relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
      || /[\\/]OneDrive(?:\s|[\\/]|$)/iu.test(fullPath)) fail(code);
  let cursor = fullPath;
  for (;;) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail(code);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return fullPath;
}

function assertSafeUri(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
      || !ALLOWED_HOSTS.has(url.hostname)
      || url.username !== ''
      || url.password !== ''
      || url.port !== '') {
    fail('LEDGER_PUBLIC_URI_POLICY_FAILED');
  }
  return url;
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(', ');
  return value == null ? '' : String(value);
}

function request({ method, url: value, headers = {}, jsonBody, readBody = false }, timeoutMs) {
  const url = assertSafeUri(value);
  const transport = url.protocol === 'https:' ? https : http;
  const bodyBytes = jsonBody === undefined ? null : Buffer.from(jsonBody, 'utf8');
  const requestHeaders = { ...headers };
  if (bodyBytes) {
    requestHeaders['Content-Type'] = 'application/json; charset=utf-8';
    requestHeaders['Content-Length'] = String(bodyBytes.length);
  }

  return new Promise((resolveRequest, rejectRequest) => {
    let settled = false;
    const rejectSafe = (code) => {
      if (settled) return;
      settled = true;
      rejectRequest(Object.assign(new Error(code), { safeCode: code }));
    };
    const req = transport.request(url, {
      method,
      headers: requestHeaders,
      agent: false,
      rejectUnauthorized: true,
      servername: url.hostname,
      signal: AbortSignal.timeout(timeoutMs),
    }, (response) => {
      const chunks = [];
      let length = 0;
      response.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) {
          response.destroy();
          rejectSafe('LEDGER_PUBLIC_RESPONSE_TOO_LARGE');
          return;
        }
        if (readBody) chunks.push(chunk);
      });
      response.on('error', () => rejectSafe('LEDGER_PUBLIC_RESPONSE_FAILED'));
      response.on('end', () => {
        if (settled) return;
        let body = '';
        try {
          if (readBody) body = decoder.decode(Buffer.concat(chunks));
        } catch {
          rejectSafe('LEDGER_PUBLIC_RESPONSE_ENCODING_FAILED');
          return;
        }
        settled = true;
        resolveRequest({
          statusCode: Number(response.statusCode),
          headers: response.headers,
          body,
          bodyBytes: length,
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      rejectSafe('LEDGER_PUBLIC_REQUEST_TIMEOUT');
    });
    req.on('error', () => rejectSafe('LEDGER_PUBLIC_REQUEST_FAILED'));
    if (bodyBytes) req.write(bodyBytes);
    req.end();
  });
}

async function dnsSnapshot(hostname) {
  try {
    const answers = await dns.resolveCname(hostname);
    const cnameTargets = [...new Set(answers.map((answer) => answer.toLowerCase().replace(/\.$/u, '')))].sort();
    if (cnameTargets.length === 0) fail('LEDGER_PUBLIC_DNS_EMPTY');
    return { mode: 'cname', cnameTargets };
  } catch (error) {
    if (error?.safeCode) throw error;
    const isFlattenedApex = error?.code === 'ENODATA' && hostname === PORTFOLIO_HOSTS[0];
    if (!isFlattenedApex) {
      fail('LEDGER_PUBLIC_DNS_FAILED');
    }

    const addressResults = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);
    const unsupportedFailure = addressResults.some((result) => (
      result.status === 'rejected' && result.reason?.code !== 'ENODATA'
    ));
    const hasRoutableAnswer = addressResults.some((result) => (
      result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0
    ));
    if (unsupportedFailure || !hasRoutableAnswer) fail('LEDGER_PUBLIC_DNS_FAILED');

    // Cloudflare flattens apex CNAMEs. Record only that stable public shape;
    // rotating CDN addresses are deliberately verified for presence but not persisted.
    return { mode: 'flattened-apex', cnameTargets: [] };
  }
}

function textSha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function portfolioSnapshot(timeoutMs) {
  const entries = [];
  for (const hostname of PORTFOLIO_HOSTS) {
    const plain = await request({
      method: 'GET',
      url: `http://${hostname}/ledger-portfolio-regression?probe=1`,
    }, timeoutMs);
    const secure = await request({ method: 'GET', url: `https://${hostname}/`, readBody: true }, timeoutMs);
    if (secure.statusCode < 200 || secure.statusCode >= 400 || secure.body.length === 0) {
      fail('LEDGER_PUBLIC_PORTFOLIO_HTTPS_FAILED');
    }
    entries.push({
      host: hostname,
      dns: await dnsSnapshot(hostname),
      httpStatus: plain.statusCode,
      httpLocation: headerValue(plain.headers, 'location'),
      httpsStatus: secure.statusCode,
      httpsLocation: headerValue(secure.headers, 'location'),
      responseHeaders: {
        cacheControl: headerValue(secure.headers, 'cache-control'),
        contentSecurityPolicy: headerValue(secure.headers, 'content-security-policy'),
        contentType: headerValue(secure.headers, 'content-type'),
        referrerPolicy: headerValue(secure.headers, 'referrer-policy'),
        strictTransportSecurity: headerValue(secure.headers, 'strict-transport-security'),
        xContentTypeOptions: headerValue(secure.headers, 'x-content-type-options'),
        xFrameOptions: headerValue(secure.headers, 'x-frame-options'),
      },
      bodyBytes: Buffer.byteLength(secure.body, 'utf8'),
      bodySha256: textSha256(secure.body),
    });
    secure.body = '';
  }
  return entries;
}

function readBaseline(path) {
  try {
    const document = JSON.parse(decoder.decode(readFileSync(path)));
    if (document?.schemaVersion !== 2 || !Array.isArray(document.entries) || document.entries.length !== 2) {
      fail('LEDGER_PUBLIC_BASELINE_INVALID');
    }
    for (const entry of document.entries) {
      const cnameTargets = entry?.dns?.cnameTargets;
      const cnameShape = entry?.dns?.mode === 'cname'
        && Array.isArray(cnameTargets)
        && cnameTargets.length > 0;
      const flattenedApexShape = entry?.host === PORTFOLIO_HOSTS[0]
        && entry?.dns?.mode === 'flattened-apex'
        && Array.isArray(cnameTargets)
        && cnameTargets.length === 0;
      if (!PORTFOLIO_HOSTS.includes(entry?.host) || (!cnameShape && !flattenedApexShape)) {
        fail('LEDGER_PUBLIC_BASELINE_INVALID');
      }
    }
    return document;
  } catch (error) {
    if (error?.safeCode) throw error;
    fail('LEDGER_PUBLIC_BASELINE_INVALID');
  }
}

function saveBaseline(path, entries) {
  if (existsSync(path)) fail('LEDGER_PUBLIC_BASELINE_EXISTS');
  const parent = dirname(path);
  if (!existsSync(parent) || !lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) {
    fail('LEDGER_PUBLIC_BASELINE_PARENT_INVALID');
  }
  const temporary = resolve(parent, `.ledger-portfolio-${process.pid}-${Date.now()}.tmp`);
  try {
    const payload = `${JSON.stringify({ schemaVersion: 2, capturedUtc: new Date().toISOString(), entries }, null, 2)}\n`;
    writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    rmSync(temporary, { force: true });
    fail('LEDGER_PUBLIC_BASELINE_WRITE_FAILED');
  }
}

function compareBaseline(path, actual) {
  const expected = readBaseline(path);
  for (const actualEntry of actual) {
    const matches = expected.entries.filter((entry) => entry?.host === actualEntry.host);
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], actualEntry)) {
      fail('LEDGER_PUBLIC_PORTFOLIO_REGRESSION');
    }
  }
}

function readToken(path) {
  let bytes;
  let token;
  try {
    bytes = readFileSync(path);
    token = decoder.decode(bytes).trim();
  } catch {
    fail('LEDGER_PUBLIC_CREDENTIAL_READ_FAILED');
  } finally {
    if (bytes) bytes.fill(0);
  }
  if (!token || /[\r\n]/u.test(token) || token.length > 8192) fail('LEDGER_PUBLIC_CREDENTIAL_INVALID');
  return token;
}

async function assertLedgerSurface(timeoutMs, preHstsValidation) {
  const suffix = '/ledger-acceptance/path?probe=1';
  const redirect = await request({ method: 'GET', url: `http://${LEDGER_HOST}${suffix}` }, timeoutMs);
  if (redirect.statusCode !== 301
      || headerValue(redirect.headers, 'location') !== `https://${LEDGER_HOST}${suffix}`) {
    fail('LEDGER_PUBLIC_REDIRECT_FAILED');
  }

  const root = await request({ method: 'GET', url: `https://${LEDGER_HOST}/`, readBody: true }, timeoutMs);
  if (root.statusCode !== 200 || !root.body.includes('ezBookkeeping') || !/id=["']app["']/u.test(root.body)) {
    fail('LEDGER_PUBLIC_LOGIN_FINGERPRINT_FAILED');
  }
  if (/cloudflareaccess\.com|cdn-cgi\/access/iu.test(headerValue(root.headers, 'location'))) {
    fail('LEDGER_PUBLIC_ACCESS_DETECTED');
  }
  const expectedHeaders = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow, noarchive',
  };
  for (const [name, expected] of Object.entries(expectedHeaders)) {
    if (headerValue(root.headers, name) !== expected) fail('LEDGER_PUBLIC_SECURITY_HEADERS_FAILED');
  }
  const hsts = headerValue(root.headers, 'strict-transport-security');
  const hstsMatch = /^max-age=([0-9]+)$/iu.exec(hsts);
  if (preHstsValidation && hsts !== '') fail('LEDGER_PUBLIC_HSTS_PREMATURE');
  if (!preHstsValidation && (!hstsMatch || Number(hstsMatch[1]) < 86400)) {
    fail('LEDGER_PUBLIC_HSTS_FAILED');
  }
  assertNotCached(root);
  root.body = '';

  const registration = await request({
    method: 'POST',
    url: `https://${LEDGER_HOST}/api/register.json`,
    jsonBody: '{}',
  }, timeoutMs);
  if (registration.statusCode !== 403) fail('LEDGER_PUBLIC_REGISTRATION_NOT_BLOCKED');
  assertNotCached(registration);
  const trace = await request({ method: 'TRACE', url: `https://${LEDGER_HOST}/` }, timeoutMs);
  if (![403, 405].includes(trace.statusCode)) fail('LEDGER_PUBLIC_TRACE_NOT_BLOCKED');
  assertNotCached(trace);
}

function assertNotCached(response) {
  const cacheStatus = headerValue(response.headers, 'cf-cache-status').trim();
  if (/^(HIT|STALE|REVALIDATED|UPDATING)$/iu.test(cacheStatus)) fail('LEDGER_PUBLIC_CACHE_FAILED');
  const cacheControl = headerValue(response.headers, 'cache-control');
  if (/(?:^|,)\s*public\b|max-age=[1-9]/iu.test(cacheControl)) fail('LEDGER_PUBLIC_CACHE_FAILED');
}

async function assertCredentialRejected(kind, tokenPath, timeoutMs) {
  let token = readToken(tokenPath);
  let response;
  let document;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (kind === 'api') {
      response = await request({
        method: 'GET',
        url: `https://${LEDGER_HOST}/api/v1/accounts/list.json`,
        headers,
        readBody: true,
      }, timeoutMs);
    } else {
      response = await request({
        method: 'POST',
        url: `https://${LEDGER_HOST}/mcp`,
        headers,
        jsonBody: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"boundary-probe","version":"1"}}}',
        readBody: true,
      }, timeoutMs);
    }
    const allowedStatuses = kind === 'api' ? [401, 403] : [401, 403, 404];
    if (response.statusCode === 400) {
      try {
        document = JSON.parse(response.body);
      } catch {
        fail('LEDGER_PUBLIC_CREDENTIAL_BOUNDARY_FAILED');
      } finally {
        response.body = '';
      }
      if (!document || typeof document !== 'object' || Array.isArray(document)
          || document.success !== false || document.errorCode !== 200020
          || document.path !== (kind === 'api' ? '/api/v1/accounts/list.json' : '/mcp')) {
        fail('LEDGER_PUBLIC_CREDENTIAL_BOUNDARY_FAILED');
      }
    } else if (!allowedStatuses.includes(response.statusCode)) {
      fail('LEDGER_PUBLIC_CREDENTIAL_BOUNDARY_FAILED');
    }
    assertNotCached(response);
  } finally {
    if (response) response.body = '';
    document = null;
    token = null;
  }
}

function readFreeRateLimitEvidence(path) {
  try {
    if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      fail('LEDGER_PUBLIC_RATE_LIMIT_EVIDENCE_INVALID');
    }
    const document = JSON.parse(decoder.decode(readFileSync(path)));
    const keys = Object.keys(document ?? {}).sort().join(',');
    if (keys !== 'capturedUtc,existingRateLimitRuleCount,rulesetPhase,schemaVersion,source,zoneName'
        || document.schemaVersion !== 1
        || document.source !== 'cloudflare-api-readback'
        || document.zoneName !== '66ccff-labs.com'
        || document.rulesetPhase !== 'http_ratelimit'
        || document.existingRateLimitRuleCount !== 0) {
      fail('LEDGER_PUBLIC_RATE_LIMIT_EVIDENCE_INVALID');
    }
    const capturedAt = Date.parse(document.capturedUtc);
    const ageMs = Date.now() - capturedAt;
    if (!Number.isFinite(capturedAt) || ageMs < -5 * 60 * 1000 || ageMs > 15 * 60 * 1000) {
      fail('LEDGER_PUBLIC_RATE_LIMIT_EVIDENCE_STALE');
    }
  } catch (error) {
    if (error?.safeCode) throw error;
    fail('LEDGER_PUBLIC_RATE_LIMIT_EVIDENCE_INVALID');
  }
}

async function assertFreeRateLimitGate(evidencePath, timeoutMs) {
  readFreeRateLimitEvidence(evidencePath);
  const path = '/api/authorize.json';
  const probes = [];
  for (const hostname of PORTFOLIO_HOSTS) {
    for (const method of ['GET', 'POST']) {
      probes.push({ hostname, method });
    }
  }
  const responses = await Promise.all(probes.map(({ hostname, method }) => request({
    method,
    url: `https://${hostname}${path}`,
    ...(method === 'POST' ? { jsonBody: '{}' } : {}),
  }, timeoutMs)));
  for (let index = 0; index < probes.length; index += 1) {
    const { hostname } = probes[index];
    const response = responses[index];
    const unused = [404, 405, 410].includes(response.statusCode)
      || (hostname === '66ccff-labs.com'
        && [307, 308].includes(response.statusCode)
        && headerValue(response.headers, 'location') === 'https://www.66ccff-labs.com/api/authorize.json');
    if (!unused) fail('LEDGER_PUBLIC_RATE_LIMIT_PATH_COLLISION');
  }
}

async function assertRateLimit(timeoutMs) {
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const response = await request({
      method: 'POST',
      url: `https://${LEDGER_HOST}/api/authorize.json`,
      jsonBody: '{}',
    }, timeoutMs);
    assertNotCached(response);
    if (response.statusCode === 429) return;
  }
  fail('LEDGER_PUBLIC_RATE_LIMIT_NOT_OBSERVED');
}

async function assertLedgerUnavailable(timeoutMs) {
  try {
    const response = await request({ method: 'GET', url: `https://${LEDGER_HOST}/` }, timeoutMs);
    if (response.statusCode >= 200 && response.statusCode < 300) {
      fail('LEDGER_PUBLIC_FAIL_CLOSED_VIOLATION');
    }
  } catch (error) {
    if (error?.safeCode === 'LEDGER_PUBLIC_FAIL_CLOSED_VIOLATION') throw error;
    if (typeof error?.safeCode === 'string' && /^LEDGER_PUBLIC_(?:REQUEST|RESPONSE)_/u.test(error.safeCode)) return;
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const hardTimeoutMs = Math.min(60_000, Math.max(15_000, options.timeoutMs * 6));
  const hardTimeout = setTimeout(() => {
    process.stderr.write('LEDGER_PUBLIC_ACCEPTANCE_TIMEOUT\n');
    process.exit(1);
  }, hardTimeoutMs);
  let baselinePath = '';
  try {
    if (options.capture || options.compare) {
      baselinePath = normalizedExternalPath(options.baselinePath, 'LEDGER_PUBLIC_BASELINE_PATH_UNSAFE');
      if (options.capture && existsSync(baselinePath)) fail('LEDGER_PUBLIC_BASELINE_EXISTS');
      if (options.compare && !existsSync(baselinePath)) fail('LEDGER_PUBLIC_BASELINE_MISSING');
    }
    if (options.apiTokenPath) {
      options.apiTokenPath = normalizedExternalPath(options.apiTokenPath, 'LEDGER_PUBLIC_CREDENTIAL_PATH_UNSAFE');
    }
    if (options.mcpTokenPath) {
      options.mcpTokenPath = normalizedExternalPath(options.mcpTokenPath, 'LEDGER_PUBLIC_CREDENTIAL_PATH_UNSAFE');
    }
    if (options.freeRateLimitEvidencePath) {
      options.freeRateLimitEvidencePath = normalizedExternalPath(
        options.freeRateLimitEvidencePath,
        'LEDGER_PUBLIC_RATE_LIMIT_EVIDENCE_PATH_UNSAFE',
      );
    }

    const portfolio = await portfolioSnapshot(options.timeoutMs);
    if (options.capture) {
      saveBaseline(baselinePath, portfolio);
      process.stdout.write('LEDGER_PUBLIC_ACCEPTANCE_OK\n');
      return;
    }
    if (options.compare) compareBaseline(baselinePath, portfolio);
    if (options.validateFreeGate) {
      await assertFreeRateLimitGate(options.freeRateLimitEvidencePath, options.timeoutMs);
      process.stdout.write('LEDGER_PUBLIC_ACCEPTANCE_OK\n');
      return;
    }

    if (options.expectLedgerUnavailable) {
      await assertLedgerUnavailable(options.timeoutMs);
    } else {
      await assertLedgerSurface(options.timeoutMs, options.preHstsValidation);
      if (options.apiTokenPath) await assertCredentialRejected('api', options.apiTokenPath, options.timeoutMs);
      if (options.mcpTokenPath) await assertCredentialRejected('mcp', options.mcpTokenPath, options.timeoutMs);
      if (options.verifyRateLimit) await assertRateLimit(options.timeoutMs);
    }
  } finally {
    clearTimeout(hardTimeout);
  }
  process.stdout.write('LEDGER_PUBLIC_ACCEPTANCE_OK\n');
}

main().catch((error) => {
  const safeCode = typeof error?.safeCode === 'string' && /^LEDGER_PUBLIC_[A-Z0-9_]+$/u.test(error.safeCode)
    ? error.safeCode
    : 'LEDGER_PUBLIC_ACCEPTANCE_FAILED';
  process.stderr.write(`${safeCode}\n`);
  process.exitCode = 1;
});
