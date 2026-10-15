export function quoteResponse(code = '204320', sign = '2', rate = '1.25') {
  return { rt_cd: '0', output: { stck_shrn_iscd: code, stck_prpr: '45000', prdy_vrss_sign: sign, prdy_ctrt: rate } };
}

export function tokenResponse(now: number, seconds = 86400) {
  const expires = new Date(now + seconds * 1000 + 9 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  return { access_token: 'synthetic-access-token', token_type: 'Bearer', expires_in: seconds, access_token_token_expired: expires };
}

export async function settle(): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); }
