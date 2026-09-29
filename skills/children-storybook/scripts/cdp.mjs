// Drive a Chromium-based browser over the DevTools Protocol, with no Playwright.
//
// Node 22+ ships a global WebSocket; everything else here is node:child_process, node:http
// and node:fs, so this file adds no dependency. The launch flags, the viewport override and
// the screenshot call deliberately mirror what Playwright issues (read out of
// playwright-core/lib/coreBundle.js), because the exporter must keep producing the same
// frames it did when Playwright drove the browser:
//
//   Emulation.setDeviceMetricsOverride({mobile:false, width, height, deviceScaleFactor:1, …})
//   Page.captureScreenshot({format:'png', clip:{x:0,y:0,width,height,scale:1},
//                           captureBeyondViewport:false})
//
// Note there is deliberately NO --force-device-scale-factor: Playwright controls scale
// through the emulation override, and passing both fights with each other.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const MAC_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
];
const UNIX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
const WINDOWS_NAMES = [
  'Google/Chrome/Application/chrome.exe',
  'Chromium/Application/chrome.exe',
  'Microsoft/Edge/Application/msedge.exe',
  'BraveSoftware/Brave-Browser/Application/brave.exe',
];

// Flags Playwright passes on every Chromium launch that affect rendering or long renders.
// Kept as data so they can be diffed against playwright-core rather than guessed at.
export const RENDER_FLAGS = [
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-ipc-flooding-protection',
  '--disable-dev-shm-usage',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--disable-sync',
  // Selects the Blink code path Playwright's screenshots go through.
  '--enable-features=CDPScreenshotNewSurface',
  // Permits a software WebGL fallback on a GPU-less box; it does not force one.
  '--enable-unsafe-swiftshader',
  '--force-color-profile=srgb',
  '--hide-scrollbars',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-sandbox',
  '--password-store=basic',
  '--use-mock-keychain',
  '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
];
// Only for the retry, when the first launch reported no WebGL at all.
const SOFTWARE_FLAGS = ['--use-gl=angle', '--use-angle=swiftshader'];

function executable(file) {
  try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
}

function onPath(names) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (executable(candidate)) return candidate;
    }
  }
  return null;
}

// Find a Chromium-based browser. An explicit path or CHROME_PATH always wins.
export function findBrowser(explicit) {
  const candidates = [explicit, process.env.CHROME_PATH].filter(Boolean);
  const tried = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    if (executable(candidate)) return candidate;
    if (!candidate.includes(path.sep)) {
      const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], { encoding: 'utf8' });
      if (found.status === 0) return found.stdout.split(/\r?\n/)[0].trim();
    }
  }
  if (process.platform === 'darwin') {
    for (const candidate of MAC_APPS) if (executable(candidate)) return candidate;
  } else if (process.platform === 'win32') {
    for (const root of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      for (const name of WINDOWS_NAMES) {
        const candidate = path.join(root, name);
        if (executable(candidate)) return candidate;
      }
    }
  }
  const named = onPath(UNIX_NAMES);
  if (named) return named;
  throw new Error(
    'No Chromium-based browser found. Rendering a video needs Chrome, Chromium, Edge or Brave.\n' +
    '  macOS:  brew install --cask google-chrome\n' +
    '  Linux:  apt install chromium   (or google-chrome-stable)\n' +
    `  Tried: ${[...tried, ...MAC_APPS, ...UNIX_NAMES].join(', ')}\n` +
    '  Point at one explicitly with --chrome <path> or CHROME_PATH=<path>.');
}

// The file's second line is the browser-level WebSocket path; only the first is used here.
function readDevToolsPort(profile, timeoutMs) {
  return new Promise((resolve, reject) => {
    const file = path.join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      try {
        const [port] = fs.readFileSync(file, 'utf8').split('\n');
        if (port) return resolve(Number(port));
      } catch { /* not written yet */ }
      if (Date.now() > deadline) return reject(new Error('The browser never exposed a debugging port.'));
      setTimeout(tick, 100);
    };
    tick();
  });
}

function getJson(port, route) {
  return new Promise((resolve, reject) => {
    // 127.0.0.1, never a hostname: Chrome rejects requests with an unexpected Host header.
    const request = http.get({ host: '127.0.0.1', port, path: route }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error(`Timed out on ${route}`)));
  });
}

async function pageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await getJson(port, '/json/list').catch(() => []);
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (page) return page;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The browser exposed no page target.');
}

