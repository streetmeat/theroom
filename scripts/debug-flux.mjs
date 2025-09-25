#!/usr/bin/env node
// Standalone debug script for exercising FLUX.1 Kontext via fal.ai queue endpoints.
// Node 18+ required (global fetch, atob/btoa via Buffer).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MODEL_ID = 'fal-ai/flux-kontext/dev';
const QUEUE_BASE = `https://queue.fal.run/${MODEL_ID}`;
const POLL_INTERVAL_MS = 800;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

function parseArgs(argv) {
  const out = {
    prompt: '',
    mode: 'auto', // 'text' | 'base' | 'auto'
    retries: 1,
    basePath: '',
    fromWorker: '',
    imageUrl: '',
    save: '',
    includeTimeline: false,
    room: 'global',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = (def = '') => (i + 1 < argv.length ? argv[++i] : def);
    if (arg === '--prompt' || arg === '-p') out.prompt = next();
    else if (arg === '--mode' || arg === '-m') out.mode = next();
    else if (arg === '--retries') out.retries = clampInt(next('1'), 0, 5);
    else if (arg === '--base') out.basePath = next();
    else if (arg === '--from-worker') out.fromWorker = next();
    else if (arg === '--room') out.room = next();
    else if (arg === '--image-url') out.imageUrl = next();
    else if (arg === '--save' || arg === '-o') out.save = next();
    else if (arg === '--timeline') out.includeTimeline = true;
    else if (arg === '--help' || arg === '-h') helpAndExit();
  }
  if (!out.prompt) {
    console.error('Error: --prompt is required.');
    helpAndExit(1);
  }
  return out;
}

function helpAndExit(code = 0) {
  console.log('Flux Kontex debug script');
  console.log('Examples:');
  console.log('  FAL_KEY=... node scripts/debug-flux.mjs --prompt "Add a plant" --mode auto --save out.png');
  console.log('  FAL_KEY=... node scripts/debug-flux.mjs --prompt "Add neon sign" --mode base --from-worker http://localhost:8787 --room party-room');
  process.exit(code);
}

