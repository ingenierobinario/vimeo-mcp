/**
 * Vimeo API client (REST v2, TUS upload protocol).
 * Docs: https://developer.vimeo.com/api/reference
 *
 * Auth model: one access token per alumno. The alumno generates a personal
 * access token via Vimeo developer app (scopes: upload, edit, public).
 * The token is passed per-call via `access_token` arg from the proxy.
 *
 * We don't manage OAuth flows here — the proxy passes tokens we receive
 * from the alumno's account config stored in leadmatch-mcp-app env or
 * Notion student row.
 */

const VIMEO_API = "https://api.vimeo.com";
const VIMEO_UA = "vimeo-mcp/0.1 (LeadMatch internal)";

interface VimeoError {
  error?: string;
  developer_message?: string;
  error_code?: number;
}

async function vimeoFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const res = await fetch(`${VIMEO_API}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": VIMEO_UA,
      "Accept": "application/vnd.vimeo.*+json;version=3.4",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    let err: VimeoError = {};
    try { err = await res.json(); } catch { /* ignore */ }
    throw new Error(
      `Vimeo API ${res.status}: ${err.error ?? err.developer_message ?? res.statusText}`,
    );
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface CreateUploadResult {
  video_uri: string;            // /videos/123456
  upload_link: string;          // tus endpoint
  video_id: string;             // "123456"
  approx_byte_quota_remaining: number;
}

/**
 * Paso 1 de la subida TUS: pedir a Vimeo un ticket de upload con el tamaño
 * del fichero. Devuelve el upload_link al que haremos PATCH con el fichero.
 */
export async function createVideoUpload(
  accessToken: string,
  args: { size: number; name?: string; description?: string; privacy?: "anybody" | "nobody" | "unlisted" },
): Promise<CreateUploadResult> {
  const body: Record<string, unknown> = {
    upload: { approach: "tus", size: args.size },
  };
  if (args.name) body.name = args.name;
  if (args.description) body.description = args.description;
  if (args.privacy) body.privacy = { view: args.privacy };

  const data = await vimeoFetch(accessToken, "/me/videos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const videoId = String(data.uri ?? "").split("/").pop() ?? "";
  return {
    video_uri: data.uri,
    upload_link: data.upload?.upload_link,
    video_id: videoId,
    approx_byte_quota_remaining: data.user?.upload_quota?.space?.free ?? 0,
  };
}

/**
 * Paso 2 TUS: subir los bytes del fichero con PATCH al upload_link.
 * TUS spec permite chunking pero si el fichero es pequeño (<100MB)
 * mandamos todo de una. Vimeo acepta PATCH con header Upload-Offset.
 */
export async function uploadVideoBytes(
  uploadLink: string,
  fileBuffer: Buffer,
  onProgress?: (bytesSent: number) => void,
): Promise<void> {
  const size = fileBuffer.length;
  let offset = 0;
  const CHUNK = 64 * 1024 * 1024; // 64MB chunks

  while (offset < size) {
    const end = Math.min(offset + CHUNK, size);
    const chunk = fileBuffer.subarray(offset, end);
    const res = await fetch(uploadLink, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/offset+octet-stream",
        "Upload-Offset": String(offset),
        "Tus-Resumable": "1.0.0",
      },
      body: new Uint8Array(chunk),
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`TUS upload failed at offset ${offset}: ${res.status} ${res.statusText}`);
    }
    offset = end;
    onProgress?.(offset);
  }
}

export interface VideoInfo {
  id: string;
  name: string;
  description: string | null;
  duration: number;
  link: string;            // https://vimeo.com/123456
  player_embed_url: string; // https://player.vimeo.com/video/123456
  embed_html: string;      // <iframe ...>
  status: "available" | "transcoding" | "uploading" | "error";
  privacy: string;
  created_time: string;
}

export async function getVideoInfo(accessToken: string, videoId: string): Promise<VideoInfo> {
  const data = await vimeoFetch(accessToken, `/videos/${videoId}`);
  return {
    id: String(videoId),
    name: data.name,
    description: data.description,
    duration: data.duration,
    link: data.link,
    player_embed_url: `https://player.vimeo.com/video/${videoId}`,
    embed_html: data.embed?.html ?? "",
    status: data.status,
    privacy: data.privacy?.view ?? "anybody",
    created_time: data.created_time ?? "",
  };
}

export async function deleteVideo(accessToken: string, videoId: string): Promise<void> {
  await vimeoFetch(accessToken, `/videos/${videoId}`, { method: "DELETE" });
}

export async function verifyToken(accessToken: string): Promise<{ name: string; account: string }> {
  const data = await vimeoFetch(accessToken, "/me");
  return { name: data.name, account: data.account };
}
