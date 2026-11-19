// main.ts — entrypoint: the forge lifecycle.
//
// 1. Bind an ephemeral port (never 8080: that is the harness env's port).
// 2. When MAKEFUN_ENV_URL is set, register the port with the harness env
//    (POST $MAKEFUN_ENV_URL/register {"port": N}), then poll
//    GET $MAKEFUN_ENV_URL/done until {"done": true} and exit 0.
// 3. When MAKEFUN_ENV_URL is unset (local development only), serve on the
//    ephemeral port until killed, so the kit's local runner can dial it.
//
// The bearer token comes from MAKEFUN_SHOP_TOKEN. When it is unset, any
// non-empty bearer token is accepted (local development only).

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/register`;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
      throw new Error(`register answered HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      await sleep(200);
    }
  }
  throw new Error(`register failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitDone(): Promise<void> {
  const url = `${ENV_URL.replace(/\/+$/, '')}/done`;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // The env may not be up yet; keep polling.
    }
    await sleep(200);
  }
}

async function main(): Promise<void> {
  const { server } = createApp({ token: TOKEN });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (ENV_URL === '') {
    console.log(`forge listening on http://127.0.0.1:${port}`);
    return;
  }
  await register(port);
  await waitDone();
  server.close();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