// A minimal CDP client: request/response plus named event waiting.
export function connect(webSocketUrl, { timeoutMs = 60000 } = {}) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    for (const handler of listeners.get(message.method) || []) handler(message.params);
  });

  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not open the DevTools WebSocket.')), { once: true });
  });

  function send(method, params = {}, { timeout = timeoutMs } = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeout}ms`));
      }, timeout);
      pending.set(id, {
        method,
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  return { send, on: (method, handler) => listeners.set(method, [...(listeners.get(method) || []), handler]), ready, close: () => socket.close() };
}

// Width/height of a PNG, straight from the IHDR chunk.
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function makePage(client) {
  const consoleErrors = [];
  const pageErrors = [];
  let crashed = false;
  client.on('Runtime.consoleAPICalled', params => {
    if (params.type === 'error') consoleErrors.push(params.args.map(a => a.value ?? a.description ?? '').join(' '));
  });
  // A rejected promise under awaitPromise is reported HERE, not as a protocol error —
  // a driver that only checks response.error would treat a failure as success.
  client.on('Runtime.exceptionThrown', params => {
    pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'page error');
  });
  client.on('Inspector.targetCrashed', () => { crashed = true; });

  async function evaluate(expression, { awaitPromise = false } = {}) {
    const result = await client.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`Page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  return {
    client,
    consoleErrors,
    pageErrors,
    evaluate,
    get crashed() { return crashed; },
    get errors() { return [...consoleErrors, ...pageErrors]; },
    async viewport(width, height) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        mobile: false, width, height, screenWidth: width, screenHeight: height,
        deviceScaleFactor: 1, screenOrientation: { angle: 0, type: 'portraitPrimary' },
      });
      // Playwright sets this from its reducedMotion option; an OS "reduce motion" setting
      // would otherwise change qa screenshots taken mid page-turn.
      await client.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
      });
    },
    async goto(url) {
      await client.send('Page.navigate', { url });
      const deadline = Date.now() + 60000;
      // Poll rather than waiting on Page.loadEventFired, which can fire before we attach.
      while (Date.now() < deadline) {
        if (await evaluate('document.readyState') === 'complete') return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out loading ${url}`);
    },
    // Wait for two animation frames so WebGL presents the pose we just rendered before
    // the screenshot is taken. Without this the capture can show the previous frame.
    async settle() {
      await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', { awaitPromise: true });
    },
    async screenshot(width, height) {
      const params = { format: 'png', captureBeyondViewport: false };
      if (width && height) params.clip = { x: 0, y: 0, width, height, scale: 1 };
      const { data } = await client.send('Page.captureScreenshot', params);
      return Buffer.from(data, 'base64');
    },
    // Keyboard input, for driving the reader the way a person would.
    async press(key) {
      const codes = { ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 };
      const code = codes[key];
      if (!code) throw new Error(`Unsupported key: ${key}`);
      for (const type of ['rawKeyDown', 'keyUp']) {
        await client.send('Input.dispatchKeyEvent', {
          type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
        });
      }
    },
    webgl: () => evaluate(`(() => { try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return null;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        version: gl.getParameter(gl.VERSION),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        devicePixelRatio: window.devicePixelRatio,
      };
    } catch { return null; } })()`),
  };
}

async function startOnce(executable, profile, args, timeoutMs) {
  const child = spawn(executable, ['--headless=new', '--remote-debugging-port=0',
    ...RENDER_FLAGS, ...args, `--user-data-dir=${profile}`, '--window-size=1280,800', 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', () => {});
  let exited = null;
  child.once('exit', code => { exited = code; });
  try {
    const port = await readDevToolsPort(profile, timeoutMs).catch(error => {
      // Chrome hands its arguments to an already-running instance and exits; say so plainly.
      if (exited !== null) throw new Error(`The browser exited immediately (code ${exited}).`);
      throw error;
    });
    const target = await pageTarget(port, timeoutMs);
    return { child, port, target };
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\n${stderr.slice(-600)}`);
  }
}

// Launch a browser, connect to a page, enable the domains, and confirm WebGL works —
// retrying once with software rendering, since a headless box with no GPU otherwise
// yields blank frames instead of an error.
export async function openBrowser(options = {}) {
  const executable = findBrowser(options.chrome);
  const timeoutMs = options.timeoutMs || 30000;
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'storybook-cdp-'));
  const attempts = [
    { label: 'default', args: options.args || [] },
    { label: 'software rendering', args: [...SOFTWARE_FLAGS, ...(options.args || [])] },
  ];
  let lastError;
  try {
    for (const attempt of attempts) {
      let launched;
      try {
        launched = await startOnce(executable, profile, attempt.args, timeoutMs);
        const client = connect(launched.target.webSocketDebuggerUrl);
        await client.ready;
        // Enable before navigating, or exceptions thrown during module evaluation are missed.
        await client.send('Page.enable');
        await client.send('Runtime.enable');
        await client.send('Inspector.enable').catch(() => {});
        const page = makePage(client);
        const webgl = await page.webgl();
        if (!webgl) {
          client.close();
          launched.child.kill('SIGKILL');
          lastError = new Error(`No WebGL context was available (${attempt.label}).`);
          continue;
        }
        if (options.width && options.height) await page.viewport(options.width, options.height);
        const version = await client.send('Browser.getVersion').catch(() => null);
        let closed = false;
        return {
          page, webgl, executable, product: version?.product || null,
          protocolVersion: version?.protocolVersion || null,
          software: attempt.label !== 'default',
          flags: [...RENDER_FLAGS, ...attempt.args],
          async close() {
            if (closed) return;
            closed = true;
            client.close();
            launched.child.kill('SIGTERM');
            await Promise.race([new Promise(r => launched.child.once('close', r)), new Promise(r => setTimeout(r, 3000))]);
            if (launched.child.exitCode === null) launched.child.kill('SIGKILL');
            await fsp.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
          },
        };
      } catch (error) {
        lastError = error;
        launched?.child.kill('SIGKILL');
      }
    }
    throw lastError || new Error('Could not start a usable browser.');
  } catch (error) {
    await fsp.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    throw new Error(`Could not start a usable browser.\n${error.message}`);
  }
}
