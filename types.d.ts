// engine.js / app.js / verify-page.js が JSDoc から参照する型。
// ブラウザはこのファイルを読まない。型検査（npm run typecheck）専用。

type Degree = 'Db' | 'Eb' | 'F' | 'Ab' | 'Bb';
type TuningName = 'et' | 'just' | 'pyth';
type TimbreName = 'piano' | 'pianoSoft' | 'pad' | 'bell';

/** 主音（Db）に対する周波数比 */
type Ratios = Record<Degree, number>;

interface VoiceSpec {
  name: string;
  degree: Degree;
  octave: number;
  /** 公称の発音周期（秒） */
  period: number;
  /** 画面上の位置（0〜1） */
  x: number;
  y: number;
  size: number;
}

interface Decay {
  prompt60: number;
  after60: number;
  after: number;
  tilt: number;
}

interface Timbre {
  octave: number;
  partials: number;
  /** 基音に対する各倍音の周波数比。あれば整数倍と inharmonicity の代わりに使う（長さは partials 以上） */
  ratios?: number[];
  rolloff: number;
  inharmonicity: number;
  attack: number;
  hold: number;
  release: number;
  /** null なら減衰なし（パッド） */
  decay: Decay | null;
  /** 基音の何倍でローパスをかけるか */
  cutoff: number;
  beatHz: [number, number];
  unison: number;
  drift: { shared: number; layer: number };
  level: number;
  visualScale: number;
}

interface YuragiConfig {
  partialDb: number;
  noteDb: number;
  cutoff: number;
  length: number;
  period: number;
  noiseTopHz: number;
  noiseOctaves: number;
}

interface ReverbConfig {
  seconds: number;
  preDelay: number;
  wet: number;
  dry: number;
}

interface Config {
  rootHz: number;
  tuning: TuningName;
  tunings: Record<TuningName, Ratios>;
  voices: VoiceSpec[];
  timbres: Record<TimbreName, Timbre>;
  yuragi: YuragiConfig;
  reverb: ReverbConfig;
  scheduler: { lookahead: number; tick: number; lead: number };
  curveRate: { envelope: number; partial: number; slow: number };
}

/** 1音分の発音イベント */
interface NoteEvent {
  voice: number;
  timbre: TimbreName;
  time: number;
  freq: number;
  dur: number;
  gainDb: number;
  cutoffMul: number;
}

interface Voice extends VoiceSpec {
  index: number;
  freq: number;
  next: number;
  jitter: number;
}

interface EngineOptions {
  config?: Config;
  /** URL から渡るので任意の文字列。未知の値は CONFIG.tuning にフォールバックする */
  tuning?: string | null;
  timbre?: TimbreName;
  /** false で残響を切る（検証用） */
  reverb?: boolean;
}

interface Engine {
  readonly master: GainNode;
  readonly voices: Voice[];
  start(time: number): void;
  scheduleUntil(until: number): NoteEvent[];
  timbre: TimbreName;
}

interface YuragiApi {
  CONFIG: Config;
  createEngine(ctx: BaseAudioContext, options?: EngineOptions): Engine;
  renderNote(ctx: BaseAudioContext, destination: AudioNode, ev: NoteEvent, config: Config): void;
  loudnessAt(timbre: Timbre, t: number, dur: number): number;
  nominalLength(timbre: Timbre): number;
}

/** verify.mjs が index.html の状態を覗くための窓口 */
interface DebugHandle {
  readonly context: AudioContext;
  readonly events: NoteEvent[];
  readonly played: number;
  level(): number;
}

declare var Yuragi: YuragiApi;
declare var __yuragi: DebugHandle;
