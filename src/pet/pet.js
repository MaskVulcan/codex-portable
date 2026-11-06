'use strict';
const api = window.companion,
  $ = (id) => document.getElementById(id);
let snapshot = null,
  model = null,
  pixi = null,
  paused = false,
  mouse = { x: 0, y: 0 },
  reaction = 0,
  reactionKind = 'pat',
  noticeTimer = null,
  dragged = false,
  dragStart = null,
  lastHit = null;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function safely(fn) {
  return Promise.resolve()
    .then(fn)
    .catch((error) => {
      console.error(error.message);
      showBubble('操作未完成', error.message);
    });
}
function showBubble(title, message) {
  if (snapshot?.settings.quiet) return;
  $('bubble-title').textContent = title;
  $('bubble-message').textContent = message;
  $('bubble').classList.remove('hidden');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('bubble').classList.add('hidden'), 12000);
}
function state(value) {
  const previous = snapshot?.state;
  snapshot = value;
  document.body.dataset.state = value.state;
  const labels = {
    idle: '陪你待命',
    thinking: '认真想一想',
    working: '正在忙呀',
    needsInput: '有问题找你',
    ready: '处理好啦',
    blocked: '遇到一点问题',
  };
  $('state-label').textContent = labels[value.state] || value.message;
  $('controls').title = value.message;
  $('notice-count').textContent = value.noticeCount;
  $('notice-count').classList.toggle('hidden', !value.noticeCount);
  if (
    previous !== value.state &&
    ['ready', 'blocked', 'needsInput'].includes(value.state)
  )
    showBubble(labels[value.state], value.message);
  if (pixi) pixi.ticker.maxFPS = value.state === 'idle' ? 20 : 30;
}
function react(kind) {
  reaction = performance.now() + 1800;
  reactionKind = kind;
  $('hearts').textContent = kind === 'pat' ? '♥' : '♪';
  $('hearts').classList.remove('active');
  void $('hearts').offsetWidth;
  $('hearts').classList.add('active');
}
function layout() {
  if (!pixi || !model) return;
  const host = $('cat-area');
  pixi.renderer.resize(host.clientWidth, host.clientHeight);
  const width = model.internalModel.width,
    height = model.internalModel.height;
  const scale =
    Math.min(host.clientWidth / width, host.clientHeight / height) * 1.02;
  model.scale.set(scale);
  model.position.set(host.clientWidth / 2, host.clientHeight);
}
async function start() {
  const initial = await api.init();
  state(initial.state);
  try {
    window.PIXI = PIXI;
    PIXI.settings.PREFER_ENV = PIXI.ENV.WEBGL2;
    PIXI.live2d.config.logLevel = 0;
    pixi = new PIXI.Application({
      view: $('cat-canvas'),
      width: $('cat-area').clientWidth,
      height: $('cat-area').clientHeight,
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      autoStart: true,
    });
    const renderer = PIXI.live2d.Live2DModel;
    renderer.registerTicker(PIXI.Ticker);
    model = await renderer.from(initial.modelUrl, {
      autoInteract: false,
      autoUpdate: false,
      motionPreload: PIXI.live2d.MotionPreloadStrategy.NONE,
    });
    model.anchor.set(0.5, 1);
    pixi.stage.addChild(model);
    pixi.ticker.add(() => model.update(pixi.ticker.deltaMS));
    layout();
    const core = model.internalModel.coreModel;
    model.internalModel.on('beforeModelUpdate', () => {
      const time = performance.now(),
        t = time / 1000,
        busy = snapshot?.state === 'working' || snapshot?.state === 'thinking',
        typing = snapshot?.state === 'working',
        pat = time < reaction;
      const set = (id, value) => core.setParameterValueById(id, value);
      set('ParamAngleX', mouse.x * 18);
      set('ParamAngleY', -mouse.y * 12);
      set('ParamAngleZ', pat ? Math.sin(t * 12) * 5 : Math.sin(t * 1.3) * 1.5);
      set('ParamEyeBallX', mouse.x);
      set('ParamEyeBallY', -mouse.y);
      set('ParamMouseX', (mouse.x + 1) / 2);
      set('ParamMouseY', (mouse.y + 1) / 2);
      set('ParamBreath', (Math.sin(t * 2) + 1) / 2);
      const blink =
        pat && reactionKind === 'pat'
          ? 0.25
          : Math.sin(t * 1.1) > 0.991
            ? 0.05
            : 1;
      set('ParamEyeLOpen', blink);
      set('ParamEyeROpen', blink);
      set(
        'CatParamLeftHandDown',
        typing
          ? (Math.sin(t * 15) + 1) / 2
          : pat && reactionKind === 'tap'
            ? 1
            : 0,
      );
      set(
        'ParamMouseLeftDown',
        typing ? (Math.sin(t * 15 + Math.PI) + 1) / 2 : 0,
      );
      set('ParamMouseRightDown', pat && reactionKind === 'tap' ? 1 : 0);
      set(
        'Param3',
        snapshot?.state === 'ready' || (pat && reactionKind === 'pat')
          ? (Math.sin(t * 7) + 1) / 2
          : 0,
      );
      set(
        'ParamMouthForm',
        pat || snapshot?.state === 'ready' ? 1 : busy ? 0.15 : 0,
      );
      set('ParamMouthOpenY', pat ? 0.3 : 0);
      set('ParamCheek', pat ? 0.6 : 0);
      set(
        'ParamBrowLY',
        snapshot?.state === 'blocked'
          ? -0.6
          : snapshot?.state === 'needsInput'
            ? 0.5
            : 0,
      );
      set('ParamBrowRY', snapshot?.state === 'blocked' ? -0.6 : 0);
      set('ParamEyeLSmile', pat ? 1 : 0);
      set('ParamEyeRSmile', pat ? 1 : 0);
    });
    if (reduced) {
      pixi.ticker.maxFPS = 1;
    }
    await api.renderer('live2d');
    document.body.dataset.renderer = 'live2d';
    window.__petModel = model;
  } catch (error) {
    console.error('Pet renderer:', error.message);
    pixi?.destroy(false);
    pixi = null;
    $('cat-canvas').classList.add('hidden');
    $('fallback').classList.remove('hidden');
    document.body.dataset.renderer = 'fallback';
    await api.renderer('fallback');
  }
}
api.onEvent((event) => {
  if (event.type === 'state') state(event.state);
  if (event.type === 'cursor') {
    mouse = {
      x: Math.max(-1, Math.min(1, (event.x - 0.5) * 2)),
      y: Math.max(-1, Math.min(1, (event.y - 0.5) * 2)),
    };
  }
  if (event.type === 'interact') react(event.kind);
  if (event.type === 'notice')
    showBubble(event.notice.title, event.notice.message);
  if (event.type === 'pause') {
    paused = event.paused;
    if (pixi) {
      if (paused) pixi.stop();
      else pixi.start();
    }
  }
});
const area = $('cat-area');
area.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  dragStart = { x: event.screenX, y: event.screenY };
  dragged = false;
  area.setPointerCapture(event.pointerId);
  safely(() => api.drag('start'));
});
area.addEventListener('pointermove', (event) => {
  if (!dragStart) return;
  if (
    Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) > 4
  ) {
    dragged = true;
    safely(() => api.drag('move'));
  }
});
area.addEventListener('pointerup', () => {
  if (!dragStart) return;
  dragStart = null;
  safely(() => api.drag('end'));
  if (!dragged) react('pat');
});
area.addEventListener('dblclick', () => {
  if (!dragged) safely(() => api.quick());
});
document.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  safely(() => api.menu());
});
document.addEventListener('mousemove', (event) => {
  const target = event.target;
  const cat = area.getBoundingClientRect(),
    x = (event.clientX - cat.left) / cat.width,
    y = (event.clientY - cat.top) / cat.height;
  const active =
    !!target.closest('button') ||
    (x > 0.08 && x < 0.94 && y > 0.13 && y < 0.99) ||
    !!dragStart;
  if (active !== lastHit) {
    lastHit = active;
    safely(() => api.hit(active));
  }
});
document.addEventListener('mouseleave', () => {
  if (!dragStart) {
    lastHit = false;
    safely(() => api.hit(false));
  }
});
$('quick').onclick = () => safely(() => api.quick());
$('notices').onclick = () => safely(() => api.quick());
$('more').onclick = () => safely(() => api.menu());
$('open').onclick = () => safely(() => api.openChat(snapshot?.chatId));
$('bubble').onclick = () => safely(() => api.openChat(snapshot?.chatId));
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  showBubble('把文件交给我', '松开后在快捷聊天里说说要做什么。');
  safely(() => api.hit(true));
});
document.addEventListener('drop', (event) => {
  event.preventDefault();
  const paths = [...event.dataTransfer.files]
    .map((f) => api.filePath(f))
    .filter(Boolean);
  if (paths.length) safely(() => api.attachDrop(paths));
});
window.addEventListener('resize', layout);
safely(start);
