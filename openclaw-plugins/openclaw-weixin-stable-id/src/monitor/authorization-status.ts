/** Only fixed status markers leave the transport layer; never raw errors or identities. */
export function authorizationStatusForPoll(value: unknown): { connected: boolean; lastError: string | null } {
  const resp = value as { ret?: unknown; errcode?: unknown; localTransportTimeout?: unknown;
    msgs?: unknown; get_updates_buf?: unknown } | null;
  if (resp?.localTransportTimeout === true) return { connected: false, lastError: "CLAWBOT_WEIXIN_POLL_TIMEOUT" };
  if (resp?.ret === -14 || resp?.errcode === -14) return { connected: false, lastError: "CLAWBOT_WEIXIN_REAUTHORIZATION_REQUIRED" };
  const codes = [resp?.ret, resp?.errcode].filter(code => code !== undefined);
  if (codes.some(code => typeof code !== "number" || !Number.isSafeInteger(code))) {
    return { connected: false, lastError: "CLAWBOT_WEIXIN_RESPONSE_UNRECOGNIZED" };
  }
  if (codes.some(code => code !== 0)) return { connected: false, lastError: "CLAWBOT_WEIXIN_API_UNAVAILABLE" };
  // iLink can omit both zero-valued codes on a successful server response.
  // Require the actual poll envelope; an empty object or a local timeout is
  // not evidence of a successful authenticated request.
  if (!codes.length && !(Array.isArray(resp?.msgs)
    && typeof resp?.get_updates_buf === "string" && resp.get_updates_buf.trim().length > 0)) {
    return { connected: false, lastError: "CLAWBOT_WEIXIN_RESPONSE_UNRECOGNIZED" };
  }
  return { connected: true, lastError: null };
}
