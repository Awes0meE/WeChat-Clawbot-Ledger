import { applySingleCredentialUpdate } from './single-credential-operation.mjs';
export function applyWeixinImport(options) {
  return applySingleCredentialUpdate({...options,kind:'weixin'});
}
