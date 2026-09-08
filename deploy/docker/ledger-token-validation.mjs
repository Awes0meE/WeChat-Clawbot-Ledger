import { createHmac, timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';
const fail = 'CLAWBOT_LEDGER_TOKEN_PAIR_REFUSED';
const int64 = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
function decode(part) {
  const bytes = Buffer.from(part, 'base64url');
  assert.ok(bytes.toString('base64url') === part, fail);
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
}
// Internal offline verification for the pinned ezBookkeeping 1.6.1 format.
// expectedUid MUST come from separately reviewed ledger identity, not from
// decoding one of the candidate tokens. This helper never creates/revokes one.
export function validateLedgerTokenPair({ tokens, expectedUid, findToken, userActive, now = Math.floor(Date.now()/1000) }) {
  try {
    assert.ok(int64(expectedUid) && Number.isSafeInteger(now) && now > 0 && userActive(expectedUid) === true, fail);
    assert.ok(tokens && Object.keys(tokens).sort().join(',') === 'http,mcp' && tokens.http !== tokens.mcp, fail);
    const expiresAt = {};
    for (const [role,type] of [['http',8],['mcp',5]]) {
      const text = tokens[role];
      assert.ok(typeof text === 'string' && text.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(text), fail);
      const [headerPart,claimsPart,signaturePart] = text.split('.'), header = decode(headerPart), claims = decode(claimsPart);
      assert.ok(header?.alg === 'HS256' && header.typ === 'JWT'
        && Object.keys(header).sort().join(',') === 'alg,typ', fail);
      assert.ok(claims?.jti === expectedUid && int64(claims.userTokenId) && claims.type === type
        && Number.isSafeInteger(claims.iat) && claims.iat > 0 && claims.iat <= now
        && Number.isSafeInteger(claims.exp) && claims.exp > now && claims.exp > claims.iat, fail);
      const record = findToken(expectedUid, claims.userTokenId, claims.iat);
      assert.ok(record && record.uid === BigInt(expectedUid) && record.user_token_id === BigInt(claims.userTokenId)
        && record.created_unix_time === BigInt(claims.iat) && record.token_type === BigInt(type)
        && record.expired_unix_time === BigInt(claims.exp) && typeof record.secret === 'string' && record.secret.length === 10, fail);
      const signature = Buffer.from(signaturePart, 'base64url');
      const expected = createHmac('sha256', record.secret).update(`${headerPart}.${claimsPart}`).digest();
      assert.ok(signature.toString('base64url') === signaturePart && signature.length === expected.length
        && timingSafeEqual(signature, expected), fail);
      expiresAt[role] = new Date(claims.exp*1000).toISOString();
    }
    return {version:1,status:'CLAWBOT_LEDGER_TOKEN_PAIR_VERIFIED_OFFLINE',sameAccount:true,
      exactTokenTypes:true,expiresAt,remoteVerified:false,businessWrites:false};
  } catch { throw new Error(fail); }
}

export function validateLedgerTokenPairInDatabase(db, tokens, expectedUid, now) {
  try {
    const token = db.prepare('SELECT uid,user_token_id,token_type,secret,created_unix_time,expired_unix_time FROM token_record WHERE uid=? AND user_token_id=? AND created_unix_time=? LIMIT 2');
    token.setReadBigInts(true);
    const user = db.prepare('SELECT uid,disabled,deleted FROM user WHERE uid=? LIMIT 2'); user.setReadBigInts(true);
    return validateLedgerTokenPair({tokens,expectedUid,now,
      findToken: (uid,id,issued) => { const rows = token.all(BigInt(uid),BigInt(id),BigInt(issued)); return rows.length===1 ? rows[0] : null; },
      userActive: uid => { const rows = user.all(BigInt(uid)); return rows.length===1 && rows[0].uid===BigInt(uid) && rows[0].disabled===0n && rows[0].deleted===0n; },
    });
  } catch { throw new Error(fail); }
}
