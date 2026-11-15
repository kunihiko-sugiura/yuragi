// @ts-check
(() => {
  'use strict';
  const { CONFIG, createEngine, loudnessAt } = Yuragi;
  const FADE_IN = 0.5;
  const FADE_OUT = 0.7;
  const CLOSE_AFTER_MS = 3200;

  /**
   * @template {HTMLElement} T
   * @param {string} id
   * @param {new () => T} type
   * @returns {T}
   */
  function byId(id, type) {
    const element = document.getElementById(id);
    if (!(element instanceof type)) throw new Error(`#${id} がない`);
    return element;
  }

  const canvas = byId('field', HTMLCanvasElement);
  const pen = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
  const toggle = byId('toggle', HTMLButtonElement);
  const timbreButtons = [...document.querySelectorAll('button[data-timbre]')].filter((b) => b instanceof HTMLButtonElement);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const params = new URLSearchParams(location.search);
  const tuning = params.get('tuning');
  // 改訂前のピアノと聴き比べるための入口。?a=soft で A が旧音色になる。
  /** @type {TimbreName} */
  const pianoTimbre = params.get('a') === 'soft' ? 'pianoSoft' : 'piano';
  byId('timbre-piano', HTMLButtonElement).dataset.timbre = pianoTimbre;

  /** @typedef {'idle' | 'playing' | 'stopping'} State */

  /**
   * @type {{
   *   state: State,
   *   timbre: TimbreName,
   *   context: AudioContext | null,
   *   engine: Engine | null,
   *   analyser: AnalyserNode | null,
   *   events: NoteEvent[],
   *   played: number,
   *   timer: number,
   *   closing: number,
   *   frame: number,
   * }}
   */
  const player = { state: 'idle', timbre: pianoTimbre, context: null, engine: null, analyser: null, events: [], played: 0, timer: 0, closing: 0, frame: 0 };

  /**
   * @param {number} target
   * @param {number} timeConstant
   */
  function fade(target, timeConstant) {
    if (!player.context || !player.engine) return;
    const gain = player.engine.master.gain;
    const now = player.context.currentTime;
    gain.cancelScheduledValues(now);
    gain.setTargetAtTime(target, now, timeConstant);
  }

  function schedule() {
    if (!player.context || !player.engine) return;
    const until = player.context.currentTime + CONFIG.scheduler.lookahead;
    const created = player.engine.scheduleUntil(until);
    player.played += created.length;
    player.events.push(...created);
  }

  function begin() {
    const context = new AudioContext({ latencyHint: 'playback' });
    const engine = createEngine(context, { timbre: player.timbre, tuning });
    const analyser = context.createAnalyser();
    engine.master.connect(analyser);
    engine.master.gain.value = 0;
    Object.assign(player, { context, engine, analyser, events: [] });
    context.resume();
    fade(1, FADE_IN);
    engine.start(context.currentTime + CONFIG.scheduler.lead);
    schedule();
    player.timer = setInterval(schedule, CONFIG.scheduler.tick * 1000);
    if (!player.frame) player.frame = requestAnimationFrame(draw);
  }

  function beginStop() {
    fade(0, FADE_OUT);
    player.closing = setTimeout(finishStop, CLOSE_AFTER_MS);
  }

  function resume() {
    clearTimeout(player.closing);
    fade(1, FADE_IN);
  }

  function finishStop() {
    clearInterval(player.timer);
    player.context?.close();
    Object.assign(player, { context: null, engine: null, analyser: null, events: [] });
    enter('idle');
  }

  /** @type {Record<State, { toggle: { run: () => void, to: State } }>} */
  const TRANSITIONS = {
    idle: { toggle: { run: begin, to: 'playing' } },
    playing: { toggle: { run: beginStop, to: 'stopping' } },
    stopping: { toggle: { run: resume, to: 'playing' } },
  };
  /** @type {Record<State, string>} */
  const LABELS = { idle: '再生', playing: '停止', stopping: '再生' };

  /** @param {State} state */
  function enter(state) {
    player.state = state;
    document.body.dataset.state = state;
    toggle.textContent = LABELS[state];
  }

  toggle.addEventListener('click', () => {
    const transition = TRANSITIONS[player.state].toggle;
    transition.run();
    enter(transition.to);
  });

  for (const button of timbreButtons) {
    button.addEventListener('click', () => {
      // data-timbre はこのページで設定した値だけ。
      player.timbre = /** @type {TimbreName} */ (button.dataset.timbre);
      if (player.engine) player.engine.timbre = player.timbre;
      for (const other of timbreButtons) other.setAttribute('aria-pressed', String(other === button));
    });
  }

  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(innerWidth * ratio);
    canvas.height = Math.round(innerHeight * ratio);
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  addEventListener('resize', resize);
  resize();

  function draw() {
    player.frame = 0;
    pen.clearRect(0, 0, innerWidth, innerHeight);
    const { context, engine } = player;
    if (!context || !engine) return;

    const style = getComputedStyle(document.documentElement);
    const saturation = style.getPropertyValue('--circle-saturation');
    const lightness = style.getPropertyValue('--circle-lightness');
    const strength = Number(style.getPropertyValue('--circle-alpha'));
    const now = context.currentTime - (context.outputLatency || 0);
    const unit = Math.min(innerWidth, innerHeight) * 0.17;
    const audible = engine.master.gain.value;

    player.events = player.events.filter((ev) => ev.time + ev.dur > now);
    for (const ev of player.events) {
      const age = now - ev.time;
      if (age < 0) continue;
      const voice = CONFIG.voices[ev.voice];
      const timbre = CONFIG.timbres[ev.timbre];
      const alpha = Math.cbrt(loudnessAt(timbre, age, ev.dur)) * strength * audible;
      if (alpha < 0.003) continue;
      const growth = reducedMotion.matches ? 1 : 0.75 + 0.45 * Math.sqrt(age / ev.dur);
      const radius = unit * voice.size * timbre.visualScale * growth;
      const x = voice.x * innerWidth;
      const y = voice.y * innerHeight;
      const hue = 168 + ev.voice * 11;
      const wash = pen.createRadialGradient(x, y, 0, x, y, radius);
      wash.addColorStop(0, `hsl(${hue} ${saturation} ${lightness} / ${alpha})`);
      wash.addColorStop(0.45, `hsl(${hue} ${saturation} ${lightness} / ${alpha * 0.55})`);
      wash.addColorStop(1, `hsl(${hue} ${saturation} ${lightness} / 0)`);
      pen.fillStyle = wash;
      pen.beginPath();
      pen.arc(x, y, radius, 0, Math.PI * 2);
      pen.fill();
    }
    player.frame = requestAnimationFrame(draw);
  }

  /** @type {DebugHandle} */
  window.__yuragi = {
    get context() { return player.context; },
    get events() { return player.events; },
    get played() { return player.played; },
    level() {
      if (!player.analyser) return 0;
      const data = new Float32Array(player.analyser.fftSize);
      player.analyser.getFloatTimeDomainData(data);
      return Math.max(...data.map(Math.abs));
    },
  };
})();
