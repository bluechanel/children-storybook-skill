// The Three.js flipbook reader, as a mountable unit.
//
// It lives in the skill so that the committed prebuilt bundle (renderer/book.js) and the
// host app's dev server render from exactly the same source — there is no second copy to
// drift. The story arrives as an argument: this file never imports a particular story.
import * as THREE from 'three';
import './style.css';
import { NarrationPlayer } from './narration-player.js';
import { poseAt, validateTimeline, DEFAULT_DISCLOSURE } from '../../scripts/media-core.mjs';
import { buildShell } from './shell.js';

const mountedRoots = new WeakSet();

async function stylesReady() {
  // Measure only after the stylesheet is applied: #scene's box decides camera.aspect, and
  // a link created or still loading would make it 0 or the wrong height.
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  await Promise.all(links.map(link => link.sheet
    ? Promise.resolve()
    : new Promise(resolve => {
      link.addEventListener('load', resolve, { once: true });
      link.addEventListener('error', resolve, { once: true });
    })));
}

export async function mount(options = {}) {
  const { bookContent, narrationConfig = { url: null } } = options;
  if (!bookContent?.sheets?.length) throw new Error('mount() needs bookContent with sheets.');

  const root = options.root || document.getElementById('app');
  if (!root) throw new Error('mount() found no #app element to mount into.');
  if (mountedRoots.has(root)) throw new Error('This element already has a mounted book; unmount it first.');
  mountedRoots.add(root);
  buildShell(root);

  const exportMode = options.exportMode ?? new URLSearchParams(location.search).has('export');
  if (exportMode) document.body.classList.add('export-mode');
  await stylesReady();
  await document.fonts.ready.catch(() => {});

  const imageLoads = [];
  const imageErrors = [];
  let managedPlayback = false;
  let exportTimeline = null;
  let player;

  const $ = (id) => document.getElementById(id);
  const W = 2.55, H = 3.45, SEGMENTS = 48, ROWS = 12;
  const COUNT = bookContent.sheets.length;
  const reducedMotion = !exportMode && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const settings = { turnDuration: reducedMotion ? 100 : 1350, demoDelay: 2600, curl: 0.62 };
  let current = 0, target = 0, turn = null, drag = null, autoplay = false, demoTimer;
  let bookPosition = -W / 2, openness = 0, lastTime = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  // Keep the camera perpendicular to the book: top and bottom edges stay equal.
  camera.position.set(0, 0, 12.5);
  camera.lookAt(0, 0, 0);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    $('scene').innerHTML = '<p class="error">当前浏览器无法开启 WebGL，请在支持硬件加速的浏览器中打开。</p>';
    mountedRoots.delete(root);
    throw new Error('WebGL is required to render the book.');
  }
  renderer.setPixelRatio(exportMode ? 1 : Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  $('scene').appendChild(renderer.domElement);
  scene.add(new THREE.AmbientLight(0xf5ede0, 1.4));
  const key = new THREE.DirectionalLight(0xffeed9, 2.0);
  key.position.set(-3, 6, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, near: 0.5, far: 25 });
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.015;
  key.shadow.radius = 4;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xb6c9db, 0.7);
  fill.position.set(5, -1, 4);
  scene.add(fill);
  const book = new THREE.Group();
  scene.add(book);

  function makeTexture(data, back = false) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024; canvas.height = 1400;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (back) { texture.wrapS = THREE.RepeatWrapping; texture.repeat.x = -1; texture.offset.x = 1; }
    function paint(img) {
      ctx.fillStyle = data.cover ? '#b7d5d9' : '#f8f0df';
      ctx.fillRect(0, 0, 1024, 1400);
      // Fine, deterministic paper grain; blank artwork stays intentionally blank.
      let seed = 42;
      for (let i = 0; i < 26000; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const x = seed % 1024;
        seed = (seed * 1664525 + 1013904223) >>> 0;
        ctx.fillStyle = i % 2 ? 'rgba(110,85,55,.025)' : 'rgba(255,255,245,.06)';
        ctx.fillRect(x, seed % 1400, 1, 1);
      }
      if (img) {
        const scale = Math.max(1024 / img.width, 1400 / img.height);
        ctx.drawImage(img, (1024 - img.width * scale) / 2, (1400 - img.height * scale) / 2, img.width * scale, img.height * scale);
      } else if (data.cover) {
        ctx.textAlign = 'center';
        // A simple, friendly cover; illustration areas remain empty.
        ctx.fillStyle = '#f8f0df';
        ctx.beginPath(); ctx.roundRect(140, 320, 744, 700, 150); ctx.fill();
        ctx.fillStyle = '#345e87';
        ctx.font = data.end ? 'bold 78px "PingFang SC", sans-serif' : 'bold 106px "PingFang SC", sans-serif';
        ctx.fillText(data.title, 512, 655);
        ctx.font = '36px "PingFang SC", sans-serif';
        ctx.fillText(data.subtitle, 512, 753);
        for (const [x, y, radius, color] of [[330, 888, 15, '#d4b896'], [512, 904, 20, '#b7d5d9'], [695, 888, 15, '#d4b896']]) {
          ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.fillStyle = '#9e9586'; ctx.font = '24px "PingFang SC", sans-serif';
        ctx.textAlign = 'center'; ctx.fillText(data.number ?? '', 512, 1318);
      }
      const gradient = ctx.createLinearGradient(back ? 1024 : 0, 0, back ? 890 : 134, 0);
      gradient.addColorStop(0, 'rgba(63,43,24,.16)'); gradient.addColorStop(0.22, 'rgba(63,43,24,.06)'); gradient.addColorStop(1, 'rgba(63,43,24,0)');
      ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1024, 1400);
      texture.needsUpdate = true;
    }
    paint();
    if (data.image) {
      imageLoads.push(new Promise(resolve => {
        const img = new Image(); img.onload = () => { paint(img); resolve(); };
        img.onerror = () => { imageErrors.push(data.image); console.warn(`图片加载失败，保留空白页：${data.image}`); resolve(); };
        img.src = data.image;
      }));
    }
    return texture;
  }

  const sheets = bookContent.sheets.map((data, index) => {
    const geometry = new THREE.PlaneGeometry(W, H, SEGMENTS, ROWS);
    const front = new THREE.MeshStandardMaterial({ map: makeTexture(data.front), roughness: 0.92, side: THREE.FrontSide });
    const back = new THREE.MeshStandardMaterial({ map: makeTexture(data.back, true), roughness: 0.92, side: THREE.BackSide });
    const mesh = new THREE.Mesh(geometry, front);
    const reverse = new THREE.Mesh(geometry, back);
    mesh.castShadow = true; mesh.receiveShadow = true;
    reverse.castShadow = true; reverse.receiveShadow = true;
    book.add(mesh, reverse);
    // Thin perimeter makes the board and paper thickness visible at grazing angles.
    const edgeGeo = new THREE.BufferGeometry();
    edgeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEGMENTS * 4 + ROWS * 2) * 3), 3));
    const edge = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: index === 0 || index === COUNT - 1 ? 0x9b8563 : 0xc9baa0, transparent: true, opacity: 0.65 }));
    book.add(edge);
    return { geometry, mesh, reverse, edge, progress: 0 };
  });

  // A continuous curved surface: the spine rotates first, while the outer edge lags.
  // Integrating local tangent angles keeps each paper strip the same length.
  function deform(sheet, index, p) {
    const pos = sheet.geometry.attributes.position;
    const bend = Math.sin(p * Math.PI);
    const isBoard = index === 0 || index === COUNT - 1;
    const curl = settings.curl * (isBoard ? 0.3 : 1);
    const baseAngle = p * Math.PI;
    const stackRight = (COUNT - index) * 0.032;
    const stackLeft = index * 0.032;
    const zBase = THREE.MathUtils.lerp(stackRight, stackLeft, p);
    const xs = [0], zs = [zBase];
    for (let col = 1; col <= SEGMENTS; col++) {
      const t = (col - 0.5) / SEGMENTS;
      const angle = baseAngle + curl * bend * Math.sin(t * Math.PI * 1.2) + (1 - bend) * (p < 0.5 ? 0.035 : -0.035) * Math.cos(t * Math.PI);
      xs[col] = xs[col - 1] + Math.cos(angle) * W / SEGMENTS;
      zs[col] = zs[col - 1] + Math.sin(angle) * W / SEGMENTS;
    }
    for (let row = 0; row <= ROWS; row++) {
      const y = H / 2 - row / ROWS * H;
      for (let col = 0; col <= SEGMENTS; col++) {
        const i = row * (SEGMENTS + 1) + col;
        const t = col / SEGMENTS;
        const edgeOffset = Math.cos(baseAngle) * t * THREE.MathUtils.lerp(index, COUNT - 1 - index, p) * 0.025;
        pos.setXYZ(i, xs[col] + edgeOffset, y, zs[col] + bend * Math.sin(t * Math.PI) * Math.pow(y / H, 2) * 0.11);
      }
    }
    pos.needsUpdate = true;
    sheet.geometry.computeVertexNormals();
    sheet.geometry.computeBoundingSphere();
    const edgePos = sheet.edge.geometry.attributes.position;
    let n = 0;
    function segment(a, b) { edgePos.setXYZ(n++, pos.getX(a), pos.getY(a), pos.getZ(a)); edgePos.setXYZ(n++, pos.getX(b), pos.getY(b), pos.getZ(b)); }
    for (let col = 0; col < SEGMENTS; col++) {
      segment(col, col + 1);
      segment(ROWS * (SEGMENTS + 1) + col, ROWS * (SEGMENTS + 1) + col + 1);
    }
    for (let row = 0; row < ROWS; row++) segment(row * (SEGMENTS + 1) + SEGMENTS, (row + 1) * (SEGMENTS + 1) + SEGMENTS);
    edgePos.needsUpdate = true;
    sheet.edge.geometry.computeBoundingSphere();
    sheet.progress = p;
  }
  sheets.forEach((sheet, i) => deform(sheet, i, 0));

  const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
  const shadowCtx = shadowCanvas.getContext('2d');
  const shade = shadowCtx.createRadialGradient(64, 64, 4, 64, 64, 64);
  shade.addColorStop(0, 'rgba(89,72,49,.18)'); shade.addColorStop(1, 'rgba(0,0,0,0)');
  shadowCtx.fillStyle = shade; shadowCtx.fillRect(0, 0, 128, 128);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(7.5, 2.2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shadowCanvas), transparent: true, depthWrite: false }));
  shadow.position.set(0, -2.15, -0.4); shadow.rotation.x = -Math.PI / 2.5; scene.add(shadow);

  for (let i = 0; i <= COUNT; i++) {
    const dot = document.createElement('button'); dot.className = 'page-dot';
    dot.setAttribute('aria-label', bookContent.chapters[i]);
    dot.addEventListener('click', () => { stopDemo(); goTo(i); });
    $('pagination').appendChild(dot);
  }
  function updateUI() {
    $('prev').disabled = target === 0;
    $('next').disabled = target === COUNT;
    $('chapter').textContent = bookContent.chapters[target];
    document.body.classList.toggle('open', target > 0 && target < COUNT);
    [...$('pagination').children].forEach((dot, i) => { dot.classList.toggle('active', i === target); dot.setAttribute('aria-current', i === target ? 'step' : 'false'); });
  }
  function goTo(index) {
    target = Math.max(0, Math.min(COUNT, index));
    updateUI();
  }
  function beginTurn(index, from, to, now) {
    turn = { index, from, to, start: now, duration: settings.turnDuration * Math.max(0.25, Math.abs(to - from)) };
  }
  function stopDemo() {
    player?.stop();
    if (managedPlayback) {
      managedPlayback = false; turn = null;
      sheets.forEach((sheet, i) => deform(sheet, i, i < current ? 1 : 0));
    }
    autoplay = false; clearTimeout(demoTimer);
    $('play').classList.remove('playing');
    $('play').setAttribute('aria-label', player?.ready ? '播放故事' : '自动翻页');
    $('play').setAttribute('aria-pressed', 'false');
    $('play').title = player?.ready ? '播放故事（AI 配音）' : '自动翻页（暂未配音）';
  }
  function scheduleDemo() {
    clearTimeout(demoTimer);
    if (!autoplay) return;
    demoTimer = setTimeout(() => {
      if (!autoplay) return;
      if (turn || current !== target || drag) { scheduleDemo(); return; }
      goTo(current === COUNT ? 0 : current + 1); scheduleDemo();
    }, settings.demoDelay);
  }
  function mediaMessage(text) {
    $('media-status').textContent = text;
    $('media-status').hidden = !text;
  }
  player = new NarrationPlayer(bookContent, () => {
    $('ai-disclosure').hidden = !player.ready;
    if (player.status === 'error') mediaMessage('配音暂不可用，请重新生成或加载。');
    if (player.status === 'ready') mediaMessage('');
    if (player.status === 'ended') { autoplay = false; $('play').classList.remove('playing'); $('play').setAttribute('aria-pressed', 'false'); $('play').setAttribute('aria-label', '重播故事'); }
    $('play').title = player.ready ? '播放故事（AI 配音）' : '自动翻页（暂未配音）';
  });
  if (!exportMode) player.load(narrationConfig.url);
  $('play').addEventListener('click', async () => {
    if (player.ready) {
      if (player.status === 'playing') {
        player.pause(); autoplay = false;
        $('play').classList.remove('playing'); $('play').setAttribute('aria-pressed', 'false');
        $('play').setAttribute('aria-label', '继续朗读'); return;
      }
      if (player.status !== 'paused' && (turn || drag || current !== target)) { mediaMessage('翻页完成后即可朗读'); return; }
      if (await player.play(current === COUNT ? 0 : current)) {
        managedPlayback = true; autoplay = true;
        $('play').classList.add('playing'); $('play').setAttribute('aria-pressed', 'true');
        $('play').setAttribute('aria-label', '暂停朗读'); mediaMessage('');
      }
      return;
    }
    if (player.status === 'loading') { mediaMessage('正在准备配音…'); return; }
    if (player.status === 'error') { mediaMessage('配音暂不可用，仍可手动翻页。'); return; }
    if (autoplay) { stopDemo(); return; }
    mediaMessage('暂未配音，仅演示翻页');
    autoplay = true; $('play').classList.add('playing');
    $('play').setAttribute('aria-label', '暂停翻页');
    $('play').setAttribute('aria-pressed', 'true');
    $('play').title = '暂停翻页';
    goTo(current === COUNT ? 0 : current + 1); scheduleDemo();
  });
  $('next').addEventListener('click', () => { stopDemo(); goTo(target + 1); });
  $('prev').addEventListener('click', () => { stopDemo(); goTo(target - 1); });
  $('reset').addEventListener('click', () => { stopDemo(); goTo(0); });
  window.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); stopDemo();
      goTo(event.key === 'Home' ? 0 : event.key === 'End' ? COUNT : target + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', (event) => {
    if (turn || drag || current !== target || event.button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(sheets.flatMap(s => [s.mesh, s.reverse]))[0];
    if (!hit) return;
    const local = book.worldToLocal(hit.point.clone());
    const forward = current === 0 || (current !== COUNT && local.x >= 0);
    const index = forward ? current : current - 1;
    if (index < 0 || index >= COUNT) return;
    stopDemo();
    drag = { index, forward, x: event.clientX, y: event.clientY, progress: forward ? 0 : 1, moved: false, pointerId: event.pointerId };
    renderer.domElement.setPointerCapture(event.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = drag.x - event.clientX;
    if (Math.abs(distance) > 6) drag.moved = true;
    drag.progress = THREE.MathUtils.clamp((drag.forward ? 0 : 1) + distance / Math.min(innerWidth * 0.38, 420), 0, 1);
  });
  function endDrag(event, cancel = false) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const { index, forward, progress, moved } = drag;
    const complete = !cancel && (!moved || (forward ? progress > 0.25 : progress < 0.75));
    const to = complete ? (forward ? 1 : 0) : (forward ? 0 : 1);
    target = index + to;
    beginTurn(index, progress, to, performance.now());
    drag = null; updateUI();
    if (renderer.domElement.hasPointerCapture(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
  }
  renderer.domElement.addEventListener('pointerup', event => endDrag(event));
  renderer.domElement.addEventListener('pointercancel', event => endDrag(event, true));
  renderer.domElement.addEventListener('lostpointercapture', event => endDrag(event, true));
  function resize() {
    const { width, height } = $('scene').getBoundingClientRect();
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize); resize(); updateUI();
  function animate(now) {
    if (managedPlayback && player?.timeline) { renderTimeline(player.time, player.timeline, reducedMotion); return; }
    const dt = Math.min((now - lastTime) / 1000, 0.05); lastTime = now;
    if (drag) deform(sheets[drag.index], drag.index, drag.progress);
    else if (turn) {
      const t = Math.min(1, (now - turn.start) / turn.duration);
      const eased = t * t * (3 - 2 * t);
      deform(sheets[turn.index], turn.index, THREE.MathUtils.lerp(turn.from, turn.to, eased));
      if (t === 1) { current = turn.index + turn.to; turn = null; }
    } else if (current !== target) {
      const forward = target > current;
      beginTurn(forward ? current : current - 1, forward ? 0 : 1, forward ? 1 : 0, now);
    }
    const sum = sheets.reduce((value, sheet) => value + sheet.progress, 0);
    const desiredOpen = Math.min(1, sum, COUNT - sum);
    const desiredX = sum < 1 ? -W / 2 * (1 - sum) : sum > COUNT - 1 ? W / 2 * (sum - COUNT + 1) : 0;
    const smooth = 1 - Math.exp(-dt * 7);
    openness += (desiredOpen - openness) * smooth;
    bookPosition += (desiredX - bookPosition) * smooth;
    book.position.x = bookPosition;
    book.position.y = -0.03 + (reducedMotion ? 0 : Math.sin(now * 0.0008) * 0.025);
    book.rotation.set(0, 0, 0);
    // Fill the landscape reading area, keeping room for the lifted page mid-turn.
    const fitDistance = Math.max(6.65, 9.9 / camera.aspect);
    const turningProgress = drag ? drag.progress : turn ? sheets[turn.index].progress : 0;
    const distance = fitDistance + (1 - openness) * 0.5 + Math.sin(turningProgress * Math.PI) * 2.6;
    camera.position.z += (distance - camera.position.z) * smooth;
    camera.position.y = 0;
    camera.lookAt(0, 0, 0);
    shadow.scale.x = 0.62 + openness * 0.38;
    renderer.render(scene, camera);
  }
  if (!exportMode) renderer.setAnimationLoop(animate);
  // Absolute-time rendering: no animation history, real-time waits, pointer drift or frame-dependent damping.
  function renderTimeline(seconds, timeline, reduce = false) {
    const pose = poseAt(timeline, seconds);
    const progress = reduce && pose.segment.kind === 'turn'
      ? Array.from({ length: COUNT }, (_, i) => i < pose.segment.to ? 1 : 0) : pose.progress;
    sheets.forEach((sheet, i) => { if (sheet.progress !== progress[i]) deform(sheet, i, progress[i]); });
    current = pose.state; target = pose.segment.kind === 'turn' ? pose.segment.to : current; turn = null;
    const sum = progress.reduce((a, b) => a + b, 0);
    openness = Math.min(1, sum, COUNT - sum);
    bookPosition = sum < 1 ? -W / 2 * (1 - sum) : sum > COUNT - 1 ? W / 2 * (sum - COUNT + 1) : 0;
    book.position.set(bookPosition, -0.03, 0);
    book.rotation.set(0, 0, 0);
    const fitDistance = Math.max(6.65, 9.9 / camera.aspect);
    camera.position.set(0, 0, fitDistance + (1 - openness) * 0.5 + (reduce ? 0 : Math.sin(pose.turnProgress * Math.PI) * 2.6));
    camera.lookAt(0, 0, 0); shadow.scale.x = 0.62 + openness * 0.38;
    if (!exportMode) updateUI();
    renderer.render(scene, camera);
    return { time: pose.time, state: pose.state, kind: pose.segment.kind, pageId: pose.segment.pageId ?? null };
  }
  const ready = Promise.all(imageLoads).then(() => { if (imageErrors.length) throw new Error('Missing page images: ' + imageErrors.join(', ')); });
  // Avoid an unhandled rejection for the ordinary reader; the exporter still awaits the rejecting promise.
  ready.catch(() => {});
  const demo = {
    goTo(index) { stopDemo(); goTo(index); },
    ready,
    setExportTimeline(timeline) {
      if (!exportMode) throw new Error('Open with ?export=1 for offline rendering.');
      exportTimeline = validateTimeline(timeline, bookContent);
      $('export-disclosure').textContent = timeline.disclosure || DEFAULT_DISCLOSURE;
      $('export-disclosure').hidden = false;
      resize(); return { duration: timeline.duration, sheetCount: COUNT };
    },
    renderAt(seconds) { if (!exportTimeline) throw new Error('Set a validated timeline first.'); return renderTimeline(seconds, exportTimeline); },
    get narration() { return { status: player.status, time: player.time, managed: managedPlayback }; },
    // The reader paints page art onto canvas textures, so there are no <img> elements to
    // inspect — this is the real report of what loaded.
    get media() { return { requested: imageLoads.length, failed: [...imageErrors] }; },
    get state() { return { current, target, animating: !!turn, dragging: !!drag, autoplay }; },
  };
  // Assigned here, not by the caller: the exporter can only read a page global.
  window.bookDemo = demo;
  return demo;
}
