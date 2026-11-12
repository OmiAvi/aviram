# aviram.app — Depth Reel

Omer Aviram's video portfolio. Every clip is depth-scanned live in the browser
(WebGL point cloud, brightness = depth), then plays as real footage.

Cloudflare Worker + static assets + R2. No build step.

```
public/index.html          the reel (built-in content is only a fallback)
public/admin/index.html    /admin — edit clips, apps, profile; upload videos
public/site.default.json   starting content, used until the first save in /admin
public/videos/*.mp4        clips bundled with the first version (moved to R2 from /admin)
public/depth/              real depth maps per clip (Depth Anything V2) + manifest.json
scripts/depth.py           builds depth maps for new clips
src/worker.js              API: login, content, uploads to R2, video streaming with Range
wrangler.jsonc             Cloudflare config (R2 bucket, D1 stats db, aviram.app routes)
```

## Editing the site

Go to **https://aviram.app/admin** and log in.

- **Clips** — drop video files to add clips, drag ⠿ to reorder, open a clip to edit
  its title, client, year, role, description, or replace its video. Uploads save
  right away; other edits wait for **Save** (or Cmd+S).
- **Apps** — the "Also builds" cards.
- **Profile** — name, intro lines, about text, email and links.
- **Inbox** — messages from the contact form (unread count on the tab).
- **Stats** — visits, how long people stay (only while the page is on screen),
  how many get past the intro, time spent per clip, plays, devices, referrers.
  Your own visits while logged in aren't counted; no IP addresses are stored.
- **Library** — every video in R2, what uses it, and delete for unused files.

Every save also keeps a copy in R2 under `content/history/`, so any earlier version
can be restored from the Cloudflare dashboard (copy it over `content/site.json`).

For the web, export clips at 720p–1080p and ideally under ~40 MB: viewers stream
the whole file.

## Real 3D (depth maps)

The dots get their depth from a small grayscale video per clip, made by an AI depth
model (Depth Anything V2) and kept frame-locked with the clip. Clips without one fall
back to brightness-as-depth until it's built.

After uploading a new clip in /admin, build its depth map:

```bash
pip install -r scripts/requirements.txt
python scripts/depth.py          # reads the live site, writes public/depth/
git add public/depth && git commit -m "Depth maps" && git push
```

Or have GitHub do it automatically every 6 hours: add
`scripts/depth-workflow.yml` to the repo as `.github/workflows/depth.yml`
(on github.com: Add file → Create new file, paste it in).

## Sharing

- Link previews (LinkedIn, iMessage, X…) use `public/og.jpg` plus the meta tags in `index.html`.
- Every clip has its own link, e.g. `aviram.app/#the-holy-war` (title in lowercase, dashes
  for spaces). The address bar follows as you scroll, and each clip has a **Share** button.

## How it's wired

- `GET /api/site` returns `content/site.json` from R2 (or `site.default.json`).
- The admin password is the Worker secret `ADMIN_PASSWORD`. Logins last 14 days
  (HMAC-signed, HttpOnly cookie). Change the password to log everyone out.
- Uploads go to R2 in 10 MB parts through the Worker (`/api/uploads/*`).
- Videos are served from `/media/<file>` with proper Range responses, which
  iPhone Safari requires.

## Deploy

Pushing to `main` deploys automatically once the repo is connected in Cloudflare
(Workers & Pages → the `aviram` Worker → Settings → Builds).

One-time setup, if starting from scratch:

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create aviram-media
npx wrangler d1 create aviram-db   # put its id in wrangler.jsonc; the table creates itself
npx wrangler secret put ADMIN_PASSWORD
npm run deploy
```

## Run locally

```bash
echo 'ADMIN_PASSWORD=localtest' > .dev.vars
npm run dev        # http://localhost:8787 and /admin (R2 is simulated locally)
```
