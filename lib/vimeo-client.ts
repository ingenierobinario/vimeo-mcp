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

// ─────────────────────────────────────────────────────────────────
// Player appearance (embed settings)
// ─────────────────────────────────────────────────────────────────

export interface VideoAppearance {
  /** Color de acento del reproductor en hex, ej "#00adef" */
  color?: string;
  /** Color de fondo del player (si aplica al nivel de plan) */
  background_color?: string;
  /** "light" o "dark" — esquema general del player */
  color_style?: "light" | "dark";
  /** Ocultar título del vídeo */
  hide_title?: boolean;
  /** Ocultar nombre del autor (byline) */
  hide_byline?: boolean;
  /** Ocultar avatar del autor */
  hide_portrait?: boolean;
  /** Ocultar logo de Vimeo en el player */
  hide_vimeo_logo?: boolean;
  /** Logo custom: url directa a imagen PNG del logo + link al clicarlo */
  custom_logo_url?: string;
  custom_logo_link?: string;
  /** Botones individuales: mostrar/ocultar */
  show_fullscreen?: boolean;
  show_share?: boolean;
  show_embed?: boolean;
  show_like?: boolean;
  show_watchlater?: boolean;
  /** Controles del player */
  show_playbar?: boolean;
  show_volume?: boolean;
  show_speed?: boolean;
  show_cc?: boolean;
}

function buildEmbedPayload(appearance: VideoAppearance): Record<string, unknown> {
  const embed: Record<string, unknown> = {};
  if (appearance.color) embed.color = appearance.color.replace(/^#/, "");
  if (appearance.background_color) embed.background_color = appearance.background_color.replace(/^#/, "");
  if (appearance.color_style) embed.color_style = appearance.color_style;

  const title: Record<string, string> = {};
  if (appearance.hide_title !== undefined) title.name = appearance.hide_title ? "hide" : "show";
  if (appearance.hide_byline !== undefined) title.owner = appearance.hide_byline ? "hide" : "show";
  if (appearance.hide_portrait !== undefined) title.portrait = appearance.hide_portrait ? "hide" : "show";
  if (Object.keys(title).length > 0) embed.title = title;

  const logos: Record<string, unknown> = {};
  if (appearance.hide_vimeo_logo !== undefined) logos.vimeo = !appearance.hide_vimeo_logo;
  if (appearance.custom_logo_url) {
    logos.custom = {
      active: true,
      url: appearance.custom_logo_url,
      link: appearance.custom_logo_link ?? undefined,
    };
  }
  if (Object.keys(logos).length > 0) embed.logos = logos;

  const buttons: Record<string, boolean> = {};
  if (appearance.show_fullscreen !== undefined) buttons.fullscreen = appearance.show_fullscreen;
  if (appearance.show_share !== undefined) buttons.share = appearance.show_share;
  if (appearance.show_embed !== undefined) buttons.embed = appearance.show_embed;
  if (appearance.show_like !== undefined) buttons.like = appearance.show_like;
  if (appearance.show_watchlater !== undefined) buttons.watchlater = appearance.show_watchlater;
  if (Object.keys(buttons).length > 0) embed.buttons = buttons;

  if (appearance.show_playbar !== undefined) embed.playbar = appearance.show_playbar;
  if (appearance.show_volume !== undefined) embed.volume = appearance.show_volume;
  if (appearance.show_speed !== undefined) embed.speed = appearance.show_speed;
  if (appearance.show_cc !== undefined) embed.cc = appearance.show_cc;

  return embed;
}

export async function setVideoAppearance(
  accessToken: string,
  videoId: string,
  appearance: VideoAppearance,
): Promise<{ video_id: string; applied: VideoAppearance; updated_at: string }> {
  const embed = buildEmbedPayload(appearance);
  if (Object.keys(embed).length === 0) {
    throw new Error("No appearance fields provided — nothing to update");
  }
  const data = await vimeoFetch(accessToken, `/videos/${videoId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embed }),
  });
  return { video_id: videoId, applied: appearance, updated_at: data.modified_time ?? "" };
}

