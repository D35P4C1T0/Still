<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { MediaQuery } from 'svelte/reactivity';
  import { AudioPlayer } from './audio';
  import { clock, defaults, phaseNames, type Snapshot, type Settings } from './shared';

  const overlay = location.pathname === '/overlay';
  const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
  const id = crypto.randomUUID();
  let snapshot = $state<Snapshot | null>(null);
  let connected = $state(false);
  let showSettings = $state(false);
  let error = $state('');
  let ownsAudio = $state(false);
  let enabling = $state(false);
  let draft = $state<Settings>({ ...defaults });
  let now = $state(performance.now());
  let localDeadline = $state<number | null>(null);
  let audio: AudioPlayer | null = null;
  let events: EventSource;
  let heartbeat: ReturnType<typeof setInterval>;
  const settings = $derived(snapshot?.settings || defaults);
  const current = $derived(snapshot?.music.queue[snapshot.music.index]);
  const musicSources = { local: 'Local folder', openlofi: 'Open Lo-Fi · GitHub release', royalty: 'RoyaltyMusicFree' };
  const remaining = $derived(Math.max(0, localDeadline === null ? snapshot?.timer.remaining ?? defaults.focus * 60_000 : localDeadline - now));
  const count = $derived(snapshot?.timer.completed || 0);
  async function command(data: Record<string, unknown>) {
    const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Still': '1' }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Command failed.');
    return result as Snapshot;
  }
  async function run(data: Record<string, unknown>) {
    try { error = ''; await command(data); } catch (e) { error = (e as Error).message; }
  }
  function stopAudio() {
    ownsAudio = false; clearInterval(heartbeat); audio?.destroy(); audio = null;
  }
  function receive(next: Snapshot) {
    const received = performance.now();
    if (!next.timer.running) localDeadline = null;
    // Unrelated broadcasts must not restart the local countdown or inherit packet jitter.
    else if (!connected || next.timer.deadline !== snapshot?.timer.deadline || !snapshot?.timer.running) localDeadline = received + next.timer.remaining;
    snapshot = next; now = received; connected = true;
  }
  async function startAudio() {
    if (enabling) return;
    enabling = true;
    try {
      error = '';
      stopAudio();
      audio = new AudioPlayer(
        async revision => { await command({ type: 'advance', id, revision }); },
        (message, revision, fatal = true) => { error = message; if (fatal) void command({ type: 'audioError', id, revision }).catch(() => stopAudio()); },
      );
      await audio.unlock();
      const claimed = await command({ type: 'claim', id });
      if (!snapshot || claimed.now >= snapshot.now) receive(claimed);
      if (snapshot?.music.player !== id) { stopAudio(); return; }
      ownsAudio = true; audio?.sync(snapshot);
      heartbeat = setInterval(() => {
        void command({ type: 'pulse', id }).catch(e => { error = e.message; stopAudio(); });
      }, 2000);
    } catch (e) { error = (e as Error).message; stopAudio(); }
    finally { enabling = false; }
  }
  function openSettings() { draft = { ...settings }; showSettings = !showSettings; }
  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    try { error = ''; await command({ type: 'settings', settings: draft }); showSettings = false; }
    catch (e) { error = (e as Error).message; }
  }
  onMount(() => {
    events = new EventSource(`/api/events?id=${id}`);
    events.onmessage = event => {
      receive(JSON.parse(event.data));
      if (ownsAudio && snapshot?.music.player !== id) stopAudio();
      if (ownsAudio) audio?.sync(snapshot!);
      if (overlay && !ownsAudio && !enabling && !snapshot?.music.player) void startAudio();
    };
    events.onerror = () => { connected = false; stopAudio(); };
    const display = setInterval(() => { now = performance.now(); }, 100);
    return () => { events.close(); stopAudio(); clearInterval(display); };
  });
</script>

<svelte:head><title>{overlay ? 'Still — overlay' : 'Still'}</title></svelte:head>

