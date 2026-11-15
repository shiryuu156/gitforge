// GitForge entrypoint — the lifecycle between this process and the trial env.
// The env (MAKEFUN_ENV_URL) drives the trial: we bind an ephemeral port, register it,
// then poll until the env says the trial is over and exit 0.
//
//   1. Without MAKEFUN_ENV_URL there is no env to talk to: exit 1 immediately.
//   2. Create the forge server and listen(0) — the kernel picks a free port. Never
//      bind 8080: the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. The env records the request's
//      origin plus N as our base URL and dials it from then on. The first register
//      wins; a 409 means another entry already registered, and we keep waiting.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env answers
//      at once ({"done": false} while the suite runs), so this is a poll, not a
//      long-held request. Failed or slow polls retry with exponential backoff; the
//      process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which writes the
//      export the scorer reads.
//
// main.ts imports only its own server: no package, no Node built-in, no model call.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[gitforge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request may take this long before it is abandoned and retried.
const REQUEST_DEADLINE_MS = 30_000;
// Backoff bounds between retries.
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Wait after `failures` failed requests: exponential from BACKOFF_START_MS, capped.
function backoff(failures: number): number {
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS * 2 ** Math.min(failures, 8));
}

// POST the bound port until the env accepts it. 200 is the normal answer; 409 means a
// first register already won, which is not this process's to fix. 400 and 405 are
// contract errors and end the program; a network error or another status is retried,
// since the env may still be starting.
async function announcePort(port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await pause(backoff(failures));
  }
}

// Poll GET /done until it answers {"done":true}; never return before that.
async function awaitTrialEnd(): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    try {
      const reply = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
      });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await pause(backoff(failures));
  }
}

// Bind the port, register it, then wait for the env: the whole life of the process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[gitforge] listening on port ${bound.port}\n`);

  await announcePort(bound.port);
  process.stdout.write('[gitforge] registered; waiting for the env to say done\n');

  await awaitTrialEnd();
  server.close();
  process.stdout.write('[gitforge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[gitforge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
