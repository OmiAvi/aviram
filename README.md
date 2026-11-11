# Depth Reel

Omer Aviram's video portfolio. Every clip is depth-scanned live in the browser
(WebGL point cloud, brightness = depth), then plays as real footage.

Static site served by Cloudflare Workers (static assets). No build step.

```
public/
  index.html      the whole site — edit the CONFIG block at the top of the <script>
  videos/*.mp4    the clips (720p, under 25 MB each)
  404.html
  _headers        caching for videos
wrangler.jsonc    Cloudflare config
```

## Run locally

```bash
npm install
npm run dev        # http://localhost:8787
```

## Deploy

Auto-deploy (set up once): Cloudflare dashboard → Workers & Pages → Create →
Import a repository → pick this repo. Build command: none. Deploy command:
`npx wrangler deploy`. Every push to `main` then goes live.

Manual: `npx wrangler login` once, then `npm run deploy`.

## Add a video

1. Compress it to fit under 25 MB:
   ```bash
   ffmpeg -i in.mp4 -vf "scale=-2:720" -c:v libx264 -preset slow -crf 23 \
     -maxrate 2M -bufsize 4M -c:a aac -b:a 128k -movflags +faststart public/videos/name.mp4
   ```
   (For vertical video use `scale=720:-2`. Longer than ~75 s? lower `-maxrate`.)
2. Add an entry to `CONFIG.projects` in `public/index.html`.
3. Commit and push.
