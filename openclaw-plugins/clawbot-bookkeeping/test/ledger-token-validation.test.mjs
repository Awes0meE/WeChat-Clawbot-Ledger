import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {validateLedgerTokenPair} from '../../../deploy/docker/ledger-token-validation.mjs';
const expectedUid='9007199254740993', now=1800000000, secret='synthetic!';
const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
function fixture() {
  const records = new Map();
  const sign = (type, extra={}, key=secret, header={alg:'HS256',typ:'JWT'}) => {
    const claims={jti:expectedUid,userTokenId:String(9007199254740994n+BigInt(type)),type,iat:now-60,exp:now+600,...extra};
    records.set(claims.userTokenId,{uid:BigInt(claims.jti),user_token_id:BigInt(claims.userTokenId),token_type:BigInt(type),
      created_unix_time:BigInt(claims.iat),expired_unix_time:BigInt(claims.exp),secret});
    const body=encode(header)+'.'+encode(claims);return body+'.'+createHmac('sha256',key).update(body).digest('base64url');
  };
  const tokens={http:sign(8),mcp:sign(5)};
  return {tokens,expectedUid,now,sign,records,userActive:()=>true,findToken:(_uid,id)=>records.get(id)};
}
const rejected = f => assert.throws(()=>validateLedgerTokenPair(f), error=>error.message==='CLAWBOT_LEDGER_TOKEN_PAIR_REFUSED');
test('correct signatures and stored records preserve integer identity beyond JS safe integer range',()=>{
  const f=fixture(), report=validateLedgerTokenPair(f);
  assert.equal(report.sameAccount,true);assert.equal(report.remoteVerified,false);assert.equal(report.businessWrites,false);
  assert.doesNotMatch(JSON.stringify(report),new RegExp(`${expectedUid}|${secret}`));
});
test('wrong signature, different owner and swapped token types are refused',()=>{
  for(const kind of ['signature','owner','types']) {
    const f=fixture();
    if(kind==='signature') f.tokens.http=f.sign(8,{},'wrong-key!');
    if(kind==='owner') f.tokens.http=f.sign(8,{jti:'9007199254740995'});
    if(kind==='types') [f.tokens.http,f.tokens.mcp]=[f.tokens.mcp,f.tokens.http];
    rejected(f);
  }
});
test('expired, future-issued, revoked and disabled credentials are refused',()=>{
  for(const kind of ['expired','future','revoked','disabled','record-type','record-expiry']) {
    const f=fixture();
    if(kind==='expired') f.tokens.http=f.sign(8,{exp:now});
    if(kind==='future') f.tokens.http=f.sign(8,{iat:now+1});
    if(kind==='revoked') f.records.clear();
    if(kind==='disabled') f.userActive=()=>false;
    if(kind==='record-type') [...f.records.values()][0].token_type=1n;
    if(kind==='record-expiry') [...f.records.values()][0].expired_unix_time=BigInt(now-1);
    rejected(f);
  }
});
test('unexpected algorithms, critical headers and noncanonical or rounded identity are refused',()=>{
  for(const header of [{alg:'none',typ:'JWT'},{alg:'HS512',typ:'JWT'},{alg:'HS256',typ:'JWT',crit:['unknown']}]) {
    const f=fixture();f.tokens.http=f.sign(8,{},secret,header);rejected(f);
  }
  const padded=fixture();padded.tokens.http+='=';rejected(padded);
  const rounded=fixture();rounded.expectedUid=Number(expectedUid);rejected(rounded);
  const duplicate=fixture();duplicate.tokens.mcp=duplicate.tokens.http;rejected(duplicate);
});
