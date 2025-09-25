# Chaotic Shared Room

A Cloudflare Worker + Durable Object experience where everyone edits the same room image with natural-language prompts powered by FLUX.1 Kontext [dev]. Prompts queue up, the worker generates a new frame, and the canvas updates in real time for every viewer. After ten edits the room rewinds through a timelapse and resets to its base scene.

## Highlights
- **One living room for everyone:** Sequential prompt queue keeps edits ordered and streams updates over WebSockets.
- **Timelapse resets:** After ten prompts the worker assembles recent frames into a countdown loop before restoring the base image.
- **Custom rooms:** Visit `/your-room` to upload a custom base image and set your own reset cadence.
- **Social touches:** Presence counts, emoji reactions, and queue indicators keep the chaos fun instead of confusing.

## Getting Started

### Prerequisites
- Node.js 18+
- Wrangler 4.39+
- A Cloudflare account with access to Workers, Durable Objects, and R2
- fal.ai API key with access to `fal-ai/flux-kontext/dev`

### Install dependencies
```bash
npm install
```

### Local development
```bash
# Start the Worker locally with persistent Durable Object state
npm run dev
```
Open http://localhost:8787 to join the default room. Upload a base at `/your-room` via the inline UI before prompting.

### Running tests
```bash
npm test
```
Vitest uses `@cloudflare/vitest-pool-workers` to spin up Durable Object isolates and mocks fal.ai responses. Make sure any local `.wrangler/state` artifacts are removed before running in CI.

### Deploying
```bash
npm run deploy
```
The deploy command wraps `wrangler deploy`. Ensure `wrangler.toml` matches your Cloudflare bindings and that production R2 buckets contain the base scene.

## Project Structure
```
├── src/worker.ts          # Worker + Durable Object implementation
├── test/room.test.ts      # Vitest suite covering queue and reset behavior
├── scripts/               # Prompt debug helpers and API smoke tests
├── docs/                  # Product notes, hackathon brief, prompt guides
├── DEVPOST-ABOUT.md       # Draft copy for Devpost submission
├── DEVPOST-BUILT-WITH.md  # Tech stack summary for Devpost
└── README.md              # You are here
```

## Additional Docs
- Detailed product notes and hackathon background live in [`docs/`](docs/).
- Prompting tips for FLUX.1 Kontext [dev] are in [`docs/FLUX-PROMPTGUIDE.md`](docs/FLUX-PROMPTGUIDE.md).
- Submission narratives are drafted in [`DEVPOST-ABOUT.md`](DEVPOST-ABOUT.md) and [`DEVPOST-BUILT-WITH.md`](DEVPOST-BUILT-WITH.md).

## Cleanup Checklist
- The `.wrangler/` directory, SQLite artifacts, and demo images are ignored via `.gitignore`.
- Admin test endpoints remain available for local debugging but are not required for production traffic.

## License
MIT
