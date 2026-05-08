# MTB Share

A deployable liquid-glass social app for mountain bike riders. It includes a Node backend, cookie sessions, persistent posts, reactions, comments, ride requests, clubs, and an iOS-friendly PWA frontend.

## Run locally

```bash
npm start
```

Open `http://127.0.0.1:4173/`.

## Deploy

Deploy the whole folder to any Node host such as Render, Railway, Fly.io, DigitalOcean App Platform, or a VPS.

Use:

```bash
npm start
```

Set the public port with the host's `PORT` environment variable. In production, set:

```bash
NODE_ENV=production
```

The app stores data in `data/db.json` and uploaded photos/videos in `uploads/`. For a small community or private beta this is deployable as-is. For larger public use, move the same API shape to Postgres plus object storage such as S3, R2, or Spaces.

Uploads default to a 60 MB request limit. You can change it with:

```bash
MAX_UPLOAD_MB=120 npm start
```
