/**
 * What the Learn sync token can and cannot do, checked against the real app.
 *
 *   npx tsx scripts/check-learn-token.ts
 *
 * No database is needed: every refusal happens before a route runs, and the
 * one allowed request only has to get past authentication (it may then fail to
 * reach a database, which is a 500, not a 401).
 */
process.env.LEARN_READ_TOKEN = 'test-learn-read-token';
process.env.GATEWAY_TOKEN = 'test-gateway-token';

const { createApp } = await import('../src/app.js');
const app = createApp();

const TOKEN = `Bearer ${process.env.LEARN_READ_TOKEN}`;
let failed = 0;

async function expect(label: string, path: string, init: RequestInit, check: (status: number) => boolean) {
  const res = await app.request(path, init);
  const ok = check(res.status);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} (${res.status})`);
}

const refused = (s: number) => s === 401;

await expect('the token reads sessions', '/learn/sessions', { headers: { authorization: TOKEN } }, (s) => s !== 401 && s !== 403);
await expect('no token is refused', '/learn/sessions', {}, refused);
await expect('a wrong token is refused', '/learn/sessions', { headers: { authorization: 'Bearer nope' } }, refused);
await expect('the token without "Bearer" is refused', '/learn/sessions', { headers: { authorization: process.env.LEARN_READ_TOKEN! } }, refused);
await expect('the token cannot write a session', '/learn/sessions', { method: 'POST', headers: { authorization: TOKEN, 'content-type': 'application/json' }, body: '{}' }, refused);
await expect('the token cannot delete a session', '/learn/sessions/1', { method: 'DELETE', headers: { authorization: TOKEN } }, refused);
await expect('the token cannot read other Learn paths', '/learn/state', { headers: { authorization: TOKEN } }, refused);
await expect('the token opens nothing outside Learn', '/releases', { headers: { authorization: TOKEN } }, refused);
await expect('the token is not a gateway token', '/learn/sessions', { headers: { 'x-gateway-token': process.env.LEARN_READ_TOKEN!, 'x-platform-user': 'x@example.com', 'x-platform-app': 'stacks' } }, refused);

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
