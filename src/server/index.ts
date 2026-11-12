import { createServer, type ServerResponse } from "node:http";
import { readFile, mkdir, realpath } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Session } from "./session.js";
import { Library, localLibrary, atomicJSON, safeMedia } from "./library.js";
import { MusicCache } from "./remote-zip.js";
import { terminal } from "./tui.js";
import { body, json, serveFile } from "./http.js";
import { defaults, validateSettings, type Track } from "../shared.js";

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const { values } = parseArgs({
    options: {
      "music-dir": { type: "string" },
      "data-dir": { type: "string" },
      port: { type: "string", default: "4173" },
      dev: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Still: pnpm start [--music-dir /path/to/music] [--port 4173]\nDevelopment: pnpm dev",
    );
    process.exit(0);
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw Error("Choose a port from 1024 to 65535.");
  const origin = `http://127.0.0.1:${port}`;
  const dataDir = values["data-dir"]
    ? resolve(values["data-dir"])
    : join(root, ".still");
  await mkdir(dataDir, { recursive: true });
  const settingsFile = join(dataDir, "settings.json");
  let settings = defaults;
  try {
    settings = validateSettings(
      JSON.parse(await readFile(settingsFile, "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw Error(
        `Cannot load .still/settings.json: ${(error as Error).message}. Fix or move the file before starting.`,
      );
  }
  const session = new Session(settings);
  const musicRoot = values["music-dir"]
    ? await realpath(resolve(values["music-dir"]))
    : null;
  const library = new Library(dataDir, musicRoot || undefined);
  library.set("local", await localLibrary(musicRoot || undefined));
  const cache = new MusicCache(join(dataDir, "audio"));
  const clients = new Map<ServerResponse, string>();
  let playerSeen = 0;
  let tui = { render() {}, close() {} };
  function broadcast() {
    const frame = `data: ${JSON.stringify(session.snapshot())}\n\n`;
    for (const client of clients.keys()) {
      if (client.writableLength > 1_000_000) {
        client.destroy();
        clients.delete(client);
      } else client.write(frame);
    }
    tui.render();
  }
  let serial = Promise.resolve();
  function command(data: Record<string, unknown>) {
    const task = serial.then(async () => {
      switch (data.type) {
        case "timer":
          session.timer(String(data.action));
          break;
        case "music":
          session.music(String(data.action));
          break;
        case "settings": {
          if (
            !data.settings ||
            typeof data.settings !== "object" ||
            Array.isArray(data.settings)
          )
            throw Error("Invalid settings.");
          const next = validateSettings({
            ...session.settings,
            ...data.settings,
          });
          await atomicJSON(settingsFile, next);
          session.settings = next;
          break;
        }
        case "select": {
          if (
            !Array.isArray(data.ids) ||
            data.ids.length > 5000 ||
            !Number.isInteger(data.index)
          )
            throw Error("Invalid queue.");
          const tracks = data.ids.map((id) => {
            const track = library.tracks.get(id);
            if (!track) throw Error("Unknown track.");
            const { media: _, ...publicTrack } = track;
            return publicTrack;
          });
          session.select(tracks, data.index as number);
          break;
        }
        case "append": {
          const track = library.tracks.get(String(data.id));
          if (!track || session.queue.length >= 5000)
            throw Error("Cannot append track.");
          const { media: _, ...publicTrack } = track;
          session.queue.push(publicTrack);
          break;
        }
        case "claim":
          if (
            typeof data.id !== "string" ||
            !/^[\w-]{16,80}$/.test(data.id) ||
            ![...clients.values()].includes(data.id)
          )
            throw Error("Connect the overlay before starting audio.");
          if (session.player && session.player !== data.id)
            throw Error("Another player already owns audio. Close it first.");
          session.player = data.id;
          playerSeen = Date.now();
          break;
        case "pulse":
        case "advance":
        case "audioError":
          if (data.id !== session.player || !session.player)
            throw Error("Audio ownership expired. Waiting for the overlay to reconnect.");
          playerSeen = Date.now();
          if (data.type === "advance" && data.revision === session.revision)
            session.music("next");
          if (
            data.type === "audioError" &&
            data.revision === session.revision
          ) {
            session.playing = false;
            console.error(
              "Audio could not load. Try another track or reconnect the player.",
            );
          }
          break;
        default:
          throw Error("Unknown command.");
      }
      broadcast();
    });
    serial = task.catch(() => {});
    return task;
  }
  const vite = values.dev
    ? await (
        await import("vite")
      ).createServer({
        configFile: join(root, "vite.config.ts"),
        server: { middlewareMode: true },
        appType: "spa",
      })
    : null;
  if (!vite) {
    try {
      await readFile(join(root, "dist/index.html"));
    } catch {
      throw Error("Build the web interface first: pnpm build");
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) {
        json(res, { error: `Use ${origin}` }, 403);
        return;
      }
      const url = new URL(req.url || "/", origin);
      if (req.method === "POST") {
        if (
          req.headers.origin !== origin ||
          req.headers["x-still"] !== "1" ||
          req.headers["content-type"] !== "application/json"
        ) {
          json(res, { error: "Same-origin JSON commands only." }, 403);
          return;
        }
        if (url.pathname !== "/api/command") {
          json(res, { error: "Not found." }, 404);
          return;
        }
        await command(await body(req));
        json(res, session.snapshot());
        return;
      }
      if (!["GET", "HEAD"].includes(req.method || "")) {
        json(res, { error: "Method not allowed." }, 405);
        return;
      }
      if (url.pathname === "/api/state") {
        json(res, session.snapshot());
        return;
      }
      if (url.pathname === "/api/events") {
        const id = url.searchParams.get("id") || "";
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        clients.set(res, id);
        res.write(`data: ${JSON.stringify(session.snapshot())}\n\n`);
        res.on("close", () => {
          clients.delete(res);
          if (id && session.player === id) {
            session.player = null;
            broadcast();
          }
        });
        return;
      }
      if (url.pathname === "/api/credits") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Disposition": 'attachment; filename="credits.txt"',
        });
        res.end(
          [...new Set(session.queue.map((t: Track) => t.credit))].join("\n"),
        );
        return;
      }
      if (url.pathname.startsWith("/media/")) {
        const track = library.tracks.get(url.pathname.slice(7));
        if (!track) {
          json(res, { error: "Track not found." }, 404);
          return;
        }
        if (track.provider === "local") {
          await serveFile(req, res, track.media, musicRoot!);
          return;
        }
        if (track.provider === "openlofi") {
          await serveFile(req, res, await cache.get(track.media), cache.folder);
          return;
        }
        const upstream = await fetch(safeMedia(track.media), {
          redirect: "error",
          signal: AbortSignal.timeout(60_000),
          headers: req.headers.range ? { Range: req.headers.range } : {},
        });
        if (![200, 206, 416].includes(upstream.status) || !upstream.body)
          throw Error("Music host is unavailable.");
        for (const header of [
          "content-type",
          "content-length",
          "content-range",
          "accept-ranges",
        ]) {
          const value = upstream.headers.get(header);
          if (value) res.setHeader(header, value);
        }
        res.writeHead(upstream.status);
        if (req.method === "HEAD") {
          await upstream.body.cancel();
          res.end();
          return;
        }
        await pipeline(
          Readable.fromWeb(
            upstream.body as import("node:stream/web").ReadableStream,
          ),
          res,
        );
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        json(res, { error: "Not found." }, 404);
        return;
      }
      if (url.pathname === "/player") {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      if (vite) {
        vite.middlewares(req, res);
        return;
      }
      const path = ["/", "/overlay"].includes(url.pathname)
        ? "/index.html"
        : decodeURIComponent(url.pathname);
      await serveFile(req, res, join(root, "dist", path), join(root, "dist"));
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(res, { error: (error as Error).message }, 400);
      else res.destroy();
    }
  });
  let quitting = false;
  async function quit() {
    if (quitting) return;
    quitting = true;
    clearInterval(tick);
    session.playing = false;
    session.player = null;
    broadcast();
    tui.close();
    for (const client of clients.keys()) client.end();
    await vite?.close();
    server.close();
    server.closeAllConnections();
  }
  const tick = setInterval(() => {
    session.tick();
    if (session.player && Date.now() - playerSeen > 6000) {
      session.player = null;
    }
    broadcast();
  }, 500);
  server.on("error", (error) => {
    console.error(
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `Port ${port} is busy. Use --port with another port.`
        : error.message,
    );
    void quit();
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(
      `Still  ${origin}\nOBS    ${origin}/overlay  (1920×1080, automatic audio)\nMusic  select a track in the terminal; the OBS source plays it automatically\n? help in terminal · Ctrl+C quit`,
    );
    tui = terminal(
      session,
      library,
      command,
      () => {
        void quit();
      },
      origin,
    );
  });
  process.on("SIGINT", () => {
    void quit();
  });
  process.on("SIGTERM", () => {
    void quit();
  });
}
void main().catch((error) => {
  console.error(`Still: ${(error as Error).message}`);
  process.exitCode = 1;
});