<div class="room" class:light={settings.theme === 'light'} class:break-time={snapshot?.timer.phase === 'short' || snapshot?.timer.phase === 'long'} class:long-break={snapshot?.timer.phase === 'long'} class:overlay class:static={!settings.motion} class:transparent={overlay && settings.transparent}>
  <div class="atmosphere" aria-hidden="true"><div class="orb one"></div><div class="orb two"></div><div class="orb three"></div></div>
  {#if !overlay}
    <header>
      <button class="icon-button" aria-label="Open settings" title="Settings" aria-expanded={showSettings} onclick={openSettings}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10" /><circle cx="10" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="8" cy="18" r="2" /></svg></button>
    </header>
  {/if}

  <main>
    <section class="timer-card" aria-label="Pomodoro timer">
      <div class="phase-row"><span class="phase-pill">{phaseNames[snapshot?.timer.phase || 'focus']}</span><span class="session-label" aria-label="Session">{Math.min(count + 1, settings.interval)} / {settings.interval}</span></div>
      <div class="countdown" role="timer" aria-label={`${phaseNames[snapshot?.timer.phase || 'focus']}: ${clock(remaining)} remaining`}>{clock(remaining)}</div>
      {#if !overlay}
        <div class="timer-controls">
          <button class="secondary round" aria-label="Reset current phase" title="Reset" disabled={!connected} onclick={() => run({ type: 'timer', action: 'reset' })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10a8 8 0 1 1 2 8M4 4v6h6" /></svg></button>
          <button class="primary round" aria-label={snapshot?.timer.running ? 'Pause session' : 'Begin session'} title={snapshot?.timer.running ? 'Pause' : 'Start'} disabled={!connected} onclick={() => run({ type: 'timer', action: 'toggle' })}><svg viewBox="0 0 24 24" aria-hidden="true">{#if snapshot?.timer.running}<path d="M9 6v12M15 6v12" />{:else}<path d="m9 5 10 7-10 7V5Z" />{/if}</svg></button>
          <button class="secondary round" aria-label="Skip current phase" title="Skip" disabled={!connected} onclick={() => run({ type: 'timer', action: 'skip' })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 10 7-10 7V5ZM19 5v14" /></svg></button>
        </div>
      {/if}
      <div class="cycle-dots" aria-label={`${count} of ${settings.interval} focus sessions completed`}>{#each Array(settings.interval) as _, i}<span class:done={i < count} class:current={i === count}></span>{/each}</div>
    </section>

    <div class="song-region">
    {#if current && (!overlay || settings.showTitle)}
      {#key current.id}
      <section class="now-playing" aria-label="Music player" transition:fade={{ duration: reducedMotion.current ? 0 : 400 }}>
        <div class="track-details">
          <svg class="music-note" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l11-2v13M9 8l11-2" /><ellipse cx="6" cy="18" rx="3" ry="2" /><ellipse cx="17" cy="16" rx="3" ry="2" /></svg>
          <span class="track-title" title={current.title}>{current.title}</span>
          <span class="track-meta">{current.artist} · {current.category}</span>
          {#if !overlay && current.source}
            <a class="track-source" href={current.source} target="_blank" rel="noreferrer">Source: {musicSources[current.provider]}</a>
          {:else}
            <span class="track-source">Source: {musicSources[current.provider]}</span>
          {/if}
        </div>
        {#if !overlay}
          <div class="music-controls">
            <button class="icon-button" aria-label="Previous track" title="Previous track" disabled={!connected} onclick={() => run({ type: 'music', action: 'previous' })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 5-10 7 10 7V5ZM5 5v14" /></svg></button>
            <button class="play-music" aria-label={snapshot?.music.playing ? 'Pause music' : 'Play music'} title={snapshot?.music.playing ? 'Pause music' : 'Play music'} disabled={!connected} onclick={() => run({ type: 'music', action: 'toggle' })}><svg viewBox="0 0 24 24" aria-hidden="true">{#if snapshot?.music.playing}<path d="M9 6v12M15 6v12" />{:else}<path d="m9 5 10 7-10 7V5Z" />{/if}</svg></button>
            <button class="icon-button" aria-label="Next track" title="Next track" disabled={!connected} onclick={() => run({ type: 'music', action: 'next' })}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 5 10 7-10 7V5ZM19 5v14" /></svg></button>
          </div>
        {/if}
      </section>
      {/key}
    {/if}
    </div>
    {#if !connected}<span class="connection-status" role="status" aria-label="Reconnecting" title="Reconnecting"></span>{/if}
  </main>

  {#if !overlay}
    {#if error}<div class="error" role="alert">{error}<button aria-label="Dismiss error" onclick={() => error = ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>{/if}
    {#if showSettings}
      <aside class="settings" aria-label="Session settings">
        <div class="settings-heading"><h2>Settings</h2><button class="icon-button" aria-label="Close settings" onclick={() => showSettings = false}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
        <form onsubmit={saveSettings}>
          <fieldset><legend>Session lengths · minutes</legend><div class="duration-inputs"><label>Focus<input type="number" min="0.016666666666666666" max="240" step="any" bind:value={draft.focus} required /></label><label>Short break<input type="number" min="0.016666666666666666" max="240" step="any" bind:value={draft.short} required /></label><label>Long break<input type="number" min="0.016666666666666666" max="240" step="any" bind:value={draft.long} required /></label></div><label class="setting-row">Focus sessions per cycle<input type="number" min="1" max="12" bind:value={draft.interval} required /></label><label class="setting-row">Start next phase automatically<input type="checkbox" bind:checked={draft.autoStart} /></label></fieldset>
          <fieldset><legend>Atmosphere</legend><label class="setting-row">Theme<select bind:value={draft.theme}><option value="dark">Deep evergreen</option><option value="light">Soft daylight</option></select></label><label class="setting-row">Gentle background motion<input type="checkbox" bind:checked={draft.motion} /></label></fieldset>
          <fieldset><legend>Stream display · 1920 × 1080</legend><label class="setting-row">Transparent background<input type="checkbox" bind:checked={draft.transparent} /></label><label class="setting-row">Show current song<input type="checkbox" bind:checked={draft.showTitle} /></label><a href="/overlay" target="_blank" rel="noreferrer">Open OBS overlay ↗</a></fieldset>
          <fieldset><legend>Music</legend><label class="setting-row">Crossfade · seconds<input type="number" min="0" max="30" step="0.5" bind:value={draft.crossfade} required /></label><a href="/api/credits" download="credits.txt">Download queue credits ↗</a></fieldset>
          <button class="primary save" type="submit" disabled={!connected}>Save preferences <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4 10-10" /></svg></button>
        </form>
      </aside>
    {/if}
  {/if}
</div>
