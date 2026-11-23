// @ts-check
(function (global) {
  'use strict';

  /** @type {Config} */
  const CONFIG = {
    rootHz: 138.591,
    tuning: 'et',
    tunings: {
      et: { Db: 1, Eb: 2 ** (2 / 12), F: 2 ** (4 / 12), Ab: 2 ** (7 / 12), Bb: 2 ** (9 / 12) },
      just: { Db: 1, Eb: 9 / 8, F: 5 / 4, Ab: 3 / 2, Bb: 5 / 3 },
      pyth: { Db: 1, Eb: 9 / 8, F: 81 / 64, Ab: 3 / 2, Bb: 27 / 16 },
    },
    voices: [
      { name: 'F3', degree: 'F', octave: 0, period: 17.3, x: 0.3, y: 0.68, size: 1.25 },
      { name: 'A♭3', degree: 'Ab', octave: 0, period: 19.7, x: 0.63, y: 0.74, size: 1.15 },
      { name: 'B♭3', degree: 'Bb', octave: 0, period: 23.1, x: 0.46, y: 0.52, size: 1.05 },
      { name: 'D♭4', degree: 'Db', octave: 1, period: 26.3, x: 0.73, y: 0.43, size: 0.95 },
      { name: 'E♭4', degree: 'Eb', octave: 1, period: 29.9, x: 0.27, y: 0.35, size: 0.88 },
      { name: 'A♭4', degree: 'Ab', octave: 1, period: 31.7, x: 0.55, y: 0.23, size: 0.8 },
    ],
    timbres: {
      piano: {
        octave: 1,
        partials: 8,
        rolloff: 1.6,
        inharmonicity: 0.0003,
        attack: 0.006,
        hold: 3.5,
        release: 3.0,
        decay: { prompt60: 1.6, after60: 12, after: 0.3, tilt: 0.8 },
        cutoff: 10,
        beatHz: [0.05, 0.3],
        unison: 0.25,
        drift: { shared: 0.5, layer: 0.1 },
        level: 0.55,
        visualScale: 0.55,
      },
      pianoSoft: {
        octave: 1,
        partials: 6,
        rolloff: 1.5,
        inharmonicity: 0.0003,
        attack: 0.03,
        hold: 0,
        release: 5.0,
        decay: { prompt60: 5.0, after60: 5.0, after: 0, tilt: 0.6 },
        cutoff: 6,
        beatHz: [0.1, 0.5],
        unison: 1,
        drift: { shared: 4, layer: 0.8 },
        level: 0.45,
        visualScale: 0.55,
      },
      pad: {
        octave: 0,
        partials: 5,
        rolloff: 2.0,
        inharmonicity: 0,
        attack: 3.5,
        hold: 2.0,
        release: 7.0,
        decay: null,
        cutoff: 4,
        beatHz: [0.08, 0.35],
        unison: 1,
        drift: { shared: 4, layer: 0.8 },
        level: 0.17,
        visualScale: 1.5,
      },
      bell: {
        octave: 1,
        partials: 4,
        // 両端自由の棒の振動モード。整数倍から外れた倍音が、ガラスや鉄琴の澄んだ響きになる。
        ratios: [1, 2.756, 5.404, 8.933],
        rolloff: 1.3,
        inharmonicity: 0,
        attack: 0.003,
        hold: 0,
        release: 9.0,
        decay: { prompt60: 3.0, after60: 14, after: 0.35, tilt: 1.2 },
        cutoff: 12,
        beatHz: [0.2, 0.8],
        unison: 0.35,
        drift: { shared: 0.3, layer: 0.05 },
        level: 0.4,
        visualScale: 0.5,
      },
    },
    yuragi: {
      partialDb: 1.5,
      noteDb: 2,
      cutoff: 0.15,
      length: 0.1,
      period: 0.005,
      noiseTopHz: 1.0,
      noiseOctaves: 6,
    },
    reverb: { seconds: 6, preDelay: 0.025, wet: 0.7, dry: 0.6 },
    scheduler: { lookahead: 2, tick: 0.25, lead: 0.1 },
    curveRate: { envelope: 1000, partial: 200, slow: 20 },
  };

  /** 三角分布の乱数（-1〜1） */
  const tri = () => Math.random() + Math.random() - 1;
  /** @param {number} db */
  const dbToGain = (db) => 10 ** (db / 20);

  // オクターブ間隔の値ノイズを等振幅で足すと、パワーがおよそ1/fになる。
  /**
   * @param {number} seconds
   * @param {number} rate 1秒あたりの点数
   * @param {YuragiConfig} y
   * @returns {Float32Array} -1〜1 の曲線
   */
  function pinkCurve(seconds, rate, y) {
    const n = Math.max(2, Math.ceil(seconds * rate) + 1);
    const out = new Float32Array(n);
    for (let j = 0; j < y.noiseOctaves; j++) {
      const hz = y.noiseTopHz / 2 ** j;
      const knots = Math.ceil(seconds * hz) + 3;
      const values = Array.from({ length: knots }, () => Math.random() * 2 - 1);
      const phase = Math.random();
      for (let i = 0; i < n; i++) {
        const p = (i / rate) * hz + phase;
        const k = Math.floor(p);
        const f = p - k;
        const s = f * f * (3 - 2 * f);
        out[i] += values[k] + (values[k + 1] - values[k]) * s;
      }
    }
    const unit = 0.577 * Math.sqrt(y.noiseOctaves);
    for (let i = 0; i < n; i++) out[i] = Math.tanh((out[i] / unit) * 0.6);
    return out;
  }

  /** @param {Timbre} timbre */
  function nominalLength(timbre) {
    return timbre.attack + timbre.hold + timbre.release;
  }

  /**
   * @param {Timbre} timbre
   * @param {number} t 発音からの経過秒
   * @param {number} dur 音の長さ（秒）
   */
  function shapeAt(timbre, t, dur) {
    if (t <= 0 || t >= dur) return 0;
    const s = dur / nominalLength(timbre);
    const attack = timbre.attack * s;
    const fallStart = (timbre.attack + timbre.hold) * s;
    if (t < attack) return 0.5 - 0.5 * Math.cos((Math.PI * t) / attack);
    if (t < fallStart) return 1;
    const x = (t - fallStart) / (dur - fallStart);
    return (0.5 + 0.5 * Math.cos(Math.PI * x)) ** 1.5;
  }

  // 打鍵直後に速く落ち、その後長く残る二段の減衰。ピアノでは複数の弦が
  // 駒を介して結合するために起きる。高い倍音ほど両方の段が速い。
  /**
   * @param {Timbre} timbre
   * @param {number} t 発音からの経過秒
   * @param {number} k 倍音の番号（1 が基音）
   * @param {number} stretch 公称長に対する実際の長さの比
   */
  function decayAt(timbre, t, k, stretch) {
    const d = timbre.decay;
    if (!d) return 1;
    const scale = 6.908 * k ** d.tilt / stretch;
    return (1 - d.after) * Math.exp((-scale * t) / d.prompt60) + d.after * Math.exp((-scale * t) / d.after60);
  }

  /**
   * @param {Timbre} timbre
   * @param {number} t
   * @param {number} dur
   */
  function loudnessAt(timbre, t, dur) {
    return shapeAt(timbre, t, dur) * decayAt(timbre, t, 1, dur / nominalLength(timbre));
  }

  /**
   * @param {BaseAudioContext} ctx
   * @param {ReverbConfig} reverb
   */
  function makeImpulse(ctx, reverb) {
    const rate = ctx.sampleRate;
    const length = Math.ceil((reverb.seconds + reverb.preDelay) * rate);
    const pre = Math.floor(reverb.preDelay * rate);
    const buffer = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let low = 0;
      for (let i = pre; i < length; i++) {
        const t = (i - pre) / rate;
        // 高域ほど早く減衰させる。残響の後半が暗くなり、金属的な響きを避けられる。
        const damping = 0.25 + 0.7 * Math.min(1, t / reverb.seconds);
        low += (1 - damping) * (Math.random() * 2 - 1 - low);
        const onset = Math.min(1, t / 0.005);
        data[i] = low * onset * 10 ** ((-3 * t) / reverb.seconds);
      }
    }
    return buffer;
  }

  // 6声部のピークが偶然そろったときだけ働く保険。0.7未満の信号には触れない。
  /**
   * @param {BaseAudioContext} ctx
   * @returns {GainNode} ここへつなぐと destination へ出る
   */
  function softClip(ctx) {
    const knee = 0.7;
    const curve = new Float32Array(4097);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / 2048 - 1) * 2;
      const over = Math.abs(x) - knee;
      curve[i] = over <= 0 ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh(over / (1 - knee)));
    }
    // WaveShaperの入力域は±1。曲線を±2まで定義したので、手前で半分にして合わせる。
    const input = ctx.createGain();
    input.gain.value = 0.5;
    const shaper = ctx.createWaveShaper();
    shaper.curve = curve;
    input.connect(shaper).connect(ctx.destination);
    return input;
  }

  /**
   * @param {BaseAudioContext} ctx
   * @param {AudioNode} destination
   * @param {NoteEvent} ev
   * @param {Config} config
   */
  function renderNote(ctx, destination, ev, config) {
    const timbre = config.timbres[ev.timbre];
    const y = config.yuragi;
    const rate = config.curveRate;
    const { time, dur } = ev;
    const end = time + dur + 0.05;
    const f0 = ev.freq * 2 ** timbre.octave;
    const stretch = dur / nominalLength(timbre);

    const envelope = new Float32Array(Math.ceil(dur * rate.envelope) + 1);
    const peak = timbre.level * dbToGain(ev.gainDb);
    for (let i = 0; i < envelope.length; i++) {
      envelope[i] = peak * shapeAt(timbre, i / rate.envelope, dur);
    }
    const noteGain = ctx.createGain();
    noteGain.gain.value = 0;
    noteGain.gain.setValueCurveAtTime(envelope, time, dur);
    noteGain.connect(destination);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.4;
    filter.frequency.value = Math.min(f0 * timbre.cutoff * ev.cutoffMul, ctx.sampleRate * 0.45);
    filter.connect(noteGain);

    const shared = pinkCurve(dur, rate.slow, y);
    /** @type {[sign: number, weight: number][]} */
    const pairs = [[-1, 1], [1, timbre.unison]];
    const layers = pairs.map(([sign, weight]) => {
      const own = pinkCurve(dur, rate.slow, y);
      const cents = shared.map((v, i) => v * timbre.drift.shared + own[i] * timbre.drift.layer);
      const source = ctx.createConstantSource();
      source.offset.value = 0;
      source.offset.setValueCurveAtTime(cents, time, dur);
      source.start(time);
      source.stop(end);
      return { sign, weight, source };
    });

    let total = 0;
    for (let k = 1; k <= timbre.partials; k++) total += k ** -timbre.rolloff;

    for (let k = 1; k <= timbre.partials; k++) {
      const hz = timbre.ratios ? timbre.ratios[k - 1] * f0 : k * f0 * Math.sqrt(1 + timbre.inharmonicity * k * k);
      if (hz > ctx.sampleRate * 0.45) break;
      const amp = k ** -timbre.rolloff / total / (1 + timbre.unison);
      const wobble = pinkCurve(dur, rate.partial, y);
      const curve = wobble.map((v, i) => amp * dbToGain(v * y.partialDb) * decayAt(timbre, i / rate.partial, k, stretch));
      const partialGain = ctx.createGain();
      partialGain.gain.value = 0;
      partialGain.gain.setValueCurveAtTime(curve, time, dur);
      partialGain.connect(filter);

      // うなりをcentではなくHzで決める。centだと高い倍音ほど速くうなり、ざらつく。
      const beat = timbre.beatHz[0] + Math.random() * (timbre.beatHz[1] - timbre.beatHz[0]);
      for (const layer of layers) {
        const osc = ctx.createOscillator();
        osc.frequency.value = hz + (layer.sign * beat) / 2;
        layer.source.connect(osc.detune);
        if (layer.weight === 1) {
          osc.connect(partialGain);
        } else {
          // 2本目を弱くして、うなりを浅くする。等量だと音量が周期的に0近くまで沈む。
          const weight = ctx.createGain();
          weight.gain.value = layer.weight;
          osc.connect(weight).connect(partialGain);
        }
        osc.start(time);
        osc.stop(end);
      }
    }
  }

  /**
   * @template {object} T
   * @param {T} obj
   * @param {unknown} key
   * @returns {key is keyof T}
   */
  const hasKey = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);

  /**
   * @param {BaseAudioContext} ctx
   * @param {EngineOptions} [options]
   * @returns {Engine}
   */
  function createEngine(ctx, options = {}) {
    const config = options.config || CONFIG;
    const ratios = hasKey(config.tunings, options.tuning) ? config.tunings[options.tuning] : config.tunings[config.tuning];
    /** @type {TimbreName} */
    let timbreName = options.timbre || 'piano';

    const master = ctx.createGain();
    master.connect(softClip(ctx));
    const input = ctx.createGain();
    const dry = ctx.createGain();
    dry.gain.value = config.reverb.dry;
    const wet = ctx.createGain();
    wet.gain.value = options.reverb === false ? 0 : config.reverb.wet;
    const convolver = ctx.createConvolver();
    convolver.buffer = makeImpulse(ctx, config.reverb);
    input.connect(dry).connect(master);
    input.connect(convolver).connect(wet).connect(master);

    /** @type {Voice[]} */
    const voices = config.voices.map((voice, index) => ({
      ...voice,
      index,
      freq: config.rootHz * ratios[voice.degree] * 2 ** voice.octave,
      next: 0,
      jitter: 0,
    }));

    /** @param {number} time */
    function start(time) {
      for (const voice of voices) voice.next = time + Math.random() * voice.period;
      // 開始直後の長い無音は故障に見える。1声部だけ即座に鳴らす。
      voices[Math.floor(Math.random() * voices.length)].next = time;
    }

    /**
     * @param {number} until この時刻より前の発音をすべて予約する
     * @returns {NoteEvent[]} 新たに予約したイベント
     */
    function scheduleUntil(until) {
      const y = config.yuragi;
      /** @type {NoteEvent[]} */
      const created = [];
      for (const voice of voices) {
        while (voice.next < until) {
          // スリープ復帰後などに、遅れた分をまとめて鳴らさない。
          if (voice.next >= ctx.currentTime) {
            const timbre = config.timbres[timbreName];
            /** @type {NoteEvent} */
            const ev = {
              voice: voice.index,
              timbre: timbreName,
              time: voice.next,
              freq: voice.freq,
              dur: nominalLength(timbre) * (1 + tri() * y.length),
              gainDb: tri() * y.noteDb,
              cutoffMul: 1 + tri() * y.cutoff,
            };
            renderNote(ctx, input, ev, config);
            created.push(ev);
          }
          voice.jitter = Math.max(-1, Math.min(1, voice.jitter * 0.7 + tri() * 0.5));
          voice.next += voice.period * (1 + voice.jitter * y.period);
        }
      }
      return created;
    }

    return {
      master,
      voices,
      start,
      scheduleUntil,
      get timbre() {
        return timbreName;
      },
      set timbre(name) {
        if (hasKey(config.timbres, name)) timbreName = name;
      },
    };
  }

  /** @type {YuragiApi} */
  global.Yuragi = { CONFIG, createEngine, renderNote, loudnessAt, nominalLength };
})(window);