function clampInt(str, min, max) {
  const n = Number.parseInt(str, 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function guessMimeFromPath(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function toBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

async function readBaseFromPath(basePath) {
  const bytes = await fs.promises.readFile(basePath);
  const mime = guessMimeFromPath(basePath);
  return { mime, b64: toBase64(bytes), size: bytes.length };
}

async function readBaseFromWorker(baseUrl, roomSlug) {
  const encoded = roomSlug ? '/' + encodeURIComponent(roomSlug) : '';
  const stateUrl = new URL(`${encoded}/state`, baseUrl).toString();
  const stateResp = await fetch(stateUrl);
  if (!stateResp.ok) throw new Error(`Failed to fetch /state (${stateResp.status})`);
  const state = await stateResp.json();
  const imageUrl = String(state?.imageUrl || '');
  if (!imageUrl) throw new Error('Worker state missing imageUrl');
  const absImage = new URL(imageUrl, baseUrl).toString();
  const imgResp = await fetch(absImage);
  if (!imgResp.ok) throw new Error(`Failed to fetch base image (${imgResp.status})`);
  const buf = Buffer.from(await imgResp.arrayBuffer());
  const mime = imgResp.headers.get('content-type') || guessMimeFromPath(absImage);
  return { mime, b64: toBase64(buf), size: buf.length, imageUrl: absImage };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDataUrl(str) {
  return /^data:image\/[A-Za-z0-9.+-]+;base64,/i.test(str.trim());
}

function looksLikeBase64(str) {
  if (str.length < 64) return false;
  if (isDataUrl(str)) return false;
  return /^[A-Za-z0-9+/=]+$/.test(str.trim());
}

function findFirstString(value, predicate) {
  const stack = [value];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (typeof current === 'string') {
      if (predicate(current)) return current;
      continue;
    }
    if (typeof current === 'object') {
      if (seen.has(current)) continue;
      seen.add(current);
      if (Array.isArray(current)) {
        for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
      } else {
        for (const v of Object.values(current)) stack.push(v);
      }
    }
  }
  return undefined;
}

function extensionForContentType(ct) {
  if (!ct) return 'png';
  const lower = ct.toLowerCase();
  if (lower.includes('jpeg')) return 'jpg';
  if (lower.includes('webp')) return 'webp';
  if (lower.includes('png')) return 'png';
  return 'png';
}

async function resolveFalImage(json, apiKey) {
  const url = findFirstString(json, (s) => s.startsWith('http://') || s.startsWith('https://'));
  if (url) {
    const headers = {};
    if (/\.fal\.(ai|run)|fal\.media/.test(new URL(url).hostname)) {
      headers.Authorization = `Key ${apiKey}`;
    }
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`Image download failed (${resp.status})`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { buffer, contentType: resp.headers.get('content-type') || 'image/png' };
  }
  const dataUrl = findFirstString(json, isDataUrl);
  if (dataUrl) {
    const match = /^data:(?<type>image\/[A-Za-z0-9.+-]+);base64,(?<data>[A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
    if (!match || !match.groups) throw new Error('Malformed data URL');
    return { buffer: Buffer.from(match.groups.data, 'base64'), contentType: match.groups.type };
  }
  const base64 = findFirstString(json, looksLikeBase64);
  if (base64) {
    return { buffer: Buffer.from(base64, 'base64'), contentType: 'image/png' };
  }
  throw new Error('No image payload found in response');
}

async function submitJob(apiKey, payload, includeTimeline) {
  const start = Date.now();
  const enqueue = await fetch(QUEUE_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!enqueue.ok) {
    const text = await enqueue.text().catch(() => '');
    throw new Error(`enqueue failed (${enqueue.status}): ${text.slice(0, 300)}`);
  }
  const enqueueJson = await enqueue.json();
  const requestId = enqueueJson?.request_id;
  const responseUrl = enqueueJson?.response_url;
  if (typeof requestId !== 'string') throw new Error('enqueue response missing request_id');

  const timeline = [];
  const baseRequestUrl = responseUrl
    ? responseUrl.replace(/\/status(?:\?.*)?$/, '')
    : `${QUEUE_BASE}/requests/${requestId}`;
  const statusUrlObj = responseUrl ? new URL(responseUrl) : new URL(`${baseRequestUrl}/status`);
  if (includeTimeline) statusUrlObj.searchParams.set('logs', '1');
  const statusUrl = statusUrlObj.toString();
  while (true) {
    const statusResp = await fetch(statusUrl, {
      headers: {
        Authorization: `Key ${apiKey}`,
        Accept: 'application/json',
      },
    });
    let statusJson;
    if (!statusResp.ok) {
      const text = await statusResp.text().catch(() => '');
      if (statusResp.status === 400 && text.includes('still in progress')) {
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      throw new Error(`status failed (${statusResp.status}): ${text.slice(0, 300)}`);
    } else {
      statusJson = await statusResp.json();
    }
    if (includeTimeline) {
      timeline.push({
        status: statusJson?.status,
        queue_position: statusJson?.queue_position,
        logs: statusJson?.logs,
        timestamp: Date.now(),
      });
    }
    const status = statusJson?.status;
    if (status === 'COMPLETED') break;
    if (status === 'FAILED' || status === 'ERROR') {
      throw new Error(`job failed: ${JSON.stringify(statusJson)}`);
    }
    if (Date.now() - start > POLL_TIMEOUT_MS) throw new Error('job timed out');
    await sleep(POLL_INTERVAL_MS);
  }

  const resultResp = await fetch(baseRequestUrl, {
    headers: {
      Authorization: `Key ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!resultResp.ok) {
    const text = await resultResp.text().catch(() => '');
    throw new Error(`result fetch failed (${resultResp.status}): ${text.slice(0, 300)}`);
  }
  const resultJson = await resultResp.json();
  const image = await resolveFalImage(resultJson, apiKey);
  const duration = Date.now() - start;
  return { requestId, resultJson, timeline, image, duration };
}

async function callWithRetries(apiKey, buildPayload, retries, includeTimeline) {
  const attempts = [];
  let last = null;
  for (let i = 0; i <= retries; i++) {
    const t0 = Date.now();
    try {
      const job = await submitJob(apiKey, buildPayload(), includeTimeline);
      const attempt = {
        ok: true,
        ms: job.duration,
        requestId: job.requestId,
        image_bytes: job.image.buffer.length,
        content_type: job.image.contentType,
        image_url: findFirstString(job.resultJson, (s) => s.startsWith('http')),
        timeline: includeTimeline ? job.timeline : undefined,
      };
      attempts.push(attempt);
      last = { ...attempt, job };
      break;
    } catch (err) {
      const message = err?.message || String(err);
      const attempt = { ok: false, ms: Date.now() - t0, error: message };
      attempts.push(attempt);
      last = attempt;
      if (!shouldRetry(message) || i === retries) break;
      await sleep(250 * Math.pow(2, i));
    }
  }
  return { attempts, last };
}

function shouldRetry(message) {
  const lower = message.toLowerCase();
  return lower.includes('429') || lower.includes('timeout') || lower.includes('temporarily');
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.FAL_KEY || '';
  if (!apiKey) {
    console.error('FAL_KEY environment variable is required.');
    process.exit(1);
  }

  let baseInfo = null;
  if (args.basePath) {
    baseInfo = await readBaseFromPath(args.basePath);
  } else if (args.fromWorker) {
    baseInfo = await readBaseFromWorker(args.fromWorker, args.room);
  }

  function buildPayload(withBase) {
    const payload = { prompt: args.prompt };
    if (withBase) {
      if (baseInfo?.b64 && baseInfo?.mime) {
        payload.image_url = `data:${baseInfo.mime};base64,${baseInfo.b64}`;
      } else if (args.imageUrl) {
        payload.image_url = args.imageUrl;
      } else if (baseInfo?.imageUrl) {
        payload.image_url = baseInfo.imageUrl;
      }
    }
    if (!withBase || !payload.image_url) {
      payload.prompt = `Base scene: ${DEFAULT_BASE_SCENE_TEXT}. Now ${args.prompt}`;
    }
    payload.output_format = 'png';
    payload.safety_tolerance = '2';
    return payload;
  }

  const results = { prompt: args.prompt, mode: args.mode, retries: args.retries, room: args.room };

  if (args.mode === 'text') {
    results.text = await callWithRetries(apiKey, () => buildPayload(false), args.retries, args.includeTimeline);
  } else if (args.mode === 'base') {
    results.base = await callWithRetries(apiKey, () => buildPayload(true), args.retries, args.includeTimeline);
  } else {
    const baseRes = await callWithRetries(apiKey, () => buildPayload(true), args.retries, args.includeTimeline);
    results.base = baseRes;
    if (!baseRes.last?.ok) {
      results.text = await callWithRetries(apiKey, () => buildPayload(false), args.retries, args.includeTimeline);
    }
  }

  console.log(JSON.stringify(results, null, 2));

  const lastSuccess = results.base?.last?.ok ? results.base.last : results.text?.last;
  if (lastSuccess && lastSuccess.ok && args.save && lastSuccess.job) {
    const buffer = lastSuccess.job.image.buffer;
    let target = args.save;
    if (results.mode === 'auto' && results.base?.last?.ok && results.text?.last?.ok) {
      const ext = path.extname(args.save);
      const name = path.basename(args.save, ext);
      const dir = path.dirname(args.save);
      target = path.join(dir, `${name}.base${ext || '.png'}`);
    }
    const ext = path.extname(target) || `.${extensionForContentType(lastSuccess.job.image.contentType)}`;
    const finalPath = path.extname(target) ? target : `${target}${ext}`;
    await fs.promises.writeFile(finalPath, buffer);
    console.log(`[saved] ${finalPath}`);
  }
}

const DEFAULT_BASE_SCENE_TEXT = 'a well-lit modern living room interior, wide angle, neutral decor, couch against the back wall, windows on one side, wooden floor';

main().catch((err) => {
  console.error('[fatal]', err?.stack || String(err));
  process.exit(1);
});
