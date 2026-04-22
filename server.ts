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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import express from "express";
import cors from "cors";

import {
  createVideoUpload,
  getVideoInfo,
  deleteVideo,
  verifyToken,
  setVideoAppearance,
  buildUploadCurlCommand,
  getUploadStatus,
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
    "vimeo-create-upload-ticket",
    "Paso 1 del upload: crea la entrada del vídeo en Vimeo y devuelve un `upload_link` TUS + comando `curl` listo para que Cowork ejecute en la máquina del alumno (los bytes van directos alumno → Vimeo, sin pasar por este MCP). Tras ejecutar el curl, llamar a `vimeo-verify-upload-complete` para confirmar recepción.",
    {
      access_token: z.string(),
      size_bytes: z.number().describe("Tamaño del archivo en bytes (Cowork lo saca con Bash stat)"),
      file_path: z.string().describe("Ruta absoluta en la máquina del alumno (se usa SOLO para construir el comando curl — el archivo no sale de su disco)"),
      name: z.string().optional(),
      description: z.string().optional(),
      privacy: z.enum(["anybody", "nobody", "unlisted"]).optional().describe("anybody=público (default del curso), unlisted=link directo, nobody=solo dueño"),
    },
    async (input) => {
      try {
        const ticket = await createVideoUpload(input.access_token, {
          size: input.size_bytes,
          name: input.name,
          description: input.description,
          privacy: input.privacy ?? "anybody",
        });
        const curl = buildUploadCurlCommand(ticket.upload_link, input.file_path);
        return ok({
          video_id: ticket.video_id,
          video_uri: ticket.video_uri,
          upload_link: ticket.upload_link,
          quota_remaining_bytes: ticket.approx_byte_quota_remaining,
          next_step_bash_command: curl,
          next_step_explanation:
            "Cowork debe ejecutar el comando `next_step_bash_command` con Bash en la máquina del alumno. Sube los bytes directamente a Vimeo (TUS PATCH). Tras éxito del curl, llamar a `vimeo-verify-upload-complete` con `video_id`.",
        });
      } catch (e) { return err(e); }
    },
  );

  server.tool(
    "vimeo-verify-upload-complete",
    "Paso 2 del upload: verifica que Vimeo ha recibido los bytes tras el PATCH. Devuelve upload_status + transcode_status. Si upload_status='complete' y transcode_status='available' → listo. Si 'in_progress' → esperar y re-llamar (Vimeo transcodifica en 2-10 min según tamaño).",
    {
      access_token: z.string(),
      video_id: z.string(),
    },
    async (input) => {
      try {
        const status = await getUploadStatus(input.access_token, input.video_id);
        const info = await getVideoInfo(input.access_token, input.video_id).catch(() => null);
        return ok({
          video_id: input.video_id,
          upload_status: status.upload_status,
          transcode_status: status.transcode_status,
          available: status.available,
          player_embed_url: info?.player_embed_url ?? `https://player.vimeo.com/video/${input.video_id}`,
          embed_html: info?.embed_html ?? "",
          public_link: info?.link,
          note:
            status.upload_status === "complete" && status.available
              ? "Vídeo disponible y transcodificado. Se puede embeber."
              : status.upload_status === "complete"
              ? "Bytes recibidos por Vimeo. Aún transcodificando — el embed funcionará en 2-10 min."
              : status.upload_status === "in_progress"
              ? "Subida en progreso. Vuelve a llamar cuando el curl termine."
              : `Estado inesperado: ${status.upload_status}. Revisa el curl.`,
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[vimeo-mcp] listening on 0.0.0.0:${PORT} (NODE_ENV=${process.env.NODE_ENV ?? "dev"}, secret_set=${!!INTERNAL_API_SECRET})`);
});
