/*
  Cloudflare Worker + Durable Object scaffold for the single shared room.
  Endpoints:
    - POST /ops      Submit a prompt (enqueue operation)
    - GET  /state    Get latest image state { imageUrl, version }
    - WS   /stream   Realtime broadcast of image updates and queue events
    - GET  /img/*    Serve R2 objects by key

  Image generation handled via FLUX.1 Kontext (fal.ai queue API)
  in the processOp() section.
*/

export interface Env {
  ROOM_DO: DurableObjectNamespace;
  ROOM_BUCKET: R2Bucket;
  FAL_KEY?: string;
}

type ImageUpdateMsg = {
  type: 'image_updated';
  imageUrl: string;
  version: number;
  op_id?: string;
  baseReady?: boolean;
  resetPending?: boolean;
  promptCounter?: number;
  resetInterval?: number;
};

type QueueMsg = { type: 'queue'; position: number; ahead?: number; op_id?: string };
type ErrorMsg = { type: 'error'; message: string; op_id?: string };
type QueueStatsMsg = { type: 'queue_stats'; length: number; processing: boolean };
type TimelapseStartMsg = {
  type: 'timelapse_start';
  frames: string[];
  durationMs: number;
  deadline: number;
};

type TimelapseEndMsg = { type: 'timelapse_end'; deadline: number };
type PresenceMsg = { type: 'presence'; count: number };

type WsMsg =
  | ImageUpdateMsg
  | QueueMsg
  | ErrorMsg
  | QueueStatsMsg
  | TimelapseStartMsg
  | TimelapseEndMsg
  | ReactionEmitMsg
  | PresenceMsg;

type Op = {
  prompt: string;
  op_id?: string;
  parentVersion: number;
  enqueuedAt: number;
  origin: string;
};

type PersistedState = {
  version: number;
  imagePath: string;
  roomId?: string;
  baseReady?: boolean;
  promptCounter?: number;
  resetInterval?: number;
  resetPending?: boolean;
  history?: string[];
  timelapse?: {
    active?: boolean;
    frames?: string[];
    deadline?: number;
    startedAt?: number;
  };
};

const DEFAULT_ROOM_NAME = 'global';
const DEFAULT_PLACEHOLDER_PATH = 'versions/0000.png';
const DEFAULT_PLACEHOLDER_CONTENT_TYPE = 'image/png';
const DEFAULT_PLACEHOLDER_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/xcAAusB9Y6T0p8AAAAASUVORK5CYII=';
const ROOM_BASE_CANDIDATES = ['base/room.png', 'base/room.jpg', 'base/room.webp'];
const ROOM_BASE_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024; // 4MB cap per upload (aligned with fal.ai limits)
const DEFAULT_BASE_SCENE = 'a well-lit modern living room interior, wide angle, neutral decor, couch against the back wall, windows on one side, wooden floor';
const CANONICAL_SQUARE_SIZE = 1280; // display target; generation may vary
const SEEN_OP_TTL_MS = 15 * 60 * 1000; // 15 minutes TTL for dedupe entries
const SEEN_OP_MAX = 512; // cap dedupe map size to avoid unbounded growth
const FAL_MODEL_ID = 'fal-ai/flux-kontext/dev';
const FAL_QUEUE_BASE = `https://queue.fal.run/${FAL_MODEL_ID}`;
const FAL_POLL_INTERVAL_MS = 800;
const FAL_POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes safety timeout per op
const DEFAULT_GLOBAL_RESET_INTERVAL = 10;
const DEFAULT_CUSTOM_RESET_INTERVAL = 20;
const MIN_RESET_INTERVAL = 1;
const MAX_RESET_INTERVAL = 500;
const TIMELAPSE_DURATION_MS = 60 * 1000;
const TIMELAPSE_MAX_FRAMES = 20;
const TIMELAPSE_FRAME_MS = 1000;
const MAX_HISTORY_ENTRIES = 40;

const REACTION_EMOJIS = ['💩', '🔥', '😂', '😍', '😱', '👀'] as const;
const REACTION_BATCH_INTERVAL_MS = 200;
const REACTION_WINDOW_MS = 10 * 1000;
const REACTION_INTENSITY_TARGET = 40;
const REACTION_MAX_BURST = 18;
const REACTION_SOCKET_WINDOW_MS = 1000;
const REACTION_SOCKET_LIMIT = 8;

type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
type ReactionEmitMsg = {
  type: 'reaction_emit';
  emoji: ReactionEmoji;
  burst: number;
  intensity: number;
  total: number;
};

function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

const LEGACY_ROUTES = new Set(['ops', 'state', 'stream', 'admin']);
const RESERVED_ROOT_SEGMENTS = new Set(['img', 'debug', 'health']);

function getPathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment.length > 0);
}

function isValidRoomSlug(slug: string | null): slug is string {
  if (!slug) return false;
  if (slug.length > 64) return false;
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(slug);
}

function roomR2Key(roomId: string, relativePath: string): string {
  const sanitized = relativePath.replace(/^\/+/, '');
  return `rooms/${roomId}/${sanitized}`;
}

function encodePathForUrl(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function roomImageUrl(roomId: string, relativePath: string): string {
  const encodedRoom = encodeURIComponent(roomId);
  const encodedPath = encodePathForUrl(relativePath);
  return `/${encodedRoom}/img/${encodedPath}`;
}

function isDefaultRoomId(roomId: string): boolean {
  return roomId === DEFAULT_ROOM_NAME;
}

function buildDoRequest(req: Request, slug: string, newPathname: string): Request {
  const url = new URL(req.url);
  url.pathname = newPathname;
  const forwarded = new Request(url.toString(), req);
  forwarded.headers.set('x-room-id', slug);
  return forwarded;
}

function withRoomHeader(req: Request, slug: string): Request {
  const forwarded = new Request(req);
  forwarded.headers.set('x-room-id', slug);
  return forwarded;
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const segments = getPathSegments(url.pathname);

    if (segments[0] === 'debug' && segments[1] === 'flux') {
      return debugFlux(withRoomHeader(req, DEFAULT_ROOM_NAME), env);
    }

    if (segments[0] === 'health' && segments.length === 1) {
      return new Response('OK', { status: 200 });
    }

    if (segments[0] === 'img') {
      return handleSharedImage(req, env, segments.slice(1));
    }

    if (segments.length === 0) {
      return serveIndex(DEFAULT_ROOM_NAME);
    }

    if (segments.length === 1 && LEGACY_ROUTES.has(segments[0])) {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(DEFAULT_ROOM_NAME));
      const proxied = buildDoRequest(req, DEFAULT_ROOM_NAME, `/${segments[0]}`);
      return stub.fetch(proxied);
    }

    if (segments.length === 1 && segments[0] === 'reset') {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(DEFAULT_ROOM_NAME));
      const proxied = buildDoRequest(req, DEFAULT_ROOM_NAME, '/reset');
      return stub.fetch(proxied);
    }

    if (segments.length === 2 && segments[0] === 'admin' && segments[1] === 'reset') {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(DEFAULT_ROOM_NAME));
      const proxied = buildDoRequest(req, DEFAULT_ROOM_NAME, '/admin/reset');
      return stub.fetch(proxied);
    }

    const potentialSlug = segments[0];
    if (!isValidRoomSlug(potentialSlug) || RESERVED_ROOT_SEGMENTS.has(potentialSlug)) {
      return new Response('Not found', { status: 404 });
    }

    const slug = potentialSlug;
    const remainder = segments.slice(1);

    if (remainder.length === 0) {
      return serveIndex(slug);
    }

    if (remainder[0] === 'img') {
      return handleRoomImage(req, env, slug, remainder.slice(1));
    }

    if (remainder[0] === 'debug' && remainder[1] === 'flux') {
      return debugFlux(withRoomHeader(req, slug), env);
    }

    if (remainder[0] === 'admin' && remainder[1] === 'refresh-base') {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(slug));
      const proxied = buildDoRequest(req, slug, '/admin/refresh-base');
      return stub.fetch(proxied);
    }

    if (remainder[0] === 'reset') {
      const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(slug));
      const proxied = buildDoRequest(req, slug, '/reset');
      return stub.fetch(proxied);
    }

    const targetPath = '/' + remainder.join('/');
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(slug));
    const proxied = buildDoRequest(req, slug, targetPath);
    return stub.fetch(proxied);
  },
};

function serveIndex(roomId: string): Response {
  const html = renderIndexHtml(roomId);
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

async function handleSharedImage(req: Request, env: Env, keySegments: string[]): Promise<Response> {
  const key = decodeKeySegments(keySegments);
  if (!key) return new Response('Missing key', { status: 400 });
  const method = req.method.toUpperCase();

  if (method === 'PUT') {
    if (!req.headers.get('x-dev-upload')) return new Response('Forbidden', { status: 403 });
    const ct = req.headers.get('content-type') || 'application/octet-stream';
    const bytes = new Uint8Array(await req.arrayBuffer());
    await env.ROOM_BUCKET.put(key, bytes, { httpMetadata: { contentType: ct } });
    return json({ ok: true, key, imageUrl: `/img/${encodePathForUrl(key)}` });
  }

  if (method === 'GET' || method === 'HEAD') {
    const obj = method === 'HEAD' ? await env.ROOM_BUCKET.head(key) : await env.ROOM_BUCKET.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    const ct = obj.httpMetadata?.contentType || 'application/octet-stream';
    headers.set('Content-Type', ct);
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(obj.body, { headers });
  }

  return new Response('Method Not Allowed', { status: 405 });
}

async function handleRoomImage(req: Request, env: Env, roomId: string, keySegments: string[]): Promise<Response> {
  const relativePath = decodeKeySegments(keySegments);
  if (!relativePath) return new Response('Missing key', { status: 400 });
  const method = req.method.toUpperCase();
  const r2Key = roomR2Key(roomId, relativePath);

  if (method === 'PUT') {
    if (!req.headers.get('x-dev-upload')) return new Response('Forbidden', { status: 403 });
    if (!relativePath.startsWith('base/')) {
      return new Response('Forbidden', { status: 403 });
    }
    const ct = req.headers.get('content-type') || 'application/octet-stream';
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length > ROOM_BASE_UPLOAD_LIMIT_BYTES) {
      return json({ error: 'File too large (limit 4MB)' }, 413);
    }
    await env.ROOM_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: ct } });
    const stub = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
    await stub.fetch(
      new Request('https://do/admin/refresh-base', {
        method: 'POST',
        headers: {
          'x-room-id': roomId,
          'x-dev-admin': 'true',
        },
      })
    ).catch(() => {});
    return json({ ok: true, key: relativePath, imageUrl: roomImageUrl(roomId, relativePath) });
  }

  if (method === 'GET' || method === 'HEAD') {
    const obj = method === 'HEAD' ? await env.ROOM_BUCKET.head(r2Key) : await env.ROOM_BUCKET.get(r2Key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    const ct = obj.httpMetadata?.contentType || 'application/octet-stream';
    headers.set('Content-Type', ct);
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    return new Response(obj.body, { headers });
  }

  return new Response('Method Not Allowed', { status: 405 });
}

function decodeKeySegments(keySegments: string[]): string | undefined {
  if (keySegments.length === 0) return undefined;
  const decoded = keySegments
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => segment.length > 0)
    .join('/');
  if (!decoded) return undefined;
  if (decoded.includes('..')) return undefined;
  return decoded.replace(/^\/+/, '');
}

