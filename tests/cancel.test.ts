import { describe, expect, it } from 'vitest';
import { ValenceClient } from '../src/lib/valence';

describe('cancelling', () => {
  it('aborts a request that is in flight, without retrying', async () => {
    let calls = 0;
    const hanging: typeof fetch = (_url, init) => {
      calls++;
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    };
    const api = new ValenceClient(hanging, 1);
    const ctl = new AbortController();
    api.signal = ctl.signal;
    const pending = api.fetchFile(1, 2);
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

  it('refuses new requests once cancelled, and works again without a signal', async () => {
    let calls = 0;
    const ok: typeof fetch = async () => {
      calls++;
      return new Response('{"a":1}');
    };
    const api = new ValenceClient(ok, 1);
    const ctl = new AbortController();
    api.signal = ctl.signal;
    ctl.abort();
    await expect(api.get('/x')).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
    api.signal = undefined;
    expect(await api.get('/x')).toEqual({ a: 1 });
  });
});
