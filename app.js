// @ts-check
(() => {
  'use strict';
  const { CONFIG, createEngine, loudnessAt, nominalLength } = Yuragi;
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

  const TURN = Math.PI * 2;
  const TOP = -Math.PI / 2;
  // 輪の一周がその声部の周期。真上が現在で、時計回りの側が過去、反対側が未来。
  const AHEAD = 0.6;
  const BEHIND = 0.4;
  const FUTURE_LEVEL = 0.5;
  const FADE_STEPS = 8;
  // 現在を線で区切らない。真上を越えてからこの割合で明るくなりきる。
  const BLOOM = 0.03;
  // 声部ごとの淡い色。水色から藤色、最後に薄い桃色まで。
  const HUES = [172, 192, 212, 236, 268, 318];
  const RING_STEPS = 96;

  /**
   * 輪を真円にしない。ゆっくり形を変える、わずかないびつさ。
   * @param {number} index 声部
   * @param {number} angle
   * @param {number} time
   * @returns {number} 半径に掛ける倍率
   */
  function sway(index, angle, time) {
    const drift = reducedMotion.matches ? 0 : time;
    return 1
      + 0.022 * Math.sin(2 * angle + index * 1.7 + drift * 0.031)
      + 0.014 * Math.sin(3 * angle - index * 2.3 - drift * 0.023)
      + 0.008 * Math.sin(5 * angle + index * 0.9 + drift * 0.041);
  }

  /**
   * 真上からの角度だけで決まる濃さ。過去は回るうちに消え、未来は近づくにつれて現れる。
   * @param {number} cx
   * @param {number} cy
   * @param {string} color hsl の中身。alpha は含めない
   * @param {number} strength
   */
  function fadeAround(cx, cy, color, strength) {
    const fade = pen.createConicGradient(TOP, cx, cy);
    fade.addColorStop(0, `hsl(${color} / ${strength * FUTURE_LEVEL})`);
    for (let i = 0; i <= FADE_STEPS; i++) {
      const k = i / FADE_STEPS;
      fade.addColorStop(BLOOM + k * (BEHIND - BLOOM), `hsl(${color} / ${strength * (1 - k) ** 2})`);
      fade.addColorStop(1 - AHEAD + k * AHEAD, `hsl(${color} / ${strength * FUTURE_LEVEL * k ** 2})`);
    }
    return fade;
  }

  /**
   * 1音の音量の形を、輪に沿った帯の太さとして描く。
   * @param {{ time: number, dur: number, timbre: TimbreName }} note
   * @param {number} now
   * @param {number} period
   * @param {number} cx
   * @param {number} cy
   * @param {number} radius
   * @param {number} reach 帯の最大の半幅
   * @param {number} index 声部
   */
  function traceWave(note, now, period, cx, cy, radius, reach, index) {
    const from = Math.max(note.time, now - BEHIND * period);
    const to = Math.min(note.time + note.dur, now + AHEAD * period);
    if (from >= to) return;
    const timbre = CONFIG.timbres[note.timbre];
    const half = reach * Math.sqrt(timbre.visualScale);
    const steps = Math.max(2, Math.ceil(((to - from) / period) * TURN * radius / 3));
    /** @type {[number, number][]} */
    const inner = [];
    pen.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      const angle = TOP + (TURN * (now - t)) / period;
      const width = 0.5 + half * Math.cbrt(loudnessAt(timbre, t - note.time, note.dur));
      const middle = radius * sway(index, angle, now);
      pen.lineTo(cx + Math.cos(angle) * (middle + width), cy + Math.sin(angle) * (middle + width));
      inner.push([cx + Math.cos(angle) * (middle - width), cy + Math.sin(angle) * (middle - width)]);
    }
    for (const [x, y] of inner.reverse()) pen.lineTo(x, y);
    pen.closePath();
    pen.fill();
  }

  function draw() {
    pen.clearRect(0, 0, innerWidth, innerHeight);

    const style = getComputedStyle(document.documentElement);
    const saturation = style.getPropertyValue('--circle-saturation');
    const lightness = style.getPropertyValue('--circle-lightness');
    const strength = Number(style.getPropertyValue('--circle-alpha'));
    const now = context.currentTime - (context.outputLatency || 0);
    const audible = engine.master.gain.value;
    const cx = innerWidth / 2;
    const cy = innerHeight * 0.46;
    const outer = Math.min(innerWidth, innerHeight) * 0.36;
    const gap = (outer * 0.68) / (engine.voices.length - 1);

    player.events = player.events.filter((ev) => ev.time + ev.dur > now - BEHIND * engine.voices[ev.voice].period);
    for (const voice of engine.voices) {
      // 低い声部ほど外側の大きな輪にする。
      const radius = outer - voice.index * gap;
      const color = `${HUES[voice.index % HUES.length]} ${saturation} ${lightness}`;

      pen.strokeStyle = `hsl(${color} / ${strength * 0.22})`;
      pen.lineWidth = 1.5;
      pen.beginPath();
      for (let i = 0; i < RING_STEPS; i++) {
        const angle = (TURN * i) / RING_STEPS;
        const r = radius * sway(voice.index, angle, now);
        pen.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      }
      pen.closePath();
      pen.stroke();

      const sounded = player.events.filter((ev) => ev.voice === voice.index);
      if (!reducedMotion.matches) {
        const upcoming = { time: voice.next, dur: nominalLength(CONFIG.timbres[engine.timbre]), timbre: engine.timbre };
        pen.fillStyle = fadeAround(cx, cy, color, strength * 1.6);
        for (const note of [...sounded, upcoming]) traceWave(note, now, voice.period, cx, cy, radius, gap * 0.3, voice.index);
      }

      for (const ev of sounded) {
        const age = now - ev.time;
        if (age < 0 || age > ev.dur) continue;
        const timbre = CONFIG.timbres[ev.timbre];
        const alpha = Math.cbrt(loudnessAt(timbre, age, ev.dur)) * strength * audible;
        const spread = gap * (0.9 + timbre.visualScale);
        const y = cy - radius * sway(voice.index, TOP, now);
        const wash = pen.createRadialGradient(cx, y, 0, cx, y, spread);
        wash.addColorStop(0, `hsl(${color} / ${alpha})`);
        wash.addColorStop(0.45, `hsl(${color} / ${alpha * 0.45})`);
        wash.addColorStop(1, `hsl(${color} / 0)`);
        pen.fillStyle = wash;
        pen.beginPath();
        pen.arc(cx, y, spread, 0, TURN);
        pen.fill();
      }
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