export class RoomDO {
  private state: DurableObjectState;
  private env: Env;
  private sockets: Set<WebSocket> = new Set();
  private queue: Op[] = [];
  private processing = false;
  private seenOpIds: Map<string, number> = new Map();
  private version = 0;
  private imagePath: string = DEFAULT_PLACEHOLDER_PATH;
  private roomId: string = DEFAULT_ROOM_NAME;
  private roomInitialized = false;
  private baseReady = false;
  private promptCounter = 0;
  private resetInterval = DEFAULT_GLOBAL_RESET_INTERVAL;
  private resetPending = false;
  private versionHistory: string[] = [];
  private timelapseActive = false;
  private timelapseFrames: string[] = [];
  private timelapseDeadline: number | undefined;
  private timelapseStartedAt: number | undefined;
  private socketMeta: Map<WebSocket, { reactionLog: number[] }> = new Map();
  private reactionPending: Map<ReactionEmoji, number> = new Map();
  private reactionBuckets: Map<ReactionEmoji, { timestamp: number; count: number }[]> = new Map();
  private reactionTotals: Map<ReactionEmoji, number> = new Map();
  private reactionFlushPromise: Promise<void> | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    // Lazy init on first fetch
  }

  private captureRoomId(req: Request) {
    const headerSlug = req.headers.get('x-room-id');
    if (isValidRoomSlug(headerSlug)) {
      if (headerSlug !== this.roomId) {
        this.roomInitialized = false;
      }
      this.roomId = headerSlug;
    } else {
      this.roomId = DEFAULT_ROOM_NAME;
    }
  }

  private async initIfNeeded() {
    if (this.roomInitialized) return;

    const persisted = await this.state.storage.get<PersistedState>('state');
    if (persisted) {
      if (typeof persisted.roomId === 'string' && persisted.roomId.length > 0 && persisted.roomId !== this.roomId) {
        this.roomId = persisted.roomId;
      }
      this.resetInterval = this.loadResetInterval(persisted.resetInterval);
      this.promptCounter = this.clampPromptCounter(persisted.promptCounter);
      this.resetPending = Boolean(persisted.resetPending);
      if (this.promptCounter >= this.resetInterval) {
        this.resetPending = true;
      } else if (this.resetPending) {
        this.resetPending = false;
      }
      this.version = typeof persisted.version === 'number' ? persisted.version : 0;
      const history = Array.isArray(persisted.history)
        ? persisted.history.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
      this.versionHistory = history.slice(-MAX_HISTORY_ENTRIES);
      const persistedTimelapse = persisted.timelapse;
      if (persistedTimelapse && persistedTimelapse.active && Array.isArray(persistedTimelapse.frames)) {
        const deadline = typeof persistedTimelapse.deadline === 'number' ? persistedTimelapse.deadline : undefined;
        if (deadline && deadline > Date.now()) {
          this.timelapseActive = true;
          this.timelapseFrames = persistedTimelapse.frames.filter((frame): frame is string => typeof frame === 'string');
          this.timelapseDeadline = deadline;
          this.timelapseStartedAt = typeof persistedTimelapse.startedAt === 'number' ? persistedTimelapse.startedAt : undefined;
          this.state.storage.setAlarm(deadline).catch(() => {});
        } else {
          this.timelapseActive = false;
          this.timelapseFrames = [];
          this.timelapseDeadline = undefined;
          this.timelapseStartedAt = undefined;
        }
      }
      let path = persisted.imagePath;
      if (!path && (persisted as any).imageKey) {
        path = await this.migrateLegacyImageKey(String((persisted as any).imageKey));
      }
      if (typeof path === 'string' && path.length > 0) {
        this.imagePath = path;
        this.baseReady = Boolean(persisted.baseReady) || path !== DEFAULT_PLACEHOLDER_PATH;
        if (this.promptCounter > this.resetInterval) {
          this.promptCounter = this.resetInterval;
        }
        if (this.versionHistory.length === 0) {
          this.versionHistory = [this.imagePath];
        } else {
          this.appendHistory(this.imagePath);
        }
        this.roomInitialized = true;
        await this.persistState();
        return;
      }
    }

    this.resetInterval = this.defaultResetInterval();
    this.promptCounter = 0;
    this.resetPending = false;

    const base = await ensureRoomBase(this.env, this.roomId);
    this.version = 0;
    this.imagePath = base.path;
    this.baseReady = base.ready;
    this.versionHistory = [this.imagePath];
    await this.persistState();
    this.roomInitialized = true;
  }

  private async persistState() {
    if (isDefaultRoomId(this.roomId)) {
      this.resetInterval = DEFAULT_GLOBAL_RESET_INTERVAL;
    }
    await this.state.storage.put('state', {
      version: this.version,
      imagePath: this.imagePath,
      roomId: this.roomId,
      baseReady: this.baseReady,
      promptCounter: this.promptCounter,
      resetInterval: this.resetInterval,
      resetPending: this.resetPending,
      history: this.versionHistory.slice(-MAX_HISTORY_ENTRIES),
      timelapse: this.timelapseActive
        ? {
            active: true,
            frames: this.timelapseFrames,
            deadline: this.timelapseDeadline,
            startedAt: this.timelapseStartedAt,
          }
        : undefined,
    });
  }

  private defaultResetInterval(): number {
    return isDefaultRoomId(this.roomId) ? DEFAULT_GLOBAL_RESET_INTERVAL : DEFAULT_CUSTOM_RESET_INTERVAL;
  }

  private normalizeResetInterval(value: unknown): number {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return this.defaultResetInterval();
    const floored = Math.floor(num);
    return Math.max(MIN_RESET_INTERVAL, Math.min(MAX_RESET_INTERVAL, floored));
  }

  private loadResetInterval(raw: unknown): number {
    if (isDefaultRoomId(this.roomId)) return DEFAULT_GLOBAL_RESET_INTERVAL;
    if (raw === undefined || raw === null) return DEFAULT_CUSTOM_RESET_INTERVAL;
    return this.normalizeResetInterval(raw);
  }

  private clampPromptCounter(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    const value = Math.max(0, Math.floor(raw));
    return Math.min(value, this.resetInterval);
  }

  private setResetInterval(interval: number): number {
    if (isDefaultRoomId(this.roomId)) {
      this.resetInterval = DEFAULT_GLOBAL_RESET_INTERVAL;
      return this.resetInterval;
    }
    const normalized = this.normalizeResetInterval(interval);
    this.resetInterval = normalized;
    if (this.promptCounter > this.resetInterval) {
      this.promptCounter = this.resetInterval;
    }
    if (this.promptCounter >= this.resetInterval) {
      this.resetPending = true;
    } else {
      this.resetPending = false;
    }
    return this.resetInterval;
  }

  private scheduleResetIfNeeded() {
    if (this.resetInterval > 0 && this.promptCounter >= this.resetInterval) {
      this.resetPending = true;
    }
  }

  private async ensureResetBeforeProcessing(): Promise<boolean> {
    if (this.timelapseActive) return true;
    if (!this.resetPending) return false;
    return await this.beginTimelapseOrReset();
  }

  private async migrateLegacyImageKey(legacyKeyRaw: string): Promise<string | undefined> {
    const legacyKey = legacyKeyRaw.replace(/^\/+/g, '');
    if (!legacyKey) return undefined;
    if (legacyKey.toLowerCase().endsWith('.txt')) return undefined;

    // If legacy data already uses rooms/<room>/..., extract the relative path
    if (legacyKey.startsWith('rooms/')) {
      const parts = legacyKey.split('/');
      if (parts.length >= 3) {
        const [, legacyRoom, ...rest] = parts;
        if (!this.roomId || legacyRoom === this.roomId) {
          const relative = rest.join('/');
          const exists = await this.env.ROOM_BUCKET.head(legacyKey);
          if (exists) return relative;
        }
      }
    }

    // Attempt to copy the legacy object into the room-scoped namespace.
    try {
      const obj = await this.env.ROOM_BUCKET.get(legacyKey);
      if (obj) {
        const relative = legacyKey;
        const targetKey = roomR2Key(this.roomId, relative);
        const bytes = new Uint8Array(await obj.arrayBuffer());
        await this.env.ROOM_BUCKET.put(targetKey, bytes, {
          httpMetadata: { contentType: obj.httpMetadata?.contentType || guessMimeFromKey(relative) },
        });
        return relative;
      }
    } catch {
      // fall through
    }

    return undefined;
  }

  // Ensure current image points to an existing image/* object; if not, prefer base image
  private async ensureValidCurrentImage() {
    try {
      const head = await this.env.ROOM_BUCKET.head(roomR2Key(this.roomId, this.imagePath));
      const ct = head?.httpMetadata?.contentType || '';
      const looksImage = ct.startsWith('image/');
      if (!head || !looksImage) {
        const base = await ensureRoomBase(this.env, this.roomId);
        this.version = 0;
        this.imagePath = base.path;
        this.baseReady = base.ready;
        this.resetPending = false;
        this.versionHistory = [this.imagePath];
        await this.persistState();
      } else {
        this.appendHistory(this.imagePath);
      }
    } catch {}
  }

  private broadcastImageUpdate(op_id?: string) {
    this.broadcast({
      type: 'image_updated',
      imageUrl: roomImageUrl(this.roomId, this.imagePath),
      version: this.version,
      op_id,
      baseReady: this.baseReady,
      resetPending: this.resetPending,
      promptCounter: this.promptCounter,
      resetInterval: this.resetInterval,
    });
  }

  private broadcast(msg: WsMsg) {
    const data = JSON.stringify(msg);
    for (const ws of this.sockets) {
      try {
        ws.send(data);
      } catch {
        // Drop broken sockets silently
      }
    }
  }

  private broadcastQueueStats() {
    // length = number of waiting items (excludes the one currently processing)
    const length = this.queue.length;
    this.broadcast({ type: 'queue_stats', length, processing: this.processing });
  }

  private broadcastPresence() {
    this.broadcast({ type: 'presence', count: this.sockets.size });
  }

  private handleSocketMessage(ws: WebSocket, event: MessageEvent) {
    if (!event?.data) return;
    let payload: any;
    if (typeof event.data === 'string') {
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
    } else if (event.data instanceof ArrayBuffer) {
      try {
        payload = JSON.parse(new TextDecoder().decode(event.data));
      } catch {
        return;
      }
    } else if (event.data instanceof Uint8Array) {
      try {
        payload = JSON.parse(new TextDecoder().decode(event.data));
      } catch {
        return;
      }
    } else {
      return;
    }
    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'reaction') {
      this.processReaction(ws, payload);
    }
  }

  private processReaction(ws: WebSocket, payload: any) {
    const emojiRaw = typeof payload?.emoji === 'string' ? payload.emoji : '';
    if (!isReactionEmoji(emojiRaw)) {
      return;
    }
    const emoji = emojiRaw;
    const now = Date.now();
    if (!this.checkSocketReactionBudget(ws, now)) {
      this.sendToSocket(ws, { type: 'reaction_blocked', reason: 'rate_limited' });
      return;
    }
    this.enqueueReaction(emoji);
  }

  private checkSocketReactionBudget(ws: WebSocket, now: number): boolean {
    const meta = this.socketMeta.get(ws);
    if (!meta) return true;
    const log = meta.reactionLog;
    while (log.length && now - log[0] > REACTION_SOCKET_WINDOW_MS) {
      log.shift();
    }
    if (log.length >= REACTION_SOCKET_LIMIT) {
      return false;
    }
    log.push(now);
    return true;
  }

  private scheduleReactionFlush() {
    if (this.reactionFlushPromise) return;
    const promise = (async () => {
      try {
        await sleep(REACTION_BATCH_INTERVAL_MS);
        this.flushReactions();
      } finally {
        this.reactionFlushPromise = undefined;
      }
    })();
    this.reactionFlushPromise = promise;
    this.state.waitUntil(promise);
  }

  private flushReactions() {
    if (this.reactionPending.size === 0) return;
    const now = Date.now();
    for (const emoji of this.reactionPending.keys()) {
      const count = this.reactionPending.get(emoji) ?? 0;
      if (count <= 0) continue;
      this.recordReaction(emoji, now, count);
      const total = this.reactionTotals.get(emoji) ?? count;
      const intensity = Math.min(1, total / REACTION_INTENSITY_TARGET);
      const burstBase = Math.max(count, Math.ceil(intensity * REACTION_MAX_BURST));
      const burst = Math.min(Math.max(1, burstBase), REACTION_MAX_BURST);
      this.broadcast({ type: 'reaction_emit', emoji, burst, intensity, total });
    }
    this.reactionPending.clear();
  }

  private recordReaction(emoji: ReactionEmoji, timestamp: number, count: number) {
    const buckets = this.reactionBuckets.get(emoji) ?? [];
    buckets.push({ timestamp, count });
    this.reactionBuckets.set(emoji, buckets);
    const total = (this.reactionTotals.get(emoji) ?? 0) + count;
    this.reactionTotals.set(emoji, total);
    this.trimReactionBuckets(emoji, timestamp);
  }

  private trimReactionBuckets(emoji: ReactionEmoji, now: number) {
    const buckets = this.reactionBuckets.get(emoji);
    if (!buckets || buckets.length === 0) {
      this.reactionTotals.set(emoji, this.reactionTotals.get(emoji) ?? 0);
      return;
    }
    let total = this.reactionTotals.get(emoji) ?? 0;
    while (buckets.length && now - buckets[0].timestamp > REACTION_WINDOW_MS) {
      const bucket = buckets.shift();
      if (bucket) total -= bucket.count;
    }
    if (total < 0) total = 0;
    this.reactionTotals.set(emoji, total);
    if (buckets.length === 0) {
      this.reactionBuckets.delete(emoji);
    }
  }

  private sendToSocket(ws: WebSocket, message: unknown) {
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }

  private enqueueReaction(emoji: ReactionEmoji) {
    const pending = this.reactionPending.get(emoji) ?? 0;
    this.reactionPending.set(emoji, pending + 1);
    this.scheduleReactionFlush();
  }

  private appendHistory(path: string) {
    if (!path) return;
    if (this.versionHistory[this.versionHistory.length - 1] !== path) {
      this.versionHistory.push(path);
    }
    while (this.versionHistory.length > MAX_HISTORY_ENTRIES) {
      this.versionHistory.shift();
    }
  }

  private async clearTimelapseState(broadcast = true) {
    const deadline = this.timelapseDeadline;
    this.timelapseActive = false;
    this.timelapseFrames = [];
    this.timelapseDeadline = undefined;
    this.timelapseStartedAt = undefined;
    await this.state.blockConcurrencyWhile(async () => {
      try {
        await this.state.storage.deleteAlarm();
      } catch {}
    });
    if (broadcast && deadline) {
      this.broadcastTimelapseEnd(deadline);
    }
  }

  private timelapseFrameUrls(): string[] {
    return this.timelapseFrames.map((relative) => roomImageUrl(this.roomId, relative));
  }

  private collectTimelapseFrames(): string[] {
    const desired = Math.max(2, (this.resetInterval || DEFAULT_GLOBAL_RESET_INTERVAL) + 1);
    const limit = Math.min(TIMELAPSE_MAX_FRAMES, desired);
    const start = Math.max(0, this.versionHistory.length - limit);
    return this.versionHistory.slice(start);
  }

  private async beginTimelapseOrReset(): Promise<boolean> {
    if (this.timelapseActive) return true;

    const frames = this.collectTimelapseFrames();
    if (frames.length < 2) {
      await this.resetToBaseImage(true);
      return false;
    }

    const now = Date.now();
    this.timelapseActive = true;
    this.timelapseFrames = frames;
    this.timelapseStartedAt = now;
    this.timelapseDeadline = now + TIMELAPSE_DURATION_MS;
    this.resetPending = true;
    await this.persistState();
    this.broadcastTimelapseStart();
    await this.state.storage.setAlarm(this.timelapseDeadline);
    return true;
  }

  private broadcastTimelapseStart() {
    if (!this.timelapseActive || !this.timelapseDeadline) return;
    this.broadcast({
      type: 'timelapse_start',
      frames: this.timelapseFrameUrls(),
      durationMs: TIMELAPSE_DURATION_MS,
      deadline: this.timelapseDeadline,
    });
  }

  private broadcastTimelapseEnd(deadline: number) {
    this.broadcast({ type: 'timelapse_end', deadline });
  }

  private async resetToBaseImage(broadcast = true) {
    const base = await ensureRoomBase(this.env, this.roomId);
    if (!base.ready && this.roomId !== DEFAULT_ROOM_NAME) {
      // Custom rooms without a base cannot reset; keep current image/path.
      return;
    }
    this.version = 0;
    this.imagePath = base.path;
    this.baseReady = base.ready;
    this.promptCounter = 0;
    this.resetPending = false;
    this.versionHistory = [base.path];
    await this.persistState();
    if (broadcast) {
      this.broadcastImageUpdate();
    }
  }

  private async completeTimelapseIfDue(deadline: number, immediate = false) {
    if (!this.timelapseActive) return;
    const expected = this.timelapseDeadline ?? 0;
    if (Math.abs(expected - deadline) > 2000 && expected !== 0) {
      // Ignore stale alarms
      return;
    }
    await this.resetToBaseImage(false);
    const finalDeadline = this.timelapseDeadline ?? deadline;
    await this.clearTimelapseState(false);
    await this.persistState();
    this.broadcastTimelapseEnd(finalDeadline);
    this.broadcastImageUpdate();
    if (this.queue.length > 0) {
      if (immediate) {
        await this.processQueue();
      } else {
        this.state.waitUntil(this.processQueue());
      }
    }
  }

  private queuePositionFor(op_id?: string): number {
    if (!op_id) return this.queue.length; // end of queue if unknown
    const idx = this.queue.findIndex((o) => o.op_id === op_id);
    return idx >= 0 ? idx + 1 : 0;
  }

  private queueAheadFor(op_id?: string): number {
    if (!op_id) return this.queue.length + (this.processing ? 1 : 0);
    const idx = this.queue.findIndex((o) => o.op_id === op_id);
    const waitingAhead = idx >= 0 ? idx : 0;
    return waitingAhead + (this.processing ? 1 : 0);
  }

  private pruneSeenOps(now: number) {
    for (const [id, ts] of this.seenOpIds) {
      if (now - ts > SEEN_OP_TTL_MS) {
        this.seenOpIds.delete(id);
      } else {
        break;
      }
    }
    while (this.seenOpIds.size > SEEN_OP_MAX) {
      const oldest = this.seenOpIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seenOpIds.delete(oldest);
    }
  }

  private markOpSeen(opId: string, now: number) {
    this.seenOpIds.delete(opId);
    this.seenOpIds.set(opId, now);
    this.pruneSeenOps(now);
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    // Do not broadcast here; we'll broadcast after dequeuing the first item

    while (this.queue.length > 0) {
      const shouldPause = await this.ensureResetBeforeProcessing();
      if (shouldPause && this.timelapseActive) {
        break;
      }

      const op = this.queue.shift()!;
      // After dequeuing, queue contains only waiting items; broadcast accurate waiting count
      this.broadcastQueueStats();
      try {
        const { imagePath } = await this.processOp(op);
        this.version += 1;
        this.imagePath = imagePath;
        this.promptCounter += 1;
        this.scheduleResetIfNeeded();
        this.appendHistory(this.imagePath);
        await this.persistState();
        this.broadcastImageUpdate(op.op_id);
        // Next iteration will broadcast updated waiting count after dequeuing the next item
        if (this.resetPending && !this.timelapseActive && this.queue.length === 0) {
          const started = await this.beginTimelapseOrReset();
          if (started) break;
        }
      } catch (err: any) {
        this.broadcast({ type: 'error', message: err?.message || 'edit failed', op_id: op.op_id });
      }
    }

    this.processing = false;
    // Final queue stats when idle (0 waiting)
    this.broadcastQueueStats();

    if (this.queue.length === 0 && this.resetPending && !this.timelapseActive) {
      await this.beginTimelapseOrReset();
    }
  }

  private async processOp(op: Op): Promise<{ imagePath: string }> {
    const apiKey = this.env.FAL_KEY;
    if (!apiKey) {
      throw new Error('FAL_KEY not configured');
    }
    if (!this.baseReady && this.roomId !== DEFAULT_ROOM_NAME) {
      throw new Error('Upload a base image before editing');
    }

    const current = await this.env.ROOM_BUCKET.get(roomR2Key(this.roomId, this.imagePath));
    let baseImageBytes: Uint8Array | undefined;
    let baseImageMime: string | undefined;
    if (current) {
      const ct = current.httpMetadata?.contentType || '';
      if (ct.startsWith('image/')) {
        const ab = await current.arrayBuffer();
        baseImageBytes = new Uint8Array(ab);
        baseImageMime = ct;
      }
    }

    const baseImageUrl = externalRoomImageUrl(op.origin, this.roomId, this.imagePath);

    const payload: Record<string, unknown> = { prompt: op.prompt };
    if (baseImageBytes && baseImageMime) {
      payload.image_url = `data:${baseImageMime};base64,${uint8ToBase64(baseImageBytes)}`;
    } else if (baseImageUrl && !isLocalOrigin(op.origin)) {
      payload.image_url = baseImageUrl;
    }
    if (!payload.image_url) {
      // No base image available; provide a starter scene description.
      payload.prompt = `Base scene: ${DEFAULT_BASE_SCENE}. Now ${op.prompt}`;
    }

    payload.output_format = 'png';
    payload.safety_tolerance = '2';
    payload.guidance_scale = 7;
    payload.image_guidance_scale = 2;
    payload.prompt_strength = 0.45;

    const job = await submitFalKontextJob(apiKey, payload, { timeoutMs: FAL_POLL_TIMEOUT_MS });
    const imageData = await resolveFalImage(job.resultJson, apiKey);
    const extension = extensionForContentType(imageData.contentType);
    const newPath = `versions/${String(this.version + 1).padStart(4, '0')}.${extension}`;
    await this.env.ROOM_BUCKET.put(roomR2Key(this.roomId, newPath), imageData.bytes, {
      httpMetadata: { contentType: imageData.contentType },
    });
    return { imagePath: newPath };
  }

  private async refreshBaseFromUpload(): Promise<boolean> {
    const base = await findExistingRoomBase(this.env, this.roomId);
    if (!base) {
      if (this.baseReady) {
        this.baseReady = false;
        await this.persistState();
      }
      return false;
    }
    this.version = 0;
    this.imagePath = base.path;
    this.baseReady = true;
    this.promptCounter = 0;
    this.resetPending = false;
    this.versionHistory = [base.path];
    await this.persistState();
    this.broadcastImageUpdate();
    return true;
  }

  async fetch(req: Request): Promise<Response> {
    this.captureRoomId(req);
    await this.initIfNeeded();

    const url = new URL(req.url);
    const pathname = url.pathname;
    const method = req.method.toUpperCase();

    if (pathname === '/state' && method === 'GET') {
      await this.ensureValidCurrentImage();
      return json({
        imageUrl: roomImageUrl(this.roomId, this.imagePath),
        version: this.version,
        baseReady: this.baseReady,
        promptCounter: this.promptCounter,
        resetInterval: this.resetInterval,
        minResetInterval: MIN_RESET_INTERVAL,
        maxResetInterval: MAX_RESET_INTERVAL,
        resetPending: this.resetPending,
        connections: this.sockets.size,
        timelapse: this.timelapseActive && this.timelapseDeadline
          ? {
              active: true,
              frames: this.timelapseFrameUrls(),
              durationMs: TIMELAPSE_DURATION_MS,
              deadline: this.timelapseDeadline,
            }
          : undefined,
      });
    }

    if (pathname === '/ops' && method === 'POST') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }

      const prompt = (body?.prompt ?? '').toString().trim();
      const op_id = body?.op_id ? String(body.op_id) : undefined;
      if (!prompt) return json({ error: 'prompt is required' }, 400);
      if (!this.baseReady && this.roomId !== DEFAULT_ROOM_NAME) {
        return json({ error: 'Upload a base image before editing', requiresUpload: true }, 400);
      }
      if (this.timelapseActive && this.timelapseDeadline) {
        return json(
          {
            error: 'Room is resetting, please wait for the countdown to finish',
            timelapse: { deadline: this.timelapseDeadline, durationMs: TIMELAPSE_DURATION_MS },
          },
          409
        );
      }

      const forceSync = req.headers.get('x-test-sync') === '1';

      const now = Date.now();
      this.pruneSeenOps(now);

      if (op_id) {
        const seenAt = this.seenOpIds.get(op_id);
        if (seenAt && now - seenAt <= SEEN_OP_TTL_MS) {
          this.markOpSeen(op_id, now);
          return json({ queued: true, position: this.queuePositionFor(op_id) });
        }
        if (seenAt) this.seenOpIds.delete(op_id);
      }

      const fullPrompt = withStabilitySuffix(prompt);
      const origin = url.origin;
      const op: Op = {
        prompt: fullPrompt,
        op_id,
        parentVersion: this.version,
        enqueuedAt: now,
        origin,
      };
      this.queue.push(op);
      if (op_id) this.markOpSeen(op_id, now);

      const position = this.queuePositionFor(op_id);
      const ahead = this.queueAheadFor(op_id);
      this.broadcast({ type: 'queue', position, ahead, op_id });
      this.broadcastQueueStats();
      // Kick processor
      if (forceSync) {
        await this.processQueue();
      } else {
        this.state.waitUntil(this.processQueue());
      }
      return json({ queued: true, position });
    }

    if (pathname === '/stream' && method === 'GET') {
      const upgrade = req.headers.get('upgrade');
      if (upgrade !== 'websocket') return new Response('Expected websocket', { status: 426 });

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.acceptSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (pathname === '/admin/reset' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      const base = await ensureRoomBase(this.env, this.roomId);
      if (!base.ready && this.roomId !== DEFAULT_ROOM_NAME) {
        return json({ error: 'No base image found for room' }, 400);
      }
      await this.clearTimelapseState();
      await this.resetToBaseImage(true);
      return json({
        ok: true,
        imageUrl: roomImageUrl(this.roomId, this.imagePath),
        version: this.version,
        baseReady: this.baseReady,
        timelapseActive: this.timelapseActive,
      });
    }

    if (pathname === '/admin/flush' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      await this.clearTimelapseState(false);
      this.queue = [];
      this.processing = false;
      this.seenOpIds.clear();
      this.version = 0;
      this.imagePath = DEFAULT_PLACEHOLDER_PATH;
      this.roomInitialized = false;
      this.baseReady = isDefaultRoomId(this.roomId);
      this.promptCounter = 0;
      this.resetInterval = this.defaultResetInterval();
      this.resetPending = false;
      this.versionHistory = [];
      await this.state.blockConcurrencyWhile(async () => {
        try {
          const stored = await this.state.storage.list();
          for (const key of stored.keys()) {
            await this.state.storage.delete(key);
          }
        } catch {}
        try {
          await this.state.storage.deleteAlarm();
        } catch {}
      });
      return json({ ok: true });
    }

    if (pathname === '/admin/test-backdate-seen' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const opId = typeof body?.op_id === 'string' ? body.op_id : undefined;
      const timestamp = typeof body?.timestamp === 'number' ? body.timestamp : undefined;
      if (!opId || !Number.isFinite(timestamp)) {
        return json({ error: 'op_id and timestamp are required' }, 400);
      }
      await this.state.blockConcurrencyWhile(async () => {
        this.seenOpIds.set(opId, timestamp);
      });
      return json({ ok: true });
    }

    if (pathname.startsWith('/admin/test-get-seen') && method === 'GET') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      const url = new URL(req.url);
      const opId = url.searchParams.get('op_id');
      if (!opId) return json({ error: 'op_id is required' }, 400);
      const seenAt = this.seenOpIds.get(opId);
      return json({ op_id: opId, seenAt: typeof seenAt === 'number' ? seenAt : null });
    }

    if (pathname === '/admin/test-complete-timelapse' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      if (this.timelapseActive && this.timelapseDeadline) {
        await this.completeTimelapseIfDue(this.timelapseDeadline, true);
      }
      return json({ ok: true });
    }

    if (pathname === '/admin/test-reactions' && method === 'GET') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      const pending = Array.from(this.reactionPending.entries()).map(([emoji, count]) => ({ emoji, count }));
      const totals = Array.from(this.reactionTotals.entries()).map(([emoji, total]) => ({ emoji, total }));
      return json({ pending, totals });
    }

    if (pathname === '/admin/test-flush-reactions' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      this.flushReactions();
      return json({ ok: true });
    }

    if (pathname === '/admin/test-reaction' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      const emojiCandidate = typeof body?.emoji === 'string' ? body.emoji : REACTION_EMOJIS[0];
      const emoji = isReactionEmoji(emojiCandidate) ? emojiCandidate : REACTION_EMOJIS[0];
      const count = Math.max(1, Math.floor(Number(body?.count) || 1));
      for (let i = 0; i < count; i++) {
        this.enqueueReaction(emoji);
      }
      if (body?.flush === true) {
        this.flushReactions();
      }
      return json({ ok: true, emoji, count });
    }

    if (pathname === '/admin/test-simulate-reaction' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      const iterator = this.sockets.values().next();
      const socket = iterator.value as WebSocket | undefined;
      if (!socket) return json({ error: 'no active sockets' }, 400);
      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      const emojiCandidate = typeof body?.emoji === 'string' ? body.emoji : REACTION_EMOJIS[0];
      const emoji = isReactionEmoji(emojiCandidate) ? emojiCandidate : REACTION_EMOJIS[0];
      const count = Math.max(1, Math.floor(Number(body?.count) || 1));
      for (let i = 0; i < count; i++) {
        const evt = new MessageEvent('message', { data: JSON.stringify({ type: 'reaction', emoji }) });
        this.handleSocketMessage(socket, evt);
      }
      return json({ ok: true, emoji, count });
    }

    if (pathname === '/admin/refresh-base' && method === 'POST') {
      if (!req.headers.get('x-dev-admin')) return new Response('Forbidden', { status: 403 });
      const refreshed = await this.refreshBaseFromUpload();
      if (!refreshed) return json({ error: 'No base image found for room' }, 400);
      return json({ ok: true, imageUrl: roomImageUrl(this.roomId, this.imagePath), version: this.version, baseReady: this.baseReady });
    }

    if (pathname === '/config/reset-interval' && method === 'POST') {
      if (isDefaultRoomId(this.roomId)) {
        return json({ error: 'Reset interval is fixed for this room', resetInterval: DEFAULT_GLOBAL_RESET_INTERVAL }, 400);
      }
      let body: any;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const raw = body?.interval ?? body?.resetInterval;
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(parsed)) {
        return json({ error: 'interval must be a positive number', min: MIN_RESET_INTERVAL, max: MAX_RESET_INTERVAL }, 400);
      }
      const updated = this.setResetInterval(parsed);
      await this.persistState();
      return json({ ok: true, resetInterval: updated, min: MIN_RESET_INTERVAL, max: MAX_RESET_INTERVAL, resetPending: this.resetPending });
    }

    if (pathname === '/reset' && method === 'POST') {
      if (!this.baseReady && this.roomId !== DEFAULT_ROOM_NAME) {
        return json({ error: 'No base image found for room' }, 400);
      }
      await this.clearTimelapseState();
      await this.resetToBaseImage(true);
      return json({
        ok: true,
        resetPending: this.resetPending,
        promptCounter: this.promptCounter,
        resetInterval: this.resetInterval,
        timelapseActive: this.timelapseActive,
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private acceptSocket(ws: WebSocket) {
    ws.accept();
    this.sockets.add(ws);
    this.socketMeta.set(ws, { reactionLog: [] });
    // Send initial state to new client
    try {
      // Initial queue stats (waiting only)
      const length = this.queue.length;
      ws.send(JSON.stringify({ type: 'queue_stats', length, processing: this.processing } satisfies QueueStatsMsg));
      ws.send(JSON.stringify({
        type: 'image_updated',
        imageUrl: roomImageUrl(this.roomId, this.imagePath),
        version: this.version,
        baseReady: this.baseReady,
        resetPending: this.resetPending,
      } satisfies ImageUpdateMsg));
      if (this.timelapseActive && this.timelapseDeadline) {
        ws.send(
          JSON.stringify({
            type: 'timelapse_start',
            frames: this.timelapseFrameUrls(),
            durationMs: TIMELAPSE_DURATION_MS,
            deadline: this.timelapseDeadline,
          } satisfies TimelapseStartMsg)
        );
      }
    } catch {}

    this.sendToSocket(ws, { type: 'presence', count: this.sockets.size });
    this.broadcastPresence();

    ws.addEventListener('close', () => {
      this.sockets.delete(ws);
      this.socketMeta.delete(ws);
      this.broadcastPresence();
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch {}
      this.sockets.delete(ws);
      this.socketMeta.delete(ws);
      this.broadcastPresence();
    });
    ws.addEventListener('message', (event) => this.handleSocketMessage(ws, event));
  }

  async alarm() {
    if (!this.timelapseActive) return;
    const deadline = this.timelapseDeadline ?? Date.now();
    await this.completeTimelapseIfDue(deadline);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function withStabilitySuffix(prompt: string): string {
  const suffix = ' Keep everything else in the image exactly the same, preserving the original style, lighting, and composition. Ensure the composition fits within a square frame and keep the added object fully visible.';
  return prompt.endsWith('.') ? prompt + suffix : prompt + '.' + suffix;
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk) as unknown as number[]);
  }
  // btoa is available in Workers runtime
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  // atob is available in Workers runtime
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    if (!hostname) return false;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local')
    );
  } catch {
    return false;
  }
}

