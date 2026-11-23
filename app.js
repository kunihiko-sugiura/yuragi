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
  // ?set=floating で浮遊の組から始まる。未知の値は既定の組になる。
  const loopSet = params.get('set');
  // 改訂前のピアノと聴き比べるための入口。?a=soft でピアノ側が旧音色になる。
  /** @type {TimbreName} */
  const pianoTimbre = params.get('a') === 'soft' ? 'pianoSoft' : 'piano';
  byId('timbre-piano', HTMLButtonElement).dataset.timbre = pianoTimbre;

  const context = new AudioContext({ latencyHint: 'playback' });
  const engine = createEngine(context, { timbre: pianoTimbre, tuning, set: loopSet });
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

  // 発音が始まるまでは呼吸する輪を1本だけ見せ、始まったら本編へ溶かす。
  // 許可済みで最初から鳴る環境でも、輪から本編への流れは必ず見せる。
  const LOADER_MIN = 1000;
  const BREATH = 4000;
  const loadedAt = performance.now();
  /** @type {number | null} */
  let revealAt = null;
  // 自動再生を止められたときだけ、輪の中に操作の合図を出す。
  // 許可されていても running になるまで少しかかるので、その間は止められたと見なさない。
  const BLOCKED_AFTER = 300;
  let blocked = false;
  function revealWhenRunning() {
    if (revealAt !== null || context.state !== 'running') return;
    revealAt = Math.max(performance.now(), loadedAt + LOADER_MIN);
    setTimeout(() => document.body.classList.add('started'), revealAt - performance.now());
  }

  for (const button of timbreButtons) {
    button.addEventListener('click', () => {
      // data-timbre はこのページで設定した値だけ。
      engine.timbre = /** @type {TimbreName} */ (button.dataset.timbre);
      for (const other of timbreButtons) other.setAttribute('aria-pressed', String(other === button));
    });
  }

  // ループと音階の組は1つのボタンで、押すたびに次の組へ巡る。
  const setButton = byId('loop-set', HTMLButtonElement);
  const setNames = /** @type {SetName[]} */ (Object.keys(CONFIG.sets));
  function showSet() {
    setButton.dataset.set = engine.loopSet;
    setButton.setAttribute('aria-label', `ループと音階: ${CONFIG.sets[engine.loopSet].label}（押すと次へ）`);
  }
  setButton.addEventListener('click', () => {
    engine.loopSet = setNames[(setNames.indexOf(engine.loopSet) + 1) % setNames.length];
    showSet();
  });
  showSet();

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
  // 声部ごとに「現在」の輪を1つ持つ。音は細い円の束になり、内側（未来）から
  // 現在の輪を通って外側（過去）へ、波紋のように広がる。単位は声部の周期。
  const AHEAD = 0.6;
  const BEHIND = 0.5;
  const FUTURE_LEVEL = 0.55;
  // 1音を何本の円で表すか。線の太さがその瞬間の音量になる。
  const LINES = 7;
  // 声部ごとの淡い色。水色から藤色、最後に薄い桃色まで。
  const HUES = [172, 192, 212, 236, 268, 318];

  /**
   * 現在からの隔たり（周期を1とする。正が過去）に応じた濃さ。
   * @param {number} away
   */
  function presence(away) {
    if (away >= 0) return away < BEHIND ? (1 - away / BEHIND) ** 2 : 0;
    return away > -AHEAD ? FUTURE_LEVEL * (1 + away / AHEAD) ** 2 : 0;
  }

  /**
   * @param {number} x
   * @param {number} y
   * @param {number} radius
   * @param {number} weight
   * @param {string} color
   */
  function ring(x, y, radius, weight, color) {
    pen.strokeStyle = color;
    pen.lineWidth = weight;
    pen.beginPath();
    pen.arc(x, y, radius, 0, TURN);
    pen.stroke();
  }

  function draw() {
    pen.clearRect(0, 0, innerWidth, innerHeight);

    const style = getComputedStyle(document.documentElement);
    const saturation = style.getPropertyValue('--circle-saturation');
    const lightness = style.getPropertyValue('--circle-lightness');
    const strength = Number(style.getPropertyValue('--circle-alpha'));
    const now = context.currentTime - (context.outputLatency || 0);
    const cx = innerWidth / 2;
    const cy = innerHeight * 0.46;
    const outer = Math.min(innerWidth, innerHeight) * 0.33;
    const gap = (outer * 0.66) / (engine.voices.length - 1);
    // statechange は届かないブラウザがあるので、毎フレーム状態を見る。
    revealWhenRunning();
    const clock = performance.now();
    if (revealAt === null && clock - loadedAt > BLOCKED_AFTER) blocked = true;
    const revealMs = reducedMotion.matches ? 300 : 1200;
    const shown = revealAt === null ? 0 : Math.min(1, Math.max(0, (clock - revealAt) / revealMs));

    if (shown < 1) {
      const breath = reducedMotion.matches ? 0 : Math.sin((TURN * (clock - loadedAt)) / BREATH);
      const radius = Math.min(innerWidth, innerHeight) * 0.25 * (1 + 0.12 * breath);
      ring(cx, cy, radius, 1, `hsl(212 ${saturation} ${lightness} / ${strength * (0.6 + 0.15 * breath) * (1 - shown)})`);
      if (blocked) {
        pen.globalAlpha = 1 - shown;
        pen.fillStyle = style.getPropertyValue('--ink-faint').trim();
        pen.font = '300 11px system-ui, sans-serif';
        pen.letterSpacing = '3px';
        pen.textAlign = 'center';
        pen.textBaseline = 'middle';
        // 字間は最後の文字の後ろにも付くので、その半分だけ右へずらして中央に置く。
        pen.fillText('click', cx + 1.5, cy);
        pen.letterSpacing = '0px';
      }
    }
    pen.globalAlpha = shown;

    player.events = player.events.filter((ev) => ev.time + ev.dur > now - BEHIND * engine.voices[ev.voice].period);
    for (const voice of engine.voices) {
      // 低い声部ほど外側の大きな輪にする。
      const home = outer - voice.index * gap;
      const color = `${HUES[voice.index % HUES.length]} ${saturation} ${lightness}`;
      const sounded = player.events.filter((ev) => ev.voice === voice.index);

      let sounding = 0;
      for (const ev of sounded) {
        const age = now - ev.time;
        if (age >= 0 && age <= ev.dur) sounding = Math.max(sounding, Math.cbrt(loudnessAt(CONFIG.timbres[ev.timbre], age, ev.dur)));
      }
      ring(cx, cy, home, 0.75 + 3 * sounding, `hsl(${color} / ${strength * (0.45 + 0.55 * sounding)})`);
      if (reducedMotion.matches) continue;

      const upcoming = { time: voice.next, dur: nominalLength(CONFIG.timbres[engine.timbre]), timbre: engine.timbre };
      for (const note of [...sounded, upcoming]) {
        const timbre = CONFIG.timbres[note.timbre];
        for (let i = 0; i < LINES; i++) {
          const offset = (note.dur * (i + 0.1)) / LINES;
          const away = (now - note.time - offset) / voice.period;
          const shown = presence(away);
          if (shown < 0.004) continue;
          const loud = Math.cbrt(loudnessAt(timbre, offset, note.dur));
          // 完全な円のまま、中心だけを少しずらして回す。現在の輪では同心になる。
          const turn = TOP + TURN * away;
          const drift = gap * 1.1 * Math.abs(away);
          ring(
            cx + Math.cos(turn) * drift,
            cy + Math.sin(turn) * drift,
            Math.max(1, home + gap * 3 * away),
            0.5 + 2.5 * loud * Math.sqrt(timbre.visualScale),
            `hsl(${color} / ${strength * shown * (0.3 + 0.7 * loud)})`,
          );
        }
      }
    }
    pen.globalAlpha = 1;
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);

  /** @type {DebugHandle} */
  window.__yuragi = {
    context,
    get events() { return player.events; },
    get played() { return player.played; },
    get loopSet() { return engine.loopSet; },
    level() {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.max(...data.map(Math.abs));
    },
  };
})();
