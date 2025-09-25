import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import type { DurableObjectStub } from '@cloudflare/workers-types';

const JSON_HEADERS = new Headers({ 'content-type': 'application/json' });
const TTL_BUFFER_MS = 15 * 60 * 1000 + 60_000; // align with server TTL and add safety margin
const FAL_QUEUE_ORIGIN = 'https://queue.fal.run';
const FAL_MODEL_PATH = '/fal-ai/flux-kontext/dev';
const MOCK_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2P4z/C/HwAFgwJ/lwH1YQAAAABJRU5ErkJggg=='
const DEFAULT_ROOM = 'global';
const ALT_ROOM = 'party-test';

let defaultRoomSlug = DEFAULT_ROOM;
let altRoomSlug = ALT_ROOM;

let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;
let mockJobCounter = 0;
const mockJobs = new Map<string, string>();

function buildMockJobUrls(jobId: string) {
  const base = `${FAL_QUEUE_ORIGIN}${FAL_MODEL_PATH}/requests/${jobId}`;
  return {
    base,
    status: `${base}/status`,
  };
}

beforeAll(() => {
  const originalFetch = globalThis.fetch;
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (url.origin === FAL_QUEUE_ORIGIN && url.pathname.startsWith(`${FAL_MODEL_PATH}`)) {
      if (method === 'POST') {
        const jobId = `mock-job-${mockJobCounter++}`;
        const { base, status } = buildMockJobUrls(jobId);
        mockJobs.set(jobId, base);
        return new Response(
          JSON.stringify({
            request_id: jobId,
            status_url: status,
            response_url: base,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const match = /\/requests\/([^/]+)(?:\/status)?$/.exec(url.pathname);
      if (match) {
        const jobId = match[1];
        const base = mockJobs.get(jobId) ?? `${FAL_QUEUE_ORIGIN}${FAL_MODEL_PATH}/requests/${jobId}`;
        if (url.pathname.endsWith('/status')) {
          return new Response(
            JSON.stringify({
              request_id: jobId,
              status: 'COMPLETED',
              status_url: `${base}/status`,
              response_url: base,
              logs: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        return new Response(
          JSON.stringify({
            request_id: jobId,
            images: [
              {
                url: MOCK_IMAGE_DATA_URL,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    return originalFetch(input as any, init);
  });
});

afterAll(() => {
  fetchSpy?.mockRestore();
});

async function postOp(stub: DurableObjectStub, prompt: string, opId: string, roomSlug: string = defaultRoomSlug) {
  const body = JSON.stringify({ prompt, op_id: opId });
  const headers = new Headers(JSON_HEADERS);
  headers.set('x-room-id', roomSlug);
  headers.set('x-test-sync', '1');
  const request = new Request('https://example.com/ops', {
    method: 'POST',
    headers,
    body,
  });
  const response = await stub.fetch(request);
  const json = await response.json();
  return { status: response.status, json };
}

async function waitForVersion(stub: DurableObjectStub, version: number, timeoutMs = 2_000, roomSlug: string = defaultRoomSlug) {
  const deadline = Date.now() + timeoutMs;
  const headers = new Headers({ 'x-room-id': roomSlug });
  while (Date.now() < deadline) {
    const stateResp = await stub.fetch(new Request('https://example.com/state', { headers }));
    const stateJson = await stateResp.json();
    if (stateJson?.version >= version) return stateJson;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for version ${version}`);
}

async function getState(stub: DurableObjectStub, roomSlug: string) {
  const headers = new Headers({ 'x-room-id': roomSlug });
  const response = await stub.fetch(new Request('https://example.com/state', { headers }));
  return await response.json();
}

function getStub(roomSlug: string = defaultRoomSlug) {
  const id = env.ROOM_DO.idFromName(roomSlug);
  return env.ROOM_DO.get(id);
}

beforeEach(async () => {
  mockJobCounter = 0;
  mockJobs.clear();
  defaultRoomSlug = `${DEFAULT_ROOM}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  altRoomSlug = `${ALT_ROOM}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await resetRoom(getStub(defaultRoomSlug), defaultRoomSlug);
  await resetRoom(getStub(altRoomSlug), altRoomSlug);
});

afterEach(async () => {
  await resetRoom(getStub(defaultRoomSlug), defaultRoomSlug);
  await resetRoom(getStub(altRoomSlug), altRoomSlug);
});

async function resetRoom(stub: DurableObjectStub, roomSlug: string) {
  const prefix = `rooms/${roomSlug}/`;
  const listing = await env.ROOM_BUCKET.list({ prefix, limit: 1000 });
  for (const obj of listing.objects) {
    try {
      await env.ROOM_BUCKET.delete(obj.key);
    } catch {}
  }
  const response = await stub.fetch(
    new Request('https://example.com/admin/flush', {
      method: 'POST',
      headers: {
        'x-dev-admin': 'true',
        'x-room-id': roomSlug,
        'x-test-sync': '1',
      },
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to flush room ${roomSlug}: ${response.status}`);
  }
}

async function seedBase(roomSlug: string) {
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await env.ROOM_BUCKET.put(`rooms/${roomSlug}/base/room.png`, bytes, {
    httpMetadata: { contentType: 'image/png' },
  });
  const stub = getStub(roomSlug);
  const resp = await stub.fetch(
    new Request('https://example.com/admin/refresh-base', {
      method: 'POST',
      headers: {
        'x-dev-admin': 'true',
        'x-room-id': roomSlug,
        'x-test-sync': '1',
      },
    })
  );
  expect(resp.status).toBe(200);
}

async function setResetInterval(stub: DurableObjectStub, roomSlug: string, interval: number) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-room-id': roomSlug, 'x-test-sync': '1' });
  const request = new Request('https://example.com/config/reset-interval', {
    method: 'POST',
    headers,
    body: JSON.stringify({ interval }),
  });
  const response = await stub.fetch(request);
  const json = await response.json();
  return { status: response.status, json } as const;
}

async function manualReset(stub: DurableObjectStub, roomSlug: string) {
  const headers = new Headers({ 'content-type': 'application/json', 'x-room-id': roomSlug, 'x-test-sync': '1' });
  const request = new Request('https://example.com/reset', {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  const response = await stub.fetch(request);
  const json = await response.json();
  return { status: response.status, json } as const;
}

async function finishTimelapse(stub: DurableObjectStub, roomSlug: string) {
  await stub.fetch(
    new Request('https://example.com/admin/test-complete-timelapse', {
      method: 'POST',
      headers: {
        'x-dev-admin': 'true',
        'x-room-id': roomSlug,
        'x-test-sync': '1',
      },
    })
  );
}

async function waitForTimelapseActive(stub: DurableObjectStub, roomSlug: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(stub, roomSlug);
    if (state?.timelapse?.active) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for timelapse activation');
}

async function waitForResetPending(stub: DurableObjectStub, roomSlug: string, expectedCount: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(stub, roomSlug);
    if (state?.resetPending && Number(state.promptCounter) >= expectedCount) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for reset warning');
}

async function waitForPostResetCycle(stub: DurableObjectStub, roomSlug: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await getState(stub, roomSlug);
    if (!state?.resetPending && Number(state.promptCounter) >= 1 && !state?.timelapse?.active) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for post-reset operation');
}

describe('RoomDO seenOpIds pruning', () => {
  it('deduplicates repeated op_id submissions within TTL', async () => {
    const stub = getStub();
    const opId = 'dup-test';

    const first = await postOp(stub, 'add plant to the room', opId);
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ queued: true, position: 1 });

    const duplicate = await postOp(stub, 'ignored second prompt', opId);
    expect(duplicate.status).toBe(200);
    expect(duplicate.json).toMatchObject({ queued: true, position: 0 });
  });

  it('expires dedupe entries after TTL allowing reuse', async () => {
    const stub = getStub();
    const opId = 'stale-test';

    const initial = await postOp(stub, 'first prompt', opId);
    expect(initial.status).toBe(200);

    await stub.fetch(
      new Request('https://example.com/admin/test-backdate-seen', {
        method: 'POST',
        headers: {
          'x-dev-admin': 'true',
          'x-room-id': defaultRoomSlug,
          'x-test-sync': '1',
        },
        body: JSON.stringify({ op_id: opId, timestamp: Date.now() - TTL_BUFFER_MS }),
      })
    );

    const retry = await postOp(stub, 'retry prompt after ttl', opId);
    expect(retry.status).toBe(200);
    expect(retry.json.queued).toBe(true);
    expect(retry.json.position).toBeGreaterThanOrEqual(1);

    const seenResp = await stub.fetch(
      new Request(`https://example.com/admin/test-get-seen?op_id=${encodeURIComponent(opId)}`, {
        method: 'GET',
        headers: {
          'x-dev-admin': 'true',
          'x-room-id': defaultRoomSlug,
        },
      })
    );
    const seenJson = await seenResp.json();
    expect(seenJson.seenAt).toBeDefined();
    expect(Date.now() - (seenJson.seenAt ?? 0)).toBeLessThan(TTL_BUFFER_MS);
  });
});

describe('RoomDO queue processing', () => {
  it('applies queued operations sequentially', async () => {
    const stub = getStub();
    await postOp(stub, 'first queue test object', 'queue-seq-1');
    await postOp(stub, 'second queue test object', 'queue-seq-2');

    const state = await waitForVersion(stub, 2);
    expect(state.version).toBeGreaterThanOrEqual(2);
    expect(state.imageUrl).toContain('0002');
  });

it('maintains isolated state per room slug', async () => {
  const globalStub = getStub(defaultRoomSlug);
  const altStub = getStub(altRoomSlug);

  const altInitial = await getState(altStub, altRoomSlug);
  expect(altInitial.baseReady).toBeFalsy();

  await seedBase(altRoomSlug);
  const altAfter = await getState(altStub, altRoomSlug);
  expect(altAfter.baseReady).toBe(true);
  expect(altAfter.imageUrl.startsWith(`/${encodeURIComponent(altRoomSlug)}/img/`)).toBe(true);

  const globalState = await getState(globalStub, defaultRoomSlug);
  expect(globalState.imageUrl.startsWith(`/${encodeURIComponent(defaultRoomSlug)}/img/`)).toBe(true);
});
});

describe('RoomDO auto reset intervals', () => {
  it('warns then resets the global room on the next prompt after the limit', async () => {
    const stub = getStub(defaultRoomSlug);

    for (let i = 0; i < 10; i++) {
      await postOp(stub, `global reset test ${i}`, `global-reset-${i}`);
    }

    const warningState = await waitForResetPending(stub, defaultRoomSlug, 10);
    expect(warningState.resetPending).toBe(true);
    expect(warningState.promptCounter).toBe(10);

    const duringTimelapse = await waitForTimelapseActive(stub, defaultRoomSlug);
    expect(typeof duringTimelapse.timelapse?.deadline).toBe('number');
    expect((duringTimelapse.timelapse?.frames?.length ?? 0)).toBeGreaterThanOrEqual(2);

    const blocked = await postOp(stub, 'global reset blocked prompt', 'global-reset-blocked');
    expect(blocked.status).toBe(409);

    await finishTimelapse(stub, defaultRoomSlug);
    const cycleState = await waitForPostResetCycle(stub, defaultRoomSlug);
    expect(cycleState.resetPending).toBe(false);
    expect(cycleState.promptCounter).toBeGreaterThanOrEqual(1);
    expect(cycleState.promptCounter).toBeLessThan(cycleState.resetInterval);
    expect(cycleState.timelapse).toBeUndefined();
    expect(cycleState.version).toBeGreaterThanOrEqual(1);
  });

  it('honors per-room intervals once configured', async () => {
    const stub = getStub(altRoomSlug);
    await seedBase(altRoomSlug);

    const response = await setResetInterval(stub, altRoomSlug, 3);
    expect(response.status).toBe(200);
    expect(response.json.resetInterval).toBe(3);

    for (let i = 0; i < 3; i++) {
      await postOp(stub, `custom reset test ${i}`, `custom-reset-${i}`);
    }

    const warningState = await waitForResetPending(stub, altRoomSlug, 3);
    expect(warningState.resetPending).toBe(true);
    expect(warningState.promptCounter).toBe(3);

    const duringTimelapse = await waitForTimelapseActive(stub, altRoomSlug);
    expect((duringTimelapse.timelapse?.frames?.length ?? 0)).toBeGreaterThanOrEqual(2);

    const blocked = await postOp(stub, 'custom reset blocked prompt', 'custom-reset-blocked');
    expect(blocked.status).toBe(409);

    await finishTimelapse(stub, altRoomSlug);
    const cycleState = await waitForPostResetCycle(stub, altRoomSlug);
    expect(cycleState.resetPending).toBe(false);
    expect(cycleState.promptCounter).toBeGreaterThanOrEqual(1);
    expect(cycleState.promptCounter).toBeLessThan(cycleState.resetInterval);
    expect(cycleState.resetInterval).toBe(3);
    expect(cycleState.timelapse).toBeUndefined();
  });

  it('allows manual reset before submitting the next prompt', async () => {
    const stub = getStub(altRoomSlug);
    await seedBase(altRoomSlug);

    const response = await setResetInterval(stub, altRoomSlug, 2);
    expect(response.status).toBe(200);
    expect(response.json.resetInterval).toBe(2);

    for (let i = 0; i < 2; i++) {
      await postOp(stub, `manual reset test ${i}`, `manual-reset-${i}`);
    }

    const warningState = await waitForResetPending(stub, altRoomSlug, 2);
    expect(warningState.resetPending).toBe(true);
    expect(warningState.promptCounter).toBe(2);

    const resetResult = await manualReset(stub, altRoomSlug);
    expect(resetResult.status).toBe(200);
    expect(resetResult.json.resetPending).toBe(false);
    expect(resetResult.json.promptCounter).toBe(0);
    expect(resetResult.json.timelapseActive).toBe(false);

    const postResetState = await getState(stub, altRoomSlug);
    expect(postResetState.resetPending).toBe(false);
    expect(postResetState.promptCounter).toBe(0);
    expect(postResetState.timelapse).toBeUndefined();
  });
});