function externalRoomImageUrl(origin: string, roomId: string, relativePath: string): string | undefined {
  try {
    const base = new URL(origin);
    const encodedRoom = encodeURIComponent(roomId);
    const encodedPath = encodePathForUrl(relativePath);
    return `${base.origin}/${encodedRoom}/img/${encodedPath}`;
  } catch {
    return undefined;
  }
}

async function safeText(resp: Response): Promise<string | undefined> {
  try {
    return await resp.text();
  } catch {
    return undefined;
  }
}

type FalStatusEntry = {
  status?: string;
  queue_position?: number;
  logs?: unknown;
  timestamp: number;
};

async function submitFalKontextJob(
  apiKey: string,
  payload: Record<string, unknown>,
  options?: { timeoutMs?: number; captureTimeline?: boolean }
): Promise<{ resultJson: any; timeline: FalStatusEntry[]; requestId: string }> {
  const timeoutMs = options?.timeoutMs ?? 2 * 60 * 1000;
  const captureTimeline = options?.captureTimeline ?? false;

    const enqueueResp = await fetch(FAL_QUEUE_BASE, {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
    body: JSON.stringify(payload),
  });
  if (!enqueueResp.ok) {
    const text = await safeText(enqueueResp);
    throw new Error(`fal.ai enqueue failed (${enqueueResp.status}): ${text?.slice(0, 300) ?? 'unknown error'}`);
  }
  const enqueueJson: any = await enqueueResp.json();
  const requestId = typeof enqueueJson?.request_id === 'string' ? enqueueJson.request_id : undefined;
  const responseUrl = typeof enqueueJson?.response_url === 'string' ? enqueueJson.response_url : undefined;
  const statusUrlRaw = typeof enqueueJson?.status_url === 'string' ? enqueueJson.status_url : undefined;
  if (!requestId) {
    throw new Error('fal.ai enqueue response missing request_id');
  }

  const baseRequestUrl = responseUrl
    ? responseUrl.replace(/\/status(?:\?.*)?$/, '')
    : `${FAL_QUEUE_BASE}/requests/${requestId}`;
  const statusUrlObj = statusUrlRaw
    ? new URL(statusUrlRaw)
    : responseUrl
      ? new URL(responseUrl)
      : new URL(`${baseRequestUrl}/status`);
  if (captureTimeline) statusUrlObj.searchParams.set('logs', '1');
  const statusUrl = statusUrlObj.toString();
  const timeline: FalStatusEntry[] = [];
  const started = Date.now();

  while (true) {
    const statusResp = await fetch(statusUrl, {
      headers: {
        Authorization: `Key ${apiKey}`,
        Accept: 'application/json',
      },
    });
    let statusJson: any;
    if (!statusResp.ok) {
      const text = await safeText(statusResp);
      if (statusResp.status === 400 && text && text.includes('still in progress')) {
        await sleep(FAL_POLL_INTERVAL_MS);
        continue;
      }
      throw new Error(`fal.ai status failed (${statusResp.status}): ${text?.slice(0, 300) ?? 'unknown error'}`);
    } else {
      statusJson = await statusResp.json();
    }
    if (captureTimeline) {
      timeline.push({
        status: statusJson?.status,
        queue_position: statusJson?.queue_position,
        logs: statusJson?.logs,
        timestamp: Date.now(),
      });
    }
    const status = statusJson?.status;
    if (status === 'COMPLETED') {
      break;
    }
    if (status === 'FAILED' || status === 'ERROR') {
      const reason = statusJson?.error ?? statusJson?.logs ?? statusJson;
      throw new Error(`fal.ai job failed: ${JSON.stringify(reason)}`);
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('fal.ai job timed out');
    }
    await sleep(FAL_POLL_INTERVAL_MS);
  }

  const resultResp = await fetch(baseRequestUrl, {
    headers: {
      Authorization: `Key ${apiKey}`,
      Accept: 'application/json',
    },
  });
  if (!resultResp.ok) {
    const text = await safeText(resultResp);
    throw new Error(`fal.ai result fetch failed (${resultResp.status}): ${text?.slice(0, 300) ?? 'unknown error'}`);
  }
  const resultJson: any = await resultResp.json();

  return { resultJson, timeline, requestId };
}

