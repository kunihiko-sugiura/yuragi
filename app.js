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
  // 改訂前の配色と見比べるための入口。?palette=v2 で寒色から桃色までの配色に戻る。
  const legacyPalette = params.get('palette') === 'v2';
  if (legacyPalette) document.documentElement.dataset.palette = 'v2';

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
  // 地の色相。声部ごとの違いは寒色の中にかすかに残す。値は OKLCH の色相。
  const GROUND_HUES = [215, 225, 235, 245, 255, 265];
  // 改訂前の配色（?palette=v2）。HSL の色相で、水色から藤色、最後に薄い桃色まで。
  const V2_HUES = [172, 192, 212, 236, 268, 318];
  const HUES = legacyPalette ? V2_HUES : GROUND_HUES;
  const BREATH_HUE = legacyPalette ? 212 : 235;
  // 灯りは現在の輪を過ぎてから、この隔たり（周期を1とする）までに地の色へ冷める。
  const COOL = 0.3;
  // 1音ごとの灯りの色相のゆらぎ（度）。
  const LAMP_SWAY = 3;

  /**
   * OKLCH を OKLab の [L, a, b] に直す。
   * @param {number} l
   * @param {number} c
   * @param {number} h 度
   */
  function oklab(l, c, h) {
    const rad = (h * Math.PI) / 180;
    return [l, c * Math.cos(rad), c * Math.sin(rad)];
  }

  /**
   * 音ごとに決まった、-1〜1 の値。描画のたびに同じ値を返す。
   * @param {number} time
   */
  function noteSway(time) {
    const x = Math.sin(time * 12.9898) * 43758.5453;
    return 2 * (x - Math.floor(x)) - 1;
  }

  /**
   * その時点の配色で、線の色を作る関数を返す。
   * warmth が 0 なら地の色、1 なら灯りの色。灯りから地へは OKLab で混ぜるので、
   * 途中で灰色がかった色を通る。
   * @param {CSSStyleDeclaration} style
   * @returns {(hue: number, warmth: number, sway: number, alpha: number) => string}
   */
  function paletteFrom(style) {
    const read = (/** @type {string} */ name) => style.getPropertyValue(name).trim();
    if (legacyPalette) {
      const sl = `${read('--circle-saturation')} ${read('--circle-lightness')}`;
      return (hue, _warmth, _sway, alpha) => `hsl(${hue} ${sl} / ${alpha})`;
    }
    const [groundL, groundC] = [Number(read('--ground-l')), Number(read('--ground-c'))];
    const [lampL, lampC, lampH] = [Number(read('--lamp-l')), Number(read('--lamp-c')), Number(read('--lamp-h'))];
    return (hue, warmth, sway, alpha) => {
      const ground = oklab(groundL, groundC, hue);
      const lamp = oklab(lampL, lampC, lampH + LAMP_SWAY * sway);
      const [l, a, b] = ground.map((g, i) => g + (lamp[i] - g) * warmth);
      return `oklab(${l} ${a} ${b} / ${alpha})`;
    };
  }

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
    const strength = Number(style.getPropertyValue('--circle-alpha'));
    const tint = paletteFrom(style);
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
      ring(cx, cy, radius, 1, tint(BREATH_HUE, 0, 0, strength * (0.6 + 0.15 * breath) * (1 - shown)));
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
      const hue = HUES[voice.index % HUES.length];
      const sounded = player.events.filter((ev) => ev.voice === voice.index);

      let sounding = 0;
      let sway = 0;
      for (const ev of sounded) {
        const age = now - ev.time;
        if (age < 0 || age > ev.dur) continue;
        const loud = Math.cbrt(loudnessAt(CONFIG.timbres[ev.timbre], age, ev.dur));
        if (loud > sounding) [sounding, sway] = [loud, noteSway(ev.time)];
      }
      // 小さい音はほのかに、大きい音はしっかり灯る。
      ring(cx, cy, home, 0.75 + 3 * sounding, tint(hue, sounding ** 2, sway, strength * (0.45 + 0.55 * sounding)));
      if (reducedMotion.matches) continue;

      const upcoming = { time: voice.next, dur: nominalLength(CONFIG.timbres[engine.timbre]), timbre: engine.timbre };
      for (const note of [...sounded, upcoming]) {
        const timbre = CONFIG.timbres[note.timbre];
        const sway = noteSway(note.time);
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
            // 現在の輪に重なるまでは地の色。重なった瞬間に灯り、外へ広がりながら冷める。
            tint(hue, away < 0 ? 0 : loud ** 2 * Math.max(0, 1 - away / COOL), sway, strength * shown * (0.3 + 0.7 * loud)),
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
    level() {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.max(...data.map(Math.abs));
    },
  };
})();
