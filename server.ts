/**
 * vimeo-mcp — Servidor MCP para subir y gestionar vídeos en Vimeo.
 *
 * Consumido exclusivamente por leadmatch-mcp-app (proxy).
 * Auth: header X-Internal-Secret. Cada call incluye el access_token del alumno
 * (generado por él en developer.vimeo.com/apps, scopes: upload edit public).
 *
 * Tools:
 *   - vimeo-verify-token       → sanity check del access_token
 *   - vimeo-upload-video       → sube un vídeo desde una ruta local, devuelve videoId + embed URL
 *   - vimeo-get-video-info     → status + embed URL + metadata
 *   - vimeo-delete-video       → borra un vídeo (careful)
 */

import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import cors from "cors";

import {
  createVideoUpload,
  uploadVideoBytes,
  getVideoInfo,
  deleteVideo,
  verifyToken,
  setVideoAppearance,
  setVideoAllowedDomains,
  clearVideoAllowedDomains,
} from "./lib/vimeo-client.js";

process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

const PORT = Number(process.env.PORT ?? 3004);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET ?? "";

if (!INTERNAL_API_SECRET && process.env.NODE_ENV === "production") {
  console.error("[FATAL] INTERNAL_API_SECRET not set in production");
  process.exit(1);
}

function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: "vimeo-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const ok = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });
  const err = (e: unknown) => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({ error: true, message: (e as Error)?.message ?? String(e) }),
    }],
  });

  server.tool(
    "vimeo-verify-token",
    "Sanity check del access_token. Devuelve el nombre de la cuenta Vimeo para confirmar que el token es válido antes de intentar un upload pesado.",
    { access_token: z.string() },
    async (input) => {
      try { return ok(await verifyToken(input.access_token)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "vimeo-upload-video",
    "Sube un vídeo desde el filesystem local al Vimeo del alumno y devuelve videoId + embed URL + iframe HTML. Usa TUS (resumable chunks 64MB).",
    {
      access_token: z.string(),
      file_path: z.string().describe("Ruta absoluta al archivo de vídeo local"),
      name: z.string().optional(),
      description: z.string().optional(),
      privacy: z.enum(["anybody", "nobody", "unlisted"]).optional().describe("anybody=público, nobody=solo el dueño, unlisted=link directo (por defecto el curso quiere unlisted para embeds privados)"),
    },
    async (input) => {
      try {
        const st = await stat(input.file_path);
        if (!st.isFile()) throw new Error(`No es un archivo: ${input.file_path}`);
        const buf = await readFile(input.file_path);
        const upload = await createVideoUpload(input.access_token, {
          size: st.size,
          name: input.name,
          description: input.description,
          privacy: input.privacy ?? "unlisted",
        });
        await uploadVideoBytes(upload.upload_link, buf);
        // Espera breve para que Vimeo empiece a transcodificar
        const info = await getVideoInfo(input.access_token, upload.video_id);
        return ok({
          video_id: upload.video_id,
          video_uri: upload.video_uri,
          public_link: info.link,
          player_embed_url: info.player_embed_url,
          embed_html: info.embed_html,
          status: info.status,
          note: info.status === "transcoding"
            ? "Vimeo está transcodificando. El embed ya funciona pero la calidad final tarda 2-10min."
            : "Vídeo listo.",
        });
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "vimeo-get-video-info",
    "Devuelve el status, embed URL y metadata de un vídeo por su videoId. Útil para esperar a que acabe de transcodificar o regenerar el embed.",
    { access_token: z.string(), video_id: z.string() },
    async (input) => {
      try { return ok(await getVideoInfo(input.access_token, input.video_id)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "vimeo-delete-video",
    "Borra un vídeo del Vimeo del alumno. Irreversible.",
    { access_token: z.string(), video_id: z.string() },
    async (input) => {
      try {
        await deleteVideo(input.access_token, input.video_id);
        return ok({ deleted: true, video_id: input.video_id });
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "vimeo-set-video-appearance",
    "Configura la apariencia del reproductor embebido: color de acento (hex del brandbook), ocultar título/byline/avatar/logo Vimeo, añadir logo custom, ocultar botones de share/embed/like, ocultar playbar/speed/volume. Todos los campos son opcionales — solo aplica los que pases.",
    {
      access_token: z.string(),
      video_id: z.string(),
      color: z.string().optional().describe("Color de acento hex, ej '#00adef'"),
      background_color: z.string().optional(),
      color_style: z.enum(["light", "dark"]).optional(),
      hide_title: z.boolean().optional(),
      hide_byline: z.boolean().optional(),
      hide_portrait: z.boolean().optional(),
      hide_vimeo_logo: z.boolean().optional().describe("Ocultar el logo de Vimeo en la esquina"),
      custom_logo_url: z.string().optional().describe("URL pública del logo propio del alumno (PNG)"),
      custom_logo_link: z.string().optional().describe("URL a la que lleva el clic en el logo"),
      show_fullscreen: z.boolean().optional(),
      show_share: z.boolean().optional(),
      show_embed: z.boolean().optional(),
      show_like: z.boolean().optional(),
      show_watchlater: z.boolean().optional(),
      show_playbar: z.boolean().optional(),
      show_volume: z.boolean().optional(),
      show_speed: z.boolean().optional(),
      show_cc: z.boolean().optional(),
    },
    async (input) => {
      try {
        const { access_token, video_id, ...appearance } = input;
        return ok(await setVideoAppearance(access_token, video_id, appearance));
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "vimeo-set-video-allowed-domains",
    "Restringe el embed del vídeo a una lista concreta de dominios (whitelist). REQUIERE plan Vimeo Pro o superior. Si el alumno está en Basic, devuelve error con mensaje claro. Uso: los 3 dominios del curso (ej: systeme.io, training.ingenierobinario.com, dominio propio del alumno).",
    {
      access_token: z.string(),
      video_id: z.string(),
      domains: z.array(z.string()).describe("Lista de dominios sin http:// y sin path, ej ['systeme.io', 'tunegocio.com']"),
    },
    async (input) => {
      try { return ok(await setVideoAllowedDomains(input.access_token, input.video_id, input.domains)); }
      catch (e) { return err(e); }
    },
  );

  server.tool(
    "vimeo-clear-video-allowed-domains",
    "Borra la lista de dominios permitidos del vídeo (quita la whitelist). Uso: reset antes de reconfigurar.",
    { access_token: z.string(), video_id: z.string() },
    async (input) => {
      try { return ok(await clearVideoAllowedDomains(input.access_token, input.video_id)); }
      catch (e) { return err(e); }
    },
  );

  return server;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

app.use("/mcp", (req, res, next) => {
  if (!INTERNAL_API_SECRET) return next();
  const secret = req.header("X-Internal-Secret") ?? "";
  if (secret !== INTERNAL_API_SECRET) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
});

const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

app.post("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body);
    return;
  }
  if (!sessionId && isInitializeRequest(req.body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, { transport, server: srv }); },
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    const srv = buildMcpServer();
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }
  res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request" } });
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  if (!sessionId || !sessions.has(sessionId)) { res.status(400).json({ error: "invalid session" }); return; }
  await sessions.get(sessionId)!.transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  if (sessionId && sessions.has(sessionId)) {
    await sessions.get(sessionId)!.transport.handleRequest(req, res);
    sessions.delete(sessionId);
  } else res.status(204).end();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "vimeo-mcp", version: "0.1.0" });
});

app.listen(PORT, () => {
  console.log(`[vimeo-mcp] listening on :${PORT}`);
});
