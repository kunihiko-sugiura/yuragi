// @ts-check
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const chromePath = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'yuragi-verify-'));
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = false;
/**
 * @param {boolean} ok
 * @param {string} message
 */
const assert = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failed = true;
};

/** @returns {Promise<string>} */
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = /** @type {{ type: string, webSocketDebuggerUrl: string }[]} */ (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
      const page = targets.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('Chrome に接続できない');
}

try {
  const socket = new WebSocket(await connect());
  await new Promise((resolve) => (socket.onopen = resolve));
  let id = 0;
  /** @type {Map<number, (result: any) => void>} */
  const pending = new Map();
  /** @type {string[]} */
  const problems = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) pending.get(message.id)?.(message.result ?? message.error);
    if (message.method === 'Runtime.exceptionThrown') problems.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') problems.push(message.params.args.map((/** @type {{ value?: unknown, description?: string }} */ a) => a.value ?? a.description).join(' '));
  };
  /**
   * Chrome DevTools Protocol のコマンドを送り、結果を待つ。
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  const send = (method, params = {}) => new Promise((resolve) => {
    pending.set(++id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  /**
   * @param {string} expression ページ内で評価する式
   * @returns {Promise<any>}
   */
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  /**
   * @param {string} file
   * @param {string} [query]
   */
  const open = async (file, query = '') => {
    await send('Page.navigate', { url: pathToFileURL(join(here, file)).href + query });
    await sleep(500);
  };
  /** @param {string} selector */
  const click = async (selector) => {
    const { x, y } = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  };
  /** @param {string} name */
  const shot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(here, 'verify-out', name), Buffer.from(data, 'base64'));
  };

  await send('Page.enable');
  await send('Runtime.enable');

  await open('verify.html', `?seconds=${process.env.SECONDS || 300}`);
  for (let i = 0; i < 2400 && (await evaluate('document.title')) === 'running'; i++) await sleep(500);
  const text = await evaluate('document.getElementById("out").textContent');
  const title = await evaluate('document.title');
  if (title === 'pass' || title === 'fail') {
    const report = JSON.parse(text);
    for (const c of report.checks) assert(c.ok, `${c.name}${c.detail === undefined ? '' : ` [${c.detail}]`}`);
    console.log(JSON.stringify({ piano: report.piano, pad: report.pad, pianoNote: report.pianoNote, pianoSoftNote: report.pianoSoftNote }, null, 2));
  } else {
    assert(false, `オフライン検証が完走しない: ${text}`);
  }

  if (process.argv.includes('--live')) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(here, 'verify-out'), { recursive: true });
    await open('index.html');
    assert((await evaluate('document.querySelectorAll("button").length')) === 2, '操作は音色の 2 つだけ');
    assert((await evaluate('window.__yuragi.context.state')) === 'suspended', '操作前はブラウザが発音を止めている');
    await shot('waiting.png');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 300, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 300, button: 'left', clickCount: 1 });
    await sleep(3000);
    const t1 = await evaluate('[window.__yuragi.context.currentTime, performance.now()]');
    await sleep(4000);
    const t2 = await evaluate('[window.__yuragi.context.currentTime, performance.now()]');
    const speed = (t2[0] - t1[0]) / ((t2[1] - t1[1]) / 1000);
    assert(speed > 0.97 && speed < 1.03, `音声時計が実時間と同じ速さで進む（処理落ちなし） [${speed.toFixed(3)}x, 起動遅延 ${(t1[1] / 1000 - t1[0]).toFixed(2)}s 以下]`);
    const playing = await evaluate('({ audio: window.__yuragi.context.state, time: window.__yuragi.context.currentTime, played: window.__yuragi.played, level: window.__yuragi.level() })');
    assert(playing.audio === 'running' && playing.time > 3, `画面のどこかに触れると AudioContext が進む ${JSON.stringify(playing)}`);
    assert(playing.played > 0 && playing.level > 0, '再生中に発音があり、出力レベルが 0 でない');
    await shot('playing-piano.png');
    await click('#timbre-pad');
    await sleep(9000);
    const pad = await evaluate('({ timbres: [...new Set(window.__yuragi.events.map((e) => e.timbre))], pressed: document.querySelector("#timbre-pad").getAttribute("aria-pressed") })');
    assert(pad.pressed === 'true' && pad.timbres.includes('pad'), `パッドへ切替後の新しい音がパッドになる ${JSON.stringify(pad)}`);
    await shot('playing-pad.png');
  }

  assert(problems.length === 0, `コンソールエラー・例外がない ${problems.join(' | ')}`);
  socket.close();
} finally {
  chrome.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
