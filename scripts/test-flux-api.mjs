#!/usr/bin/env node
// Direct test of FLUX.1 Kontext queue endpoint using raw fetch, aligned with fal.ai docs.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODEL_ID = 'fal-ai/flux-kontext/dev';
const QUEUE_BASE = `https://queue.fal.run/${MODEL_ID}`;

function usage(code = 0) {
  const script = path.basename(fileURLToPath(import.meta.url));
  console.log(`Usage: FAL_KEY=... node ${script}` +
    ' --prompt "..." [--image ./base.png | --image-url https://...]' +
    ' [--safety 2] [--guidance 3.5] [--aspect 1:1]' +
    ' [--timeout 600] [--poll 1.0] [--save out.png]\n');
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    prompt: '',
    imagePath: '',
    imageUrl: '',
    safetyTolerance: '2',
    guidanceScale: undefined,
    aspectRatio: undefined,
    timeoutSec: 300,
    pollSec: 1,
    savePath: '',
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = (def = '') => (i + 1 < argv.length ? argv[++i] : def);
    switch (arg) {
      case '--prompt':
      case '-p':
        out.prompt = next();
        break;
      case '--image':
        out.imagePath = next();
        break;
      case '--image-url':
        out.imageUrl = next();
        break;
      case '--safety':
        out.safetyTolerance = next(out.safetyTolerance);
        break;
      case '--guidance':
        out.guidanceScale = Number.parseFloat(next(''));
        break;
      case '--aspect':
        out.aspectRatio = next();
        break;
      case '--timeout':
        out.timeoutSec = Number.parseFloat(next('300')) || 300;
        break;
      case '--poll':
        out.pollSec = Math.max(0.2, Number.parseFloat(next('1')) || 1);
        break;
      case '--save':
      case '-o':
        out.savePath = next();
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        usage(1);
    }
  }
  if (!out.prompt) {
    console.error('Error: --prompt is required');
    usage(1);
  }
  return out;
}

function guessMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function toDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);
  const mime = guessMime(filePath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function submitJob(apiKey, input) {
  const resp = await fetch(QUEUE_BASE, {
    method: 'POST',
    headers: {
      Authorization: `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`enqueue failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  return await resp.json();
}

async function fetchStatus(apiKey, statusUrl) {
  const resp = await fetch(statusUrl, {
    headers: {
      Authorization: `Key ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 400 && text.includes('still in progress')) {
      return { status: 'IN_PROGRESS', raw: text };
    }
    throw new Error(`status failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  return await resp.json();
}

async function fetchResult(apiKey, resultUrl) {
  const resp = await fetch(resultUrl, {
    headers: {
      Authorization: `Key ${apiKey}`,
      Accept: 'application/json',
    },
  });
  const text = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`result failed (${resp.status}): ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error('Unable to parse result JSON, raw body:', text.slice(0, 2000));
    throw new Error('result payload was not valid JSON');
  }
}

async function downloadImage(apiKey, url, targetPath) {
  const resp = await fetch(url, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!resp.ok) throw new Error(`download failed (${resp.status})`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(targetPath, buffer);
}

async function main() {
  const args = parseArgs(process.argv);
  const apiKey = process.env.FAL_KEY || process.env.FAL_API_KEY || '';
  if (!apiKey) {
    console.error('Set FAL_KEY in your environment before running this script.');
    process.exit(1);
  }

  const payload = {
    prompt: args.prompt,
    output_format: 'png',
    safety_tolerance: args.safetyTolerance,
  };
  if (args.guidanceScale !== undefined && !Number.isNaN(args.guidanceScale)) {
    payload.guidance_scale = args.guidanceScale;
  }
  if (args.aspectRatio) {
    payload.aspect_ratio = args.aspectRatio;
  }
  if (args.imagePath) {
    payload.image_url = toDataUrl(args.imagePath);
  } else if (args.imageUrl) {
    payload.image_url = args.imageUrl;
  }

  console.log('Submitting job to', MODEL_ID);
  const submitted = await submitJob(apiKey, payload);
  const requestId = submitted?.request_id;
  if (!requestId) {
    console.error('enqueue response missing request_id:', submitted);
    process.exit(1);
  }
  const statusUrl = submitted?.status_url
    ? submitted.status_url
    : submitted?.response_url
      ? `${submitted.response_url.replace(/\/status(?:\?.*)?$/, '')}/status`
      : `${QUEUE_BASE}/requests/${requestId}/status`;
  const resultUrl = submitted?.response_url
    ? submitted.response_url.replace(/\/status(?:\?.*)?$/, '')
    : `${QUEUE_BASE}/requests/${requestId}`;

  console.log('Request ID:', requestId);
  console.log('Status URL:', statusUrl);
  console.log('Result URL:', resultUrl);

  const start = Date.now();
  while (true) {
    const status = await fetchStatus(apiKey, statusUrl + `?logs=1`);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const queue = typeof status.queue_position === 'number' ? ` queue=${status.queue_position}` : '';
    console.log(`[${elapsed}s] status=${status.status}${queue}`);
    if (status.raw) console.log('  raw status body:', status.raw.slice(0, 200));
    if (Array.isArray(status.logs)) {
      status.logs.forEach((log) => {
        if (log?.message) console.log('  ›', log.message);
      });
    }

    if (status.status === 'FAILED' || status.status === 'ERROR') {
      console.error('Job failed:', JSON.stringify(status, null, 2));
      process.exit(2);
    }
    if (status.status === 'COMPLETED') {
      console.log('Final status payload:', JSON.stringify(status, null, 2));
      break;
    }
    if (Date.now() - start > args.timeoutSec * 1000) {
      console.error(`Timed out after ${args.timeoutSec}s waiting for completion.`);
      process.exit(3);
    }
    await sleep(args.pollSec * 1000);
  }

  const result = await fetchResult(apiKey, resultUrl);
  console.log('Raw result payload:\n', JSON.stringify(result, null, 2));

  const resultData = result?.data ?? result;
  const firstImage = resultData?.images?.[0];
  if (firstImage?.url) {
    console.log('Image URL:', firstImage.url);
    if (args.savePath) {
      const target = path.extname(args.savePath) ? args.savePath : `${args.savePath}.png`;
      try {
        await downloadImage(apiKey, firstImage.url, target);
        console.log('Saved image to', target);
      } catch (err) {
        console.error('Failed to download image:', err?.message || err);
      }
    }
  }
}

main().catch((err) => {
  console.error('[fatal]', err?.stack || String(err));
  process.exit(1);
});
