// @ts-check
(() => {
  'use strict';
  const { CONFIG, createEngine, loudnessAt } = Yuragi;
  const FADE_IN = 0.5;

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
  const timbreButtons = [...document.querySelectorAll('button[data-timbre]')].filter((b) => b instanceof HTMLButtonElement);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const params = new URLSearchParams(location.search);
  const tuning = params.get('tuning');
  // 改訂前のピアノと聴き比べるための入口。?a=soft でピアノ側が旧音色になる。
  /** @type {TimbreName} */
  const pianoTimbre = params.get('a') === 'soft' ? 'pianoSoft' : 'piano';
  byId('timbre-piano', HTMLButtonElement).dataset.timbre = pianoTimbre;

  const context = new AudioContext({ latencyHint: 'playback' });
  const engine = createEngine(context, { timbre: pianoTimbre, tuning });
  const analyser = context.createAnalyser();
  /** @type {{ events: NoteEvent[], played: number }} */
  const player = { events: [], played: 0 };

  function schedule() {
    const created = engine.scheduleUntil(context.currentTime + CONFIG.scheduler.lookahead);
    player.played += created.length;
    player.events.push(...created);
  }

  engine.master.connect(analyser);
  engine.master.gain.value = 0;
  engine.master.gain.setTargetAtTime(1, context.currentTime, FADE_IN);
  engine.start(context.currentTime + CONFIG.scheduler.lead);
  schedule();
  setInterval(schedule, CONFIG.scheduler.tick * 1000);

  // ブラウザは操作なしの発音を止める。止められた場合は最初の操作で鳴り始める。
  function wake() {
    if (context.state !== 'running') context.resume();
  }
  for (const type of ['pointerdown', 'pointerup', 'keydown']) addEventListener(type, wake);

  for (const button of timbreButtons) {
    button.addEventListener('click', () => {
      // data-timbre はこのページで設定した値だけ。
      engine.timbre = /** @type {TimbreName} */ (button.dataset.timbre);
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
    pen.clearRect(0, 0, innerWidth, innerHeight);

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
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  /** @type {DebugHandle} */
  window.__yuragi = {
    context,
    get events() { return player.events; },
    get played() { return player.played; },
    level() {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.max(...data.map(Math.abs));
    },
  };
})();
