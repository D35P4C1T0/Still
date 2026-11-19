import {
  Box,
  Text,
  render as renderInk,
  useInput,
  useWindowSize,
  type Key,
  type Instance,
} from "ink";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "./session.js";
import type { Library } from "./library.js";
import { clock, phaseNames, type Provider, type Track } from "../shared.js";

export function terminal(
  session: Session,
  library: Library,
  command: (data: Record<string, unknown>) => Promise<void>,
  quit: () => void,
  origin: string,
) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return { render() {}, close() {} };
  let provider: Provider = "local";
  let timerPanel = false;
  let rows: Track[] = library.catalogs.get("local") || [];
  let cursor = 0,
    filter = "",
    searching = false,
    help = false;
  let message = "Enter plays the selected track. / searches.";
  let request = 0;
  let closed = false;
  let instance: Instance | null = null;
  let pending = Promise.resolve();
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
  const filtered = () =>
    rows.filter((t) =>
      `${t.title} ${t.artist} ${t.category}`
        .toLowerCase()
        .includes(filter.toLowerCase()),
    );
  function render() {
    if (!closed) instance?.rerender(<View />);
  }
  function View() {
    const { columns, rows: height } = useWindowSize();
    const phaseRevision = session.phaseRevision;
    useInput((input, key) => {
      const inputs =
        key.ctrl ||
        key.return ||
        key.escape ||
        key.upArrow ||
        key.downArrow ||
        key.backspace ||
        key.delete
          ? [input]
          : [...input];
      for (const text of inputs) {
        const pressed =
          text === "\r" || text === "\n" ? { ...key, return: true } : key;
        pending = pending.then(() => {
          if (!closed) return keypress(text, pressed, phaseRevision);
        });
      }
    });
    const list = filtered();
    cursor = Math.max(0, Math.min(cursor, list.length - 1));
    const music = session.queue[session.index];
    const visible = Math.max(1, height - (columns < 58 ? 25 : 22));
    const start = Math.max(
      0,
      Math.min(cursor - Math.floor(visible / 2), list.length - visible),
    );
    const track = list[cursor];
    return (
      <Box
        width={columns}
        height={height}
        flexDirection="column"
        overflow="hidden"
      >
        <Box justifyContent="space-between">
          <Text bold color="green">
            STILL
          </Text>
          <Text>
            {phaseNames[session.phase]}{" "}
            <Text bold>{clock(session.remaining)}</Text>{" "}
            {session.deadline ? "running" : "paused"} {session.completed}/
            {session.settings.interval}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {origin} · OBS {origin}/overlay
        </Text>
        <Box
          borderStyle="round"
          borderColor="green"
          paddingX={1}
          flexDirection="column"
        >
          <Text wrap="truncate-end">
            {session.playing ? "▶" : "Ⅱ"}{" "}
            {clean(music?.title || "No track selected")}
          </Text>
          <Box gap={2} flexWrap="wrap">
            <Text dimColor={searching || !music}>[h] Previous</Text>
            <Text bold color={searching ? "gray" : "green"}>
              {`[Space] ${session.playing ? "Pause" : "Play"}`}
            </Text>
            <Text dimColor={searching || !music}>[l] Next</Text>
          </Box>
          <Text dimColor>
            [-/+] Volume {session.settings.volume}% · [ / ] Crossfade{" "}
            {session.settings.crossfade}s · Queue{" "}
            {session.queue.length ? Math.max(0, session.index + 1) : 0}/
            {session.queue.length}
          </Text>
          <Text color={session.player ? "green" : "yellow"} wrap="truncate-end">
            Audio:{" "}
            {session.player ? "connected" : "waiting for the OBS overlay"}
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor="gray"
          paddingX={1}
          gap={2}
          flexWrap="wrap"
        >
          <Text bold color="green">
            PLAYBACK
          </Text>
          <Text>
            <Text color="green">[Space]</Text>{" "}
            {session.playing ? "Pause" : "Play"}
          </Text>
          <Text>
            <Text color="green">[h]</Text> Previous
          </Text>
          <Text>
            <Text color="green">[l]</Text> Next
          </Text>
          <Text>
            <Text color="green">[−/+]</Text> Volume
          </Text>
          <Text>
            <Text color="green">[Enter]</Text> Play selection
          </Text>
        </Box>
        <Box gap={2} flexWrap="wrap">
          {(["local", "openlofi", "royalty"] as const).map((source, i) => (
            <Text
              key={source}
              bold={!timerPanel && provider === source}
              color={!timerPanel && provider === source ? "green" : undefined}
              inverse={!timerPanel && provider === source}
            >
              {i + 1}{" "}
              {
                {
                  local: "Local",
                  openlofi: "Open Lo-Fi",
                  royalty: "RoyaltyMusicFree",
                }[source]
              }
            </Text>
          ))}
          <Text
            bold={timerPanel}
            color={timerPanel ? "green" : undefined}
            inverse={timerPanel}
          >
            4 Timer
          </Text>
        </Box>
        <Box
          borderStyle="round"
          borderColor={searching || timerPanel ? "green" : "gray"}
          paddingX={1}
          flexDirection="column"
          flexGrow={1}
          overflow="hidden"
        >
          {timerPanel ? (
            <Box flexDirection="column">
              <Text bold color="green">
                4 TIMER
              </Text>
              <Text>
                {phaseNames[session.phase]} · {clock(session.remaining)} ·{" "}
                {session.deadline === null ? "paused" : "running"}
              </Text>
              <Text>[s] Start [p] Pause [n] Skip</Text>
              <Text>[Enter/t] Start / pause [r] Reset</Text>
              <Text dimColor>
                {session.completed}/{session.settings.interval} focus sessions
                complete
              </Text>
            </Box>
          ) : (
            <>
              <Text wrap="truncate-end">
                {searching ? "SEARCH: " : "Filter: "}
                {clean(filter)}
                {searching ? "▏" : ""}{" "}
                <Text dimColor>({list.length} tracks)</Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                {clean(message)}
              </Text>
              {help ? (
                <Box flexDirection="column">
                  <Text>t timer · r reset · n skip · Space music</Text>
                  <Text>h/l previous/next · j/k or arrows browse</Text>
                  <Text>Enter play · a append · / search · g refresh</Text>
                  <Text>
                    1/2/3 source · 4 timer · -/+ volume · [/] crossfade
                  </Text>
                  <Text>c export credits · Esc back · ? help · q quit</Text>
                </Box>
              ) : (
                <Box flexDirection="column">
                  {!list.length && !message.startsWith("Loading") && (
                    <Text dimColor>
                      {filter
                        ? "No matching tracks."
                        : "No tracks here. Choose 2 or 3 for online music."}
                    </Text>
                  )}
                  {list.slice(start, start + visible).map((item, i) => (
                    <Text
                      key={item.id}
                      inverse={start + i === cursor}
                      color={start + i === cursor ? "green" : undefined}
                      wrap="truncate-end"
                    >
                      {start + i === cursor ? "›" : " "} {clean(item.title)}{" "}
                      <Text dimColor> / {clean(item.category)}</Text>
                    </Text>
                  ))}
                </Box>
              )}
            </>
          )}
        </Box>
        {!timerPanel && track && height >= 20 && (
          <Text dimColor wrap="truncate-end">
            {clean(track.artist)} · {clean(track.source || "Local file")}
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {timerPanel
            ? "s start · p pause · n skip · 1/2/3 library · q quit"
            : "? help · Enter play · / search · 4 timer · q quit"}
        </Text>
      </Box>
    );
  }
  async function load(next: Provider, refresh = false) {
    const current = ++request;
    provider = next;
    timerPanel = false;
    filter = "";
    cursor = 0;
    rows = [];
    message = `Loading ${next}…`;
    render();
    try {
      const result = await library.load(next, refresh);
      if (current !== request) return;
      rows = result.tracks;
      message = result.warning || `${rows.length} tracks ready.`;
    } catch (e) {
      if (current === request) message = (e as Error).message;
    }
    render();
  }
  async function keypress(text: string, key: Key, phaseRevision: number) {
    try {
      if (key.ctrl && text === "c") {
        quit();
        return;
      }
      if (searching) {
        if (key.escape || key.return) searching = false;
        else if (key.backspace || key.delete) filter = filter.slice(0, -1);
        else if (
          text &&
          !key.ctrl &&
          !key.meta &&
          !/[\x00-\x1f\x7f]/.test(text)
        )
          filter += text;
        cursor = 0;
        render();
        return;
      }
      const list = filtered();
      cursor = Math.max(0, Math.min(cursor, list.length - 1));
      if (text === "q") {
        quit();
        return;
      } else if (text === "?") help = !help;
      else if (key.escape) {
        filter = "";
        help = false;
      } else if (text === "4") {
        timerPanel = true;
        help = false;
      } else if (timerPanel && (text === "s" || text === "p")) {
        await command({
          type: "timer",
          action: text === "s" ? "start" : "pause",
        });
      } else if (timerPanel && key.return) {
        await command({ type: "timer", action: "toggle" });
      } else if (text === "/" && !timerPanel) searching = true;
      else if (text === "j" || key.downArrow) cursor++;
      else if (text === "k" || key.upArrow) cursor--;
      else if (text === "1") {
        void load("local");
        return;
      } else if (text === "2") {
        void load("openlofi");
        return;
      } else if (text === "3") {
        void load("royalty");
        return;
      } else if (text === "g") {
        void load(provider, true);
        return;
      } else if (key.return && !timerPanel && list[cursor])
        await command({
          type: "select",
          ids: list.map((t) => t.id),
          index: cursor,
        });
      else if (text === "a" && !timerPanel && list[cursor])
        await command({ type: "append", id: list[cursor].id });
      else if (text === "t" || text === "r" || text === "n")
        await command({
          type: "timer",
          action: { t: "toggle", r: "reset", n: "skip" }[text],
          phaseRevision,
        });
      else if (text === " " || text === "h" || text === "l")
        await command({
          type: "music",
          action: { " ": "toggle", h: "previous", l: "next" }[text],
        });
      else if (["-", "+", "="].includes(text))
        await command({
          type: "settings",
          settings: {
            volume: Math.max(
              0,
              Math.min(100, session.settings.volume + (text === "-" ? -1 : 1)),
            ),
          },
        });
      else if (text === "[" || text === "]")
        await command({
          type: "settings",
          settings: {
            crossfade: Math.max(
              0,
              Math.min(
                30,
                session.settings.crossfade + (text === "[" ? -1 : 1),
              ),
            ),
          },
        });
      else if (text === "c") {
        const credits = [...new Set(session.queue.map((t) => t.credit))].join(
          "\n",
        );
        await atomicCredits(credits);
        message = "Queue credits saved to credits.txt in the data directory.";
      }
    } catch (e) {
      message = (e as Error).message;
    }
    render();
  }
  async function atomicCredits(credits: string) {
    await writeFile(join(library.directory, "credits.txt"), credits + "\n", {
      mode: 0o600,
    });
  }
  instance = renderInk(<View />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    interactive: true,
  });
  return {
    render,
    close() {
      if (closed) return;
      closed = true;
      instance?.unmount();
    },
  };
}