async function resolveFalImage(json: any, apiKey: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = findFirstString(json, isHttpUrl);
  if (url) {
    const headers: Record<string, string> = {};
    if (isFalHostedUrl(url)) headers.Authorization = `Key ${apiKey}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) {
      throw new Error(`Unable to download fal.ai image (${resp.status})`);
    }
    const ct = resp.headers.get('content-type') || 'image/png';
    const bytes = new Uint8Array(await resp.arrayBuffer());
    return { bytes, contentType: ct };
  }

  const dataUrl = findFirstString(json, isDataUrl);
  if (dataUrl) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw new Error('Invalid data URL from fal.ai response');
    return parsed;
  }

  const base64 = findFirstString(json, looksLikeBase64);
  if (base64) {
    return {
      bytes: base64ToUint8Array(base64),
      contentType: 'image/png',
    };
  }

  throw new Error('fal.ai response did not include an image payload');
}

function findFirstString(value: unknown, predicate: (input: string) => boolean): string | undefined {
  const stack: unknown[] = [value];
  const visited = new Set<unknown>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || current === undefined) continue;
    if (visited.has(current)) continue;
    if (typeof current === 'string') {
      if (predicate(current)) return current;
    } else if (Array.isArray(current)) {
      for (let i = current.length - 1; i >= 0; i--) stack.push(current[i]);
    } else if (typeof current === 'object') {
      visited.add(current);
      for (const value of Object.values(current as Record<string, unknown>)) {
        stack.push(value);
      }
    }
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function isDataUrl(value: string): boolean {
  return /^data:image\/(png|jpeg|webp);base64,/i.test(value.trim());
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 64) return false;
  const sanitized = value.trim();
  if (/^data:/i.test(sanitized)) return false;
  return /^[A-Za-z0-9+/=]+$/.test(sanitized);
}

function isFalHostedUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname.endsWith('.fal.ai') ||
      hostname.endsWith('.fal.run') ||
      hostname.endsWith('.fal.media')
    );
  } catch {
    return false;
  }
}

function parseDataUrl(dataUrl: string): { bytes: Uint8Array; contentType: string } | undefined {
  const match = /^data:(?<type>image\/[A-Za-z0-9.+-]+);base64,(?<data>[A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
  if (!match || !match.groups) return undefined;
  const { type, data } = match.groups;
  return {
    bytes: base64ToUint8Array(data),
    contentType: type,
  };
}

function extensionForContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('jpeg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('png')) return 'png';
  return 'png';
}

async function ensureRoomBase(env: Env, roomId: string): Promise<{ path: string; ready: boolean }> {
  for (const candidate of ROOM_BASE_CANDIDATES) {
    const existing = await env.ROOM_BUCKET.head(roomR2Key(roomId, candidate));
    if (existing) return { path: candidate, ready: true };
  }

  if (roomId === DEFAULT_ROOM_NAME) {
    for (const candidate of ROOM_BASE_CANDIDATES) {
      const shared = await env.ROOM_BUCKET.get(candidate);
      if (shared) {
        const bytes = new Uint8Array(await shared.arrayBuffer());
        await env.ROOM_BUCKET.put(roomR2Key(roomId, candidate), bytes, {
          httpMetadata: {
            contentType: shared.httpMetadata?.contentType || guessMimeFromKey(candidate),
          },
        });
        return { path: candidate, ready: true };
      }
    }
  }

  const placeholderKey = roomR2Key(roomId, DEFAULT_PLACEHOLDER_PATH);
  const exists = await env.ROOM_BUCKET.head(placeholderKey);
  if (!exists) {
    await env.ROOM_BUCKET.put(placeholderKey, base64ToUint8Array(DEFAULT_PLACEHOLDER_IMAGE_BASE64), {
      httpMetadata: { contentType: DEFAULT_PLACEHOLDER_CONTENT_TYPE },
    });
  }
  return { path: DEFAULT_PLACEHOLDER_PATH, ready: false };
}

async function findExistingRoomBase(env: Env, roomId: string): Promise<{ path: string; contentType: string } | undefined> {
  for (const candidate of ROOM_BASE_CANDIDATES) {
    const head = await env.ROOM_BUCKET.head(roomR2Key(roomId, candidate));
    if (head) {
      return {
        path: candidate,
        contentType: head.httpMetadata?.contentType || guessMimeFromKey(candidate),
      };
    }
  }
  return undefined;
}

function guessMimeFromKey(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

// --- TEMP DEBUG: Flux Kontex(t) diagnostics endpoint implementation ---
async function debugFlux(req: Request, env: Env): Promise<Response> {
  const apiKey = env.FAL_KEY || '';
  if (!apiKey) return json({ error: 'FAL_KEY not configured' }, 500);

  const u = new URL(req.url);
  const mode = (u.searchParams.get('mode') || 'auto').toLowerCase(); // 'text' | 'base' | 'auto'
  const prompt = (u.searchParams.get('prompt') || 'Add a small potted plant; keep everything else the same.').toString();
  const retries = Math.max(0, Math.min(5, Number.parseInt(u.searchParams.get('retries') || '1', 10)));
  const includeTimeline = u.searchParams.get('logs') === '1';

  const queryRoom = u.searchParams.get('room');
  const headerRoom = req.headers.get('x-room-id');
  const room = isValidRoomSlug(queryRoom)
    ? (queryRoom as string)
    : isValidRoomSlug(headerRoom)
      ? (headerRoom as string)
      : DEFAULT_ROOM_NAME;

  let baseBytes: Uint8Array | undefined;
  let baseMime: string | undefined;
  let activeImagePath: string | undefined;
  if (mode === 'base' || mode === 'auto') {
    try {
      const id = env.ROOM_DO.idFromName(room);
      const stub = env.ROOM_DO.get(id);
      const stateReq = new Request('https://do/state', { headers: { 'x-room-id': room } });
      const stateResp = await stub.fetch(stateReq);
      if (stateResp.ok) {
        const state = (await stateResp.json()) as any;
        const imageUrl = String(state?.imageUrl || '');
        const encodedRoom = encodeURIComponent(room);
        const prefix = `/${encodedRoom}/img/`;
        if (imageUrl.startsWith(prefix)) {
          const segments = imageUrl.slice(prefix.length).split('/');
          const decoded = decodeKeySegments(segments);
          activeImagePath = decoded;
        }
        if (activeImagePath) {
          const obj = await env.ROOM_BUCKET.get(roomR2Key(room, activeImagePath));
          if (obj) {
            const ct = obj.httpMetadata?.contentType || '';
            if (ct.startsWith('image/')) {
              baseMime = ct;
              baseBytes = new Uint8Array(await obj.arrayBuffer());
            }
          }
        }
      }
    } catch {
      // ignore; we'll fall back to text-only
    }
  }

  const origin = u.origin;
  const baseUrl = activeImagePath ? externalRoomImageUrl(origin, room, activeImagePath) : undefined;

  function buildInput(withBase: boolean): Record<string, unknown> {
    const input: Record<string, unknown> = { prompt };
    if (withBase && baseUrl && !isLocalOrigin(origin)) {
      input.image_url = baseUrl;
    }
    if (withBase && baseBytes && baseMime && !input.image_url) {
      input.image_url = `data:${baseMime};base64,${uint8ToBase64(baseBytes)}`;
    }
    if (!withBase || !input.image_url) {
      input.prompt = `Base scene: ${DEFAULT_BASE_SCENE}. Now ${prompt}`;
    }
    input.output_format = 'png';
    input.safety_tolerance = '2';
    return input;
  }

  async function callWithRetries(withBase: boolean) {
    const attempts: any[] = [];
    let last: any = undefined;
    for (let i = 0; i <= retries; i++) {
      const t0 = Date.now();
      try {
        const job = await submitFalKontextJob(apiKey, buildInput(withBase), {
          timeoutMs: FAL_POLL_TIMEOUT_MS,
          captureTimeline: includeTimeline,
        });
        const image = await resolveFalImage(job.resultJson, apiKey);
        const duration = Date.now() - t0;
        const imageUrl = findFirstString(job.resultJson, isHttpUrl);
        last = {
          ok: true,
          ms: duration,
          requestId: job.requestId,
          image_url: imageUrl,
          image_bytes: image.bytes.length,
          content_type: image.contentType,
          timeline: includeTimeline ? job.timeline : undefined,
        };
        attempts.push(last);
        break;
      } catch (err: any) {
        const duration = Date.now() - t0;
        const message = err?.message || String(err);
        const attempt = {
          ok: false,
          ms: duration,
          error: message,
        };
        attempts.push(attempt);
        last = attempt;
        if (!shouldRetryFalError(message) || i === retries) {
          break;
        }
        await sleep(250 * Math.pow(2, i));
      }
    }
    return { attempts, last };
  }

  const results: Record<string, unknown> = {
    prompt: prompt.slice(0, 200),
    mode,
    retries,
  };

  if (mode === 'text') {
    results.text = await callWithRetries(false);
  } else if (mode === 'base') {
    results.base = await callWithRetries(true);
  } else {
    const baseRes = await callWithRetries(true);
    results.base = baseRes;
    if (!baseRes.last?.ok) {
      results.text = await callWithRetries(false);
    }
  }

  return json(results);
}

function shouldRetryFalError(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes('429') || lowered.includes('timeout') || lowered.includes('temporarily');
}

function renderIndexHtml(roomId: string): string {
  const slugJson = JSON.stringify(roomId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Shared Room</title>
  <style>
    :root { color-scheme: dark; }
    html, body { height: 100%; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin:0; background:#0b0c0e; color:#e6e6e6; }
    #app { position: relative; width: 100vw; height: 100svh; overflow: hidden; }
    #stage { position:absolute; inset:0; display:grid; place-items:center; z-index:0; }
    #canvas { position: relative; width: 100vw; height: 100svh; background:#111; overflow:hidden; touch-action: none; }
    #roomWrap { position:absolute; inset:0; will-change: transform; }
    #room { position:absolute; inset:0; width:100%; height:100%; object-fit: var(--room-object-fit, cover); background:#111; will-change: transform; user-select: none; -webkit-user-select: none; }
    #resetOverlay { position:absolute; top: 40px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.72); padding: 14px 24px; border-radius: 16px; font-weight: 700; font-size: 24px; letter-spacing: 0.06em; color:#fff; z-index: 40; pointer-events:none; text-transform: uppercase; box-shadow: 0 10px 28px rgba(0,0,0,0.35); }
    #resetOverlay.hidden { display:none !important; }
    #overlay { position:fixed; left:0; right:0; bottom:0; padding: 16px; padding-bottom: calc(16px + env(safe-area-inset-bottom)); background: linear-gradient(180deg, rgba(11,12,14,0) 0%, rgba(11,12,14,0.6) 35%, rgba(11,12,14,0.95) 100%); z-index: 20; display:flex; justify-content:center; }
    body.has-modal { overflow:hidden; }
    #inner { max-width: 960px; margin: 0 auto; width: 100%; }
    #status { font-size: 12px; opacity:.9; margin: 0 0 8px 4px; min-height: 1.2em; }
    form { display:flex; gap:8px; touch-action: manipulation; }
    input[type=text], input[type=number] { flex:1; padding:14px 16px; border-radius: 12px; border:1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.08); color:#fff; outline: none; font-size: 16px; }
    input[type=text]::placeholder, input[type=number]::placeholder { color: rgba(255,255,255,0.7); }
    button { padding: 14px 18px; border-radius: 12px; border:1px solid rgba(255,255,255,0.16); background:#1b1d22; color:#fff; cursor:pointer; font-size: 16px; }
    button:hover { background:#20232a; }
    #qbadge { position:fixed; top: calc(12px + env(safe-area-inset-top)); right: calc(12px + env(safe-area-inset-right)); padding:0; font-weight:800; font-size:44px; line-height:1; color:#ff3b30; z-index:30; }
    .hidden { display:none !important; }
    #uploadPane { margin-top: 12px; padding: 20px; border-radius: 16px; border:1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.55); display:flex; flex-direction:column; align-items:center; text-align:center; gap:16px; }
    #uploadSection { display:flex; flex-direction:column; gap: 12px; align-items:center; width:100%; }
    #uploadSection.hidden { display:none !important; }
    #uploadSection p { margin: 0; font-size: 15px; max-width: 320px; }
    #uploadControls { display: flex; flex-direction:column; gap: 10px; align-items:center; width:100%; }
    #uploadControls input[type=file] { border: none; font-size: 14px; color:#fff; text-align:center; }
    #uploadControls button { padding: 12px 16px; width: 100%; max-width: 220px; }
    #uploadStatus { font-size: 13px; margin-top: 4px; opacity: 0.85; min-height: 1.2em; }
    #intervalGroup { display:flex; flex-direction:column; gap: 8px; align-items:center; width:100%; }
    #intervalGroup label { font-size: 14px; opacity: 0.85; }
    #intervalInputs { display:flex; gap: 8px; width:100%; max-width: 220px; }
    #intervalInputs button { padding: 12px 16px; }
    #intervalStatus { font-size: 13px; min-height: 1.2em; opacity: 0.85; }
    #reactionLayer { position:absolute; inset:0; pointer-events:none; overflow:hidden; }
    .reaction-spark { position:absolute; bottom:12%; left:50%; font-size: clamp(20px, 3vw, 32px); opacity:0; transform: translate(calc(-50% + var(--spark-offset, 0px)), 0) scale(var(--spark-scale, 0.9)); pointer-events:none; filter: drop-shadow(0 8px 22px rgba(0,0,0,0.45)); animation: reactionFloat var(--spark-duration, 1.3s) ease-out forwards; }
    #reactionTray { display:flex; justify-content:center; gap: 10px; margin: 16px auto 0; flex-wrap: wrap; }
    .reaction-button { background: rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 10px 14px; font-size: 20px; line-height:1; cursor:pointer; transition: transform 120ms ease, background 120ms ease; }
    .reaction-button:hover { background: rgba(255,255,255,0.18); transform: translateY(-2px); }
    .reaction-button.flash { transform: scale(1.08); background: rgba(255,255,255,0.24); }
    .reaction-button:active { transform: scale(0.92); }
    .reaction-button:disabled { opacity:0.4; cursor:not-allowed; transform:none; }
    @keyframes reactionFloat {
      0% { opacity:0; transform: translate(calc(-50% + var(--spark-offset, 0px)), 0) scale(var(--spark-scale, 0.9)); }
      20% { opacity:1; }
      85% { opacity:1; }
      100% { opacity:0; transform: translate(calc(-50% + var(--spark-offset, 0px)), calc(-1 * var(--spark-rise, 180px))) scale(calc(var(--spark-scale, 0.9) * 1.1)); }
    }
    #indicatorRow { display:flex; justify-content:space-between; align-items:center; margin-top: 6px; color:#fff; font-size: 13px; letter-spacing: 0.01em; font-weight: 600; gap: 16px; min-height: 22px; }
    #indicatorRow .indicator { opacity: 0.9; }
    #indicatorRow .indicator:last-child { text-align: right; }
    #welcomeBackdrop { position:fixed; inset:0; background: rgba(10,11,13,0.88); backdrop-filter: blur(6px); z-index: 60; display:flex; align-items:center; justify-content:center; padding: 16px; }
    #welcomeBackdrop.hidden { display:none !important; }
    #welcomeModal { width:100%; max-width: 420px; background:#111317; border-radius: 18px; padding: 30px 28px; box-shadow: 0 24px 60px rgba(0,0,0,0.45); display:flex; flex-direction:column; gap:18px; text-align:center; align-items:center; }
    #welcomeModal h2 { margin:0; font-size: 24px; font-weight: 700; letter-spacing: 0.01em; }
    #welcomeModal p { margin:0; line-height:1.5; font-size: 15px; }
    #welcomeModal ul { margin:0; padding-left: 20px; text-align:left; font-size: 14px; line-height:1.5; display:flex; flex-direction:column; gap:6px; }
    #welcomeModal li { list-style: disc; }
    #welcomeModal .legal { font-size: 13px; opacity:0.78; }
    #welcomeModal .actions { margin-top:6px; display:flex; justify-content:center; gap: 12px; flex-wrap: wrap; }
    #welcomeModal button { padding: 12px 20px; min-width: 120px; border-radius: 12px; border:1px solid rgba(255,255,255,0.16); background:#1b1d22; color:#fff; cursor:pointer; font-size: 15px; }
    #welcomeModal button.leave { background:transparent; border-color: rgba(255,255,255,0.26); }
    #welcomeModal button.leave:hover { background: rgba(255,255,255,0.08); }
    @media (min-width: 768px) {
      #overlay { background: linear-gradient(180deg, rgba(11,12,14,0) 0%, rgba(11,12,14,0.55) 40%, rgba(11,12,14,0.9) 100%); padding-bottom: 16px; }
      #room { object-fit: contain; }
      #qbadge { top: 12px; right: auto; left: calc(50vw + (min(100vw, 100svh) / 2) + 12px); }
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="stage">
      <div id="canvas">
        <div id="roomWrap"><img id="room" alt="room" /></div>
        <div id="reactionLayer" aria-hidden="true"></div>
      </div>
    </div>
    <div id="qbadge" aria-live="polite" title="Total queue (incl. running)">0</div>
    <div id="resetOverlay" class="hidden">IMAGE RESET ON NEXT PROMPT</div>
    <div id="overlay">
      <div id="inner">
        <div id="status"></div>
        <div id="uploadPane" class="hidden">
          <div id="uploadSection">
            <p id="uploadMessage">Upload a base image to start editing this room.</p>
            <div id="uploadControls">
              <input id="baseUpload" type="file" accept="image/png,image/jpeg,image/webp" />
              <button id="uploadButton" type="button">Upload image</button>
            </div>
            <div id="uploadStatus"></div>
          </div>
          <div id="intervalGroup">
            <label for="resetInterval">Reset after this many prompts:</label>
            <div id="intervalInputs">
              <input id="resetInterval" type="number" min="1" max="500" step="1" placeholder="20" />
              <button id="intervalButton" type="button">Save limit</button>
            </div>
            <div id="intervalStatus"></div>
          </div>
        </div>
        <form id="form">
          <input id="prompt" type="text" autocomplete="off" placeholder="add something" />
          <button type="submit">Add</button>
        </form>
        <div id="indicatorRow">
          <div id="presenceIndicator" class="indicator">0 here</div>
          <div id="resetIndicator" class="indicator">--</div>
        </div>
        <div id="reactionTray" role="group" aria-label="Room reactions"></div>
      </div>
    </div>
  </div>
  <div id="welcomeBackdrop" class="hidden" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle">
    <div id="welcomeModal">
      <h2 id="welcomeTitle">THE ROOM</h2>
      <ul class="welcome-list">
        <li>One live image for everyone</li>
        <li>Add to it with a short prompt</li>
        <li>Edits apply in turn; quick resets keep it moving</li>
        <li>Public, real-time, always changing</li>
        <li>Create yours at /your-room-name</li>
      </ul>
      <p class="legal">Safety: no illegal or harmful content, nudity, hate, harassment, or personal data. By choosing Agree, you confirm you’re 18+ (or legal age where you live) and accept the guidelines.</p>
      <div class="actions">
        <button id="welcomeLeave" type="button" class="leave">Leave</button>
        <button id="welcomeAgree" type="button">Agree</button>
      </div>
    </div>
  </div>
  <script>
  const WELCOME_ACK_KEY = 'room-welcome-ack-v1';
  const ROOM_SLUG = ${slugJson};
  const REACTION_EMOJIS = ${JSON.stringify(REACTION_EMOJIS)};
  const REACTION_MAX_BURST = ${REACTION_MAX_BURST};
  const BASE_PATH = ROOM_SLUG ? '/' + encodeURIComponent(ROOM_SLUG) : '';
  const img = document.getElementById('room');
  const form = document.getElementById('form');
  const promptEl = document.getElementById('prompt');
  const statusEl = document.getElementById('status');
  const qbadge = document.getElementById('qbadge');
  const canvasEl = document.getElementById('canvas');
  const roomWrap = document.getElementById('roomWrap');
  const uploadPane = document.getElementById('uploadPane');
  const uploadSection = document.getElementById('uploadSection');
  const uploadInput = document.getElementById('baseUpload');
  const uploadButton = document.getElementById('uploadButton');
  const uploadStatus = document.getElementById('uploadStatus');
  const uploadMessage = document.getElementById('uploadMessage');
  const intervalInput = document.getElementById('resetInterval');
  const intervalButton = document.getElementById('intervalButton');
  const intervalStatus = document.getElementById('intervalStatus');
  const intervalGroup = document.getElementById('intervalGroup');
  const resetOverlay = document.getElementById('resetOverlay');
  const reactionTray = document.getElementById('reactionTray');
  const reactionLayer = document.getElementById('reactionLayer');
  const presenceIndicator = document.getElementById('presenceIndicator');
  const resetIndicator = document.getElementById('resetIndicator');
  const welcomeBackdrop = document.getElementById('welcomeBackdrop');
  const welcomeAgree = document.getElementById('welcomeAgree');
  const welcomeLeave = document.getElementById('welcomeLeave');
  const submitButton = form?.querySelector('button[type="submit"]');
  const isDefaultRoom = ROOM_SLUG === 'global';
  const TIMELAPSE_FALLBACK_MS = 60_000;
  const TIMELAPSE_FRAME_INTERVAL_MS = 1_000;
  let currentOpId = null;
  let aheadCount = null;
  let baseReady = isDefaultRoom;
  let intervalMin = 1;
  let intervalMax = 500;
  let resetIntervalValue = isDefaultRoom ? 10 : 20;
  let resetPending = false;
  let timelapseActive = false;
  let timelapseFrames = [];
  let timelapseDuration = TIMELAPSE_FALLBACK_MS;
  let timelapseDeadline = 0;
  let timelapseTimer = null;
  let countdownTimer = null;
  let timelapseIndex = 0;
  let latestQueueTotal = 0;
  let wsReady = false;
  let promptCount = 0;
  let presenceCount = 0;
  let hasConsent = false;
  const reactionCooldowns = new Map();
  const reactionButtons = new Map();
  const reactionPool = [];
  let reactionBlockedNotice = 0;
  const reactionRateMessage = 'Easy on the reactions for a second…';

  initWelcomeGate();
  initReactions();

  function initWelcomeGate() {
    hasConsent = readWelcomeAck();
    if (hasConsent) {
      hideWelcomeModal();
    } else {
      showWelcomeModal();
    }
    welcomeAgree?.addEventListener('click', () => {
      acknowledgeWelcome();
    });
    welcomeLeave?.addEventListener('click', () => {
      window.location.href = 'https://blackforestlabs.ai/';
    });
    document.addEventListener('keydown', (event) => {
      if (hasConsent) return;
      if (event.key === 'Escape') {
        event.preventDefault();
      } else if (event.key === 'Tab') {
        event.preventDefault();
        const focusables = [welcomeAgree, welcomeLeave].filter(Boolean);
        if (!focusables.length) return;
        const current = document.activeElement;
        let index = focusables.indexOf(current);
        if (event.shiftKey) {
          index = index <= 0 ? focusables.length - 1 : index - 1;
        } else {
          index = (index + 1) % focusables.length;
        }
        focusables[index]?.focus();
      } else if (event.key === 'Enter') {
        if (document.activeElement === welcomeAgree) {
          event.preventDefault();
          acknowledgeWelcome();
        }
      }
    }, true);
  }

  function acknowledgeWelcome() {
    if (hasConsent) return;
    hasConsent = true;
    try {
      window.localStorage.setItem(WELCOME_ACK_KEY, '1');
    } catch {}
    hideWelcomeModal();
    setReactionEnabled(wsReady);
    updateUI();
  }

  function readWelcomeAck() {
    try {
      return window.localStorage.getItem(WELCOME_ACK_KEY) === '1';
    } catch {
      return false;
    }
  }

  function showWelcomeModal() {
    welcomeBackdrop?.classList.remove('hidden');
    document.body.classList.add('has-modal');
    setTimeout(() => {
      welcomeAgree?.focus();
    }, 0);
  }

  function hideWelcomeModal() {
    welcomeBackdrop?.classList.add('hidden');
    document.body.classList.remove('has-modal');
  }

  function initReactions() {
    if (!reactionTray) return;
    reactionTray.innerHTML = '';
    REACTION_EMOJIS.forEach((emoji) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'reaction-button';
      button.textContent = emoji;
      button.disabled = true;
      button.setAttribute('aria-label', 'Send ' + emoji + ' reaction');
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        flashReactionButton(button);
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        handleReactionTap(emoji);
      });
      reactionTray.appendChild(button);
      reactionButtons.set(emoji, button);
    });
  }

  function setReactionEnabled(enabled) {
    const allow = enabled && hasConsent;
    reactionButtons.forEach((button) => {
      button.disabled = !allow;
      if (!allow) button.classList.remove('flash');
    });
  }

  function handleReactionTap(emoji) {
    if (!hasConsent) {
      showWelcomeModal();
      setStatus('Review the welcome message to continue.');
      return;
    }
    const button = reactionButtons.get(emoji);
    if (!button || button.disabled) return;
    const sent = sendReaction(emoji);
    if (sent) {
      spawnReactionBurst(emoji, 1, 0.25);
    } else if (!wsReady) {
      setReactionEnabled(false);
    }
  }

  function flashReactionButton(button) {
    button.classList.add('flash');
    setTimeout(() => button.classList.remove('flash'), 160);
  }

  function sendReaction(emoji) {
    if (!hasConsent) return false;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const now = Date.now();
    const last = reactionCooldowns.get(emoji) ?? 0;
    if (now - last < 120) return false;
    reactionCooldowns.set(emoji, now);
    try {
      ws.send(JSON.stringify({ type: 'reaction', emoji }));
      return true;
    } catch {
      return false;
    }
  }

  function spawnReactionBurst(emoji, burst, intensity) {
    if (!reactionLayer) return;
    const clamped = Math.max(1, Math.min(REACTION_MAX_BURST, Number(burst) || 1));
    const energy = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0;
    for (let i = 0; i < clamped; i++) {
      const el = reactionPool.pop() ?? createReactionSpark();
      el.textContent = emoji;
      const offset = (Math.random() - 0.5) * (180 + energy * 120);
      const rise = 140 + Math.random() * 80 + energy * 140;
      const scale = 0.8 + Math.random() * 0.4 + energy * 0.2;
      const duration = Math.max(700, 1100 - energy * 200 + Math.random() * 260);
      el.style.setProperty('--spark-offset', offset.toFixed(2) + 'px');
      el.style.setProperty('--spark-rise', rise.toFixed(2) + 'px');
      el.style.setProperty('--spark-scale', scale.toFixed(2));
      el.style.setProperty('--spark-duration', duration.toFixed(0) + 'ms');
      el.style.animationDelay = Math.random() * 80 + 'ms';
      reactionLayer.appendChild(el);
    }
  }

  function createReactionSpark() {
    const el = document.createElement('div');
    el.className = 'reaction-spark';
    el.addEventListener('animationend', () => {
      el.remove();
      el.style.animationDelay = '';
      reactionPool.push(el);
      if (reactionPool.length > 120) reactionPool.shift();
    });
    return el;
  }

  function showReactionBlocked() {
    if (reactionBlockedNotice) {
      clearTimeout(reactionBlockedNotice);
      reactionBlockedNotice = 0;
    }
    if (statusEl.textContent && statusEl.textContent !== reactionRateMessage) {
      return;
    }
    statusEl.textContent = reactionRateMessage;
    reactionBlockedNotice = setTimeout(() => {
      if (statusEl.textContent === reactionRateMessage) {
        setStatus('');
      }
    }, 1600);
  }

  function updatePresenceIndicator() {
    if (!presenceIndicator) return;
    const count = Math.max(0, Math.floor(Number(presenceCount) || 0));
    let label = 'No one here';
    if (count <= 0) {
      label = 'Just you here';
    } else if (count === 1) {
      label = '1 person here';
    } else {
      label = count + ' people here';
    }
    presenceIndicator.textContent = label;
  }

  function updateResetIndicator() {
    if (!resetIndicator) return;
    if (!hasConsent) {
      resetIndicator.textContent = 'Agree to continue';
      return;
    }
    if (!baseReady && !isDefaultRoom) {
      resetIndicator.textContent = 'Upload image to start';
      return;
    }
    if (timelapseActive) {
      resetIndicator.textContent = 'Resetting…';
      return;
    }
    if (resetPending) {
      resetIndicator.textContent = 'Reset pending';
      return;
    }
    const intervalVal = Math.max(1, Math.floor(Number(resetIntervalValue) || 1));
    const used = Math.max(0, Math.floor(Number(promptCount) || 0));
    const remaining = Math.max(0, intervalVal - used);
    const plural = remaining === 1 ? 'edit' : 'edits';
    resetIndicator.textContent = remaining + ' ' + plural + ' before reset';
  }

  async function load() {
    const r = await fetch(BASE_PATH + '/state');
    const s = await r.json();
    setImage(s.imageUrl);
    baseReady = Boolean(s.baseReady);
    resetPending = Boolean(s.resetPending);
    promptCount = Math.max(0, Math.floor(Number(s.promptCounter) || 0));
    presenceCount = Math.max(0, Math.floor(Number(s.connections) || 0));
    const stateInterval = Number(s.resetInterval);
    if (Number.isFinite(stateInterval) && stateInterval > 0) {
      resetIntervalValue = sanitizeInterval(stateInterval);
    }
    const tl = s.timelapse;
    if (tl && tl.active && Array.isArray(tl.frames) && tl.frames.length > 1 && typeof tl.deadline === 'number') {
      startTimelapsePlayback({
        frames: tl.frames,
        durationMs: Number(tl.durationMs) || TIMELAPSE_FALLBACK_MS,
        deadline: Number(tl.deadline),
      });
    } else {
      stopTimelapse(false);
    }
    if (!isDefaultRoom) {
      const min = Number(s.minResetInterval);
      const max = Number(s.maxResetInterval);
      if (Number.isFinite(min) && min >= 1) intervalMin = Math.max(1, Math.floor(min));
      if (Number.isFinite(max) && max >= intervalMin) intervalMax = Math.max(intervalMin, Math.floor(max));
      const nextInterval = Number(s.resetInterval);
      resetIntervalValue = sanitizeInterval(Number.isFinite(nextInterval) ? nextInterval : resetIntervalValue);
      if (intervalInput) {
        intervalInput.min = String(intervalMin);
        intervalInput.max = String(intervalMax);
        intervalInput.value = String(resetIntervalValue);
      }
      updateIntervalDisplay();
    }
    updateUI();
    updateResetOverlay();
    updateResetIndicator();
    updatePresenceIndicator();
  }
  function setImage(url, options) {
    const bustCache = options && Object.prototype.hasOwnProperty.call(options, 'bustCache') ? options.bustCache : true;
    const finalUrl = bustCache ? url + (url.includes('?') ? '&' : '?') + 't=' + Date.now() : url;
    img.src = finalUrl;
  }
  function setStatus(t) { statusEl.textContent = t || ''; }
  function setQueueDepth(n) {
    latestQueueTotal = typeof n === 'number' ? n : 0;
    qbadge.textContent = String(latestQueueTotal);
  }
  function updateUI() {
    const locked = timelapseActive;
    if (!hasConsent) {
      setStatus('Review the welcome message to continue.');
    }
    if (!isDefaultRoom) {
      const ready = !!baseReady;
      if (uploadPane) uploadPane.classList.toggle('hidden', ready);
      if (uploadSection) uploadSection.classList.toggle('hidden', ready);
      if (intervalGroup) intervalGroup.classList.toggle('hidden', ready);
      if (!ready && uploadStatus) uploadStatus.textContent = '';
      if (!ready && uploadMessage) uploadMessage.textContent = 'Upload a base image to start editing this room.';
      if (form) form.classList.toggle('hidden', !ready);
      if (promptEl) promptEl.disabled = !hasConsent || !ready || resetPending || locked;
      if (submitButton) {
        submitButton.textContent = !hasConsent ? 'Agree' : locked ? 'Wait' : resetPending ? 'Reset' : 'Add';
        submitButton.disabled = !hasConsent || !ready || locked;
      }
      if (uploadButton && !hasConsent) {
        uploadButton.disabled = true;
      }
      if (!ready && hasConsent) {
        setStatus('Upload a base image to start editing this room.');
      }
    }
    if (submitButton) {
      submitButton.textContent = !hasConsent ? 'Agree' : locked ? 'Wait' : resetPending ? 'Reset' : 'Add';
      if (isDefaultRoom) submitButton.disabled = !hasConsent || !baseReady || locked;
    }
    if (promptEl && isDefaultRoom) {
      promptEl.disabled = !hasConsent || !baseReady || resetPending || locked;
    }
    updateResetIndicator();
  }

  function pluralizePrompts(count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    return n === 1 ? '1 prompt' : n + ' prompts';
  }

  function sanitizeInterval(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return Math.max(intervalMin, Math.min(intervalMax, resetIntervalValue));
    }
    const floored = Math.floor(numeric);
    return Math.max(intervalMin, Math.min(intervalMax, floored));
  }

  function updateIntervalDisplay(message) {
    if (!intervalStatus || isDefaultRoom) return;
    if (message) {
      intervalStatus.textContent = message;
    } else {
      intervalStatus.textContent = 'Auto reset after ' + pluralizePrompts(resetIntervalValue) + '.';
    }
  }

  function updateResetOverlay() {
    if (!resetOverlay) return;
    if (!hasConsent) {
      resetOverlay.classList.add('hidden');
      updateResetIndicator();
      return;
    }
    const showOverlay = resetPending || timelapseActive;
    resetOverlay.classList.toggle('hidden', !showOverlay);
    if (showOverlay) {
      if (timelapseActive && timelapseDeadline) {
        const remaining = Math.max(0, timelapseDeadline - Date.now());
        resetOverlay.textContent = 'RESETTING… ' + Math.ceil(remaining / 1000) + 'S';
      } else {
        resetOverlay.textContent = 'IMAGE RESET ON NEXT PROMPT';
      }
    }
    if (timelapseActive) {
      setStatus('Resetting…');
    } else if (resetPending) {
      setStatus('Reset the room to continue editing.');
    }
    updateResetIndicator();
  }

  function clearTimelapseTimers() {
    if (timelapseTimer) {
      clearTimeout(timelapseTimer);
      timelapseTimer = null;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function updateCountdownDisplay() {
    if (!timelapseActive || !timelapseDeadline) return;
    const remaining = Math.max(0, timelapseDeadline - Date.now());
    if (timelapseActive && resetOverlay && !resetOverlay.classList.contains('hidden')) {
      resetOverlay.textContent = 'RESETTING… ' + Math.ceil(remaining / 1000) + 'S';
    }
  }

  function syncTimelapseFrame() {
    if (!timelapseActive || !timelapseDeadline || timelapseFrames.length === 0) return;
    const frameCount = timelapseFrames.length;
    const cycleDuration = Math.max(TIMELAPSE_FRAME_INTERVAL_MS, frameCount * TIMELAPSE_FRAME_INTERVAL_MS);
    const now = Date.now();
    const remaining = Math.max(0, timelapseDeadline - now);
    const elapsed = timelapseDuration - remaining;
    const playbackElapsed = ((elapsed % cycleDuration) + cycleDuration) % cycleDuration;
    const targetIndex = Math.min(frameCount - 1, Math.floor(playbackElapsed / TIMELAPSE_FRAME_INTERVAL_MS));
    if (targetIndex !== timelapseIndex) {
      timelapseIndex = targetIndex;
      setImage(timelapseFrames[timelapseIndex], { bustCache: false });
    }
    clearTimeout(timelapseTimer);
    const nextBoundary = (targetIndex + 1) * TIMELAPSE_FRAME_INTERVAL_MS;
    const wait = Math.max(50, (nextBoundary <= playbackElapsed ? cycleDuration : nextBoundary) - playbackElapsed);
    timelapseTimer = setTimeout(syncTimelapseFrame, wait);
  }

  function startTimelapsePlayback(manifest) {
    const frames = Array.isArray(manifest?.frames) ? manifest.frames.filter((f) => typeof f === 'string') : [];
    const deadline = Number(manifest?.deadline);
    if (frames.length < 2 || !Number.isFinite(deadline)) {
      stopTimelapse();
      return;
    }
    timelapseFrames = frames;
    timelapseDuration = Number(manifest?.durationMs) > 0 ? Number(manifest.durationMs) : TIMELAPSE_FALLBACK_MS;
    timelapseDeadline = deadline;
    timelapseActive = true;
    timelapseIndex = -1;
    clearTimelapseTimers();
    syncTimelapseFrame();
    updateCountdownDisplay();
    countdownTimer = setInterval(updateCountdownDisplay, 1000);
    updateUI();
    updateResetOverlay();
  }

  function stopTimelapse(restoreQueue = true) {
    if (!timelapseActive) return;
    timelapseActive = false;
    timelapseFrames = [];
    timelapseDeadline = 0;
    timelapseDuration = TIMELAPSE_FALLBACK_MS;
    timelapseIndex = 0;
    clearTimelapseTimers();
    if (restoreQueue) setQueueDepth(latestQueueTotal);
    updateUI();
    updateResetOverlay();
    if (!resetPending) setStatus('');
  }

  let scale = 1;
  let tx = 0, ty = 0;
  const maxScale = 3;
  const pointers = new Map();
  let lastSingle = null;
  let initDist = 0, initScale = 1, initTx = 0, initTy = 0;
  let initMid = { x: 0, y: 0 };

  function applyTransform() {
    if (roomWrap && img) {
      roomWrap.style.transform = 'translate3d(' + tx + 'px, ' + ty + 'px, 0)';
      img.style.transform = 'scale(' + scale + ')';
    }
  }
  function clampPan() {
    if (!canvasEl) return;
    const rect = canvasEl.getBoundingClientRect();
    const maxX = (rect.width * (scale - 1)) / 2;
    const maxY = (rect.height * (scale - 1)) / 2;
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y) || 1; }
  function resetView() { scale = 1; tx = 0; ty = 0; applyTransform(); }

  if (canvasEl) {
    canvasEl.addEventListener('pointerdown', (e) => {
      canvasEl.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        lastSingle = { x: e.clientX, y: e.clientY };
      } else if (pointers.size === 2) {
        const [p1, p2] = Array.from(pointers.values());
        initDist = distance(p1, p2);
        initScale = scale;
        initTx = tx; initTy = ty;
        initMid = midpoint(p1, p2);
      }
    });

    canvasEl.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = Array.from(pointers.values());
        const dist = distance(a, b);
        const mid = midpoint(a, b);
        scale = Math.max(1, Math.min(maxScale, initScale * (dist / initDist)));
        tx = initTx + (mid.x - initMid.x);
        ty = initTy + (mid.y - initMid.y);
        clampPan();
        applyTransform();
      } else if (pointers.size === 1 && lastSingle) {
        const p = Array.from(pointers.values())[0];
        tx += p.x - lastSingle.x;
        ty += p.y - lastSingle.y;
        lastSingle = p;
        clampPan();
        applyTransform();
      }
    });

    ['pointerup','pointercancel','pointerleave'].forEach((type) => {
      canvasEl.addEventListener(type, (e) => {
        pointers.delete(e.pointerId);
        if (pointers.size === 1) {
          lastSingle = Array.from(pointers.values())[0];
        } else {
          lastSingle = null;
        }
      });
    });
  }

  const loc = window.location;
  const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(proto + '://' + loc.host + BASE_PATH + '/stream');
  ws.addEventListener('open', () => {
    wsReady = true;
    setReactionEnabled(hasConsent);
  });
  const handleSocketClosed = () => {
    if (!wsReady) return;
    wsReady = false;
    setReactionEnabled(false);
  };
  ws.addEventListener('close', handleSocketClosed);
  ws.addEventListener('error', handleSocketClosed);
  ws.addEventListener('message', (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'presence') {
        presenceCount = Math.max(0, Math.floor(Number(msg.count) || 0));
        updatePresenceIndicator();
        return;
      }
      if (msg.type === 'reaction_emit' && typeof msg.emoji === 'string') {
        spawnReactionBurst(msg.emoji, msg.burst, msg.intensity);
        return;
      }
      if (msg.type === 'reaction_blocked') {
        showReactionBlocked();
        return;
      }
      if (msg.type === 'queue_stats') {
        const waiting = (typeof msg.length === 'number') ? msg.length : 0;
        const total = waiting + (msg.processing ? 1 : 0);
        setQueueDepth(total);
        return;
      }
      if (msg.type === 'timelapse_start') {
        currentOpId = null;
        aheadCount = null;
        startTimelapsePlayback(msg);
        return;
      }
      if (msg.type === 'timelapse_end') {
        stopTimelapse();
        return;
      }
      if (msg.type === 'image_updated') {
        if (timelapseActive) stopTimelapse(false);
        setImage(msg.imageUrl);
        if (typeof msg.baseReady === 'boolean') {
          baseReady = msg.baseReady;
          updateUI();
        }
        if (typeof msg.resetPending === 'boolean') {
          resetPending = msg.resetPending;
          updateResetOverlay();
        }
        if (typeof msg.resetInterval === 'number') {
          resetIntervalValue = sanitizeInterval(msg.resetInterval);
          if (!isDefaultRoom && intervalInput) {
            intervalInput.value = String(resetIntervalValue);
          }
        }
        if (typeof msg.promptCounter === 'number') {
          promptCount = Math.max(0, Math.floor(msg.promptCounter));
        }
        updateResetIndicator();
        if (currentOpId && msg.op_id === currentOpId) {
          setStatus('');
          currentOpId = null;
          aheadCount = null;
        } else if (aheadCount && aheadCount > 0) {
          aheadCount -= 1;
          setStatus('Queued… ' + aheadCount + ' ahead');
        } else {
          setStatus('');
        }
      } else if (msg.type === 'queue') {
        if (currentOpId && msg.op_id === currentOpId) {
          const ahead = (typeof msg.ahead === 'number') ? msg.ahead : Math.max(0, (msg.position || 1) - 1);
          aheadCount = ahead;
          setStatus('Queued… ' + ahead + ' ahead');
        }
      } else if (msg.type === 'error') {
        setStatus('Error: ' + msg.message);
      }
    } catch {}
  });

  if (!isDefaultRoom && uploadButton) {
    uploadButton.addEventListener('click', async () => {
      if (!hasConsent) {
        showWelcomeModal();
        setStatus('Review the welcome message to continue.');
        return;
      }
      if (!uploadInput || !uploadInput.files || uploadInput.files.length === 0) {
        uploadStatus.textContent = 'Choose an image first.';
        return;
      }
      const file = uploadInput.files[0];
      const maxBytes = ${ROOM_BASE_UPLOAD_LIMIT_BYTES};
      if (file.size > maxBytes) {
        uploadStatus.textContent = 'Image too large (limit 4 MB). Please choose a smaller file.';
        return;
      }
      const ext = extForFile(file);
      const contentType = file.type || mimeForExt(ext);
      const targetUrl = BASE_PATH + '/img/base/room' + ext;
      uploadButton.disabled = true;
      uploadStatus.textContent = 'Uploading…';
      try {
        const putResp = await fetch(targetUrl, {
          method: 'PUT',
          headers: {
            'x-dev-upload': 'true',
            'content-type': contentType,
          },
          body: file,
        });
        if (!putResp.ok) {
          const errText = await putResp.text().catch(() => '');
          throw new Error(errText || ('Upload failed (' + putResp.status + ')'));
        }
        const refreshResp = await fetch(BASE_PATH + '/admin/refresh-base', {
          method: 'POST',
          headers: { 'x-dev-admin': 'true' },
        });
        if (!refreshResp.ok) {
          const errJson = await refreshResp.json().catch(() => ({}));
          throw new Error(errJson?.error || ('Refresh failed (' + refreshResp.status + ')'));
        }
        uploadInput.value = '';
        uploadStatus.textContent = 'Upload complete!';
        await load();
        uploadStatus.textContent = 'Base image ready. You can start editing!';
      } catch (err) {
        uploadStatus.textContent = 'Upload failed: ' + (err?.message || err);
      } finally {
        uploadButton.disabled = false;
      }
    });
  }

  if (!isDefaultRoom && intervalButton && intervalInput) {
    intervalButton.addEventListener('click', () => {
      saveInterval();
    });
    intervalInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveInterval();
      }
    });
    intervalInput.addEventListener('input', () => {
      if (intervalStatus && intervalStatus.textContent && intervalStatus.textContent !== 'Saving…') {
        intervalStatus.textContent = '';
      }
    });
  }

  async function saveInterval() {
    if (!intervalInput || isDefaultRoom) return;
    const raw = Number(intervalInput.value);
    if (!Number.isFinite(raw)) {
      updateIntervalDisplay('Enter a value between ' + intervalMin + ' and ' + intervalMax + '.');
      return;
    }
    const desired = sanitizeInterval(raw);
    if (intervalButton) intervalButton.disabled = true;
    updateIntervalDisplay('Saving…');
    try {
      const resp = await fetch(BASE_PATH + '/config/reset-interval', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ interval: desired }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.error) {
        const message = data?.error || ('Request failed (' + resp.status + ')');
        throw new Error(message);
      }
      if (Number.isFinite(Number(data.min))) intervalMin = Math.max(1, Math.floor(Number(data.min)));
      if (Number.isFinite(Number(data.max))) intervalMax = Math.max(intervalMin, Math.floor(Number(data.max)));
      const effective = Number(data.resetInterval);
      resetIntervalValue = sanitizeInterval(Number.isFinite(effective) ? effective : desired);
      if (typeof data.resetPending === 'boolean') {
        resetPending = Boolean(data.resetPending);
        updateResetOverlay();
      }
      intervalInput.min = String(intervalMin);
      intervalInput.max = String(intervalMax);
      intervalInput.value = String(resetIntervalValue);
      updateIntervalDisplay('Saved! Auto reset after ' + pluralizePrompts(resetIntervalValue) + '.');
      updateResetIndicator();
    } catch (err) {
      updateIntervalDisplay('Save failed: ' + (err?.message || err));
    } finally {
      if (intervalButton) intervalButton.disabled = false;
    }
  }

  function extForFile(file) {
    const type = (file.type || '').toLowerCase();
    if (type.includes('png')) return '.png';
    if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
    if (type.includes('webp')) return '.webp';
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.png')) return '.png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return '.jpg';
    if (name.endsWith('.webp')) return '.webp';
    return '.png';
  }

  function mimeForExt(ext) {
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    return 'application/octet-stream';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!hasConsent) {
      showWelcomeModal();
      setStatus('Review the welcome message to continue.');
      return;
    }
    if (resetPending) {
      await performManualReset();
      return;
    }
    const prompt = promptEl.value.trim();
    if (!prompt) return;
     if (!isDefaultRoom && !baseReady) {
      setStatus('Upload a base image first.');
      return;
    }
    setStatus('Submitting…');
    try {
      const opId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
      currentOpId = opId;
      aheadCount = null;
      await fetch(BASE_PATH + '/ops', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, op_id: opId })});
      promptEl.value='';
    } catch (e) {
      setStatus('Error submitting');
    }
  });

  updateUI();
  load();

  async function performManualReset() {
    if (!hasConsent || !resetPending || !baseReady) return;
    setStatus('Resetting…');
    try {
      if (submitButton) submitButton.disabled = true;
      const resp = await fetch(BASE_PATH + '/reset', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data?.error) {
        throw new Error(data?.error || 'Reset failed (' + resp.status + ')');
      }
      resetPending = Boolean(data.resetPending);
      updateResetOverlay();
      updateUI();
      setStatus('Room reset. Add something new!');
      await load();
    } catch (err) {
      setStatus('Reset failed: ' + (err?.message || err));
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  }
  </script>
</body>
</html>`;
}
