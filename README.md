# vimeo-mcp

Internal MCP backend for Vimeo operations (upload, embed retrieval, delete). Consumed by `leadmatch-mcp-app`.

## Tools

| Tool | Purpose |
|---|---|
| `vimeo-verify-token` | Sanity-check the alumno's personal access token |
| `vimeo-upload-video` | Upload a local video file, return `videoId` + `embed_url` + iframe HTML |
| `vimeo-get-video-info` | Status (transcoding/available) + embed URL |
| `vimeo-delete-video` | Delete a video (irreversible) |

## Auth model

Each call includes `access_token` (the alumno's personal access token from `developer.vimeo.com/apps`). The proxy in leadmatch-mcp stores alumno tokens per student and forwards them here. This MCP is stateless for Vimeo — it just relays API calls.

## Env vars

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | default 3004 |
| `INTERNAL_API_SECRET` | yes in prod | Shared secret with leadmatch-mcp-app |

## How the alumno gets a token

1. Go to https://developer.vimeo.com/apps/new
2. Create an app ("LeadMatch Course")
3. Generate a personal access token with scopes: `public upload edit delete`
4. Copy the token, save it in the alumno's Notion row or pass it when calling tools

## Deploy

```bash
docker build -t vimeo-mcp .
# or push to GitHub and let Railway auto-deploy from Dockerfile
```

Same pattern as `systemeio-mcp` — thin wrapper over an external API, gated by `INTERNAL_API_SECRET` at the `/mcp` route.
