'use strict';
// Executed in the page's isolated world. Only inspect rendered content, never site internals.
function portablePage(action, args = {}) {
  const visible = (node) => {
    const style = getComputedStyle(node),
      r = node.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      r.width > 0 &&
      r.height > 0
    );
  };
  const text = (node) => (node?.innerText || '').trim();
  const interactive = [
    ...document.querySelectorAll(
      'a[href],button,input,textarea,[role="button"]',
    ),
  ]
    .filter(visible)
    .slice(0, 300);
  if (action === 'click' || action === 'fill') {
    const node = interactive[args.ref];
    if (!node) throw new Error('页面已变化，请先重新读取页面再操作。');
    if (action === 'click') node.click();
    else {
      if (!/^(INPUT|TEXTAREA)$/.test(node.tagName) || node.type === 'password')
        throw new Error('只能填写普通输入框；账号密码请用户自行填写。');
      const prototype =
        node.tagName === 'TEXTAREA'
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(
        node,
        String(args.text || ''),
      );
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { acted: true };
  }
  const scrollable =
    [
      ...document.querySelectorAll(
        '.note-scroller,.comments-container,.note-container [class*="scroll"],main,[role="main"]',
      ),
    ]
      .filter(visible)
      .filter((n) => n.scrollHeight > n.clientHeight + 20)
      .sort((a, b) => b.clientHeight - a.clientHeight)[0] ||
    document.scrollingElement;
  if (action === 'scroll') {
    const before = scrollable.scrollTop;
    if (Number.isFinite(args.position))
      scrollable.scrollTo({
        top: Math.max(0, args.position),
        behavior: 'instant',
      });
    else
      scrollable.scrollBy({
        top:
          (args.direction === 'up' ? -1 : 1) *
          Math.max(300, scrollable.clientHeight * 0.8),
        behavior: 'instant',
      });
    return {
      moved: Math.abs(scrollable.scrollTop - before) > 2,
      position: scrollable.scrollTop,
    };
  }
  const login = [
    ...document.querySelectorAll(
      '.login-container,.login-modal,.login-mask,[class*="login-modal"],[class*="captcha"],[id*="captcha"],[class*="verify-container"]',
    ),
  ].filter(visible);
  const body = text(document.body).slice(0, 80000);
  let gate = login.some((n) => /验证|验证码|captcha|verify/i.test(text(n)))
    ? 'verification'
    : login.length
      ? 'login'
      : null;
  if (
    !gate &&
    body.length < 1800 &&
    /安全验证|访问频繁|操作频繁|访问异常|验证码|请先登录|扫码登录|登录后查看/.test(
      body,
    )
  )
    gate = /访问频繁|操作频繁|访问异常/.test(body)
      ? 'rate_limit'
      : /验证/.test(body)
        ? 'verification'
        : 'login';
  const primaryComments = document.querySelectorAll(
    '.comment-item,[data-comment-id]',
  );
  const comments = [
    ...(primaryComments.length
      ? primaryComments
      : document.querySelectorAll('.comment-inner-container')),
  ]
    .filter(visible)
    .map((n) => ({
      id: n.getAttribute('data-comment-id') || n.id || '',
      text: text(n).slice(0, 5000),
    }))
    .filter((c) => c.text);
  const links = [],
    seen = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    if (!visible(a)) continue;
    const url = new URL(a.href, location.href);
    if (
      /(^|\.)xiaohongshu\.com$/.test(url.hostname) &&
      /^\/(?:explore|discovery\/item)\/[a-zA-Z0-9]+/.test(url.pathname)
    ) {
      const key = url.origin + url.pathname;
      if (!seen.has(key)) {
        seen.add(key);
        links.push({ url: url.href, title: text(a).slice(0, 160) });
      }
    }
  }
  return {
    url: location.href,
    title: document.title,
    gate,
    heading: text(
      document.querySelector('#detail-title,.note-content .title,h1'),
    ),
    content:
      text(
        document.querySelector(
          '#detail-desc,.note-content .desc,.note-content',
        ),
      ) || body.slice(0, 24000),
    text: body.slice(0, 24000),
    comments: comments.slice(0, 500),
    links: links.slice(0, 200),
    controls: interactive.map((n, ref) => ({
      ref,
      role: n.getAttribute('role') || n.tagName.toLowerCase(),
      text: (
        text(n) ||
        n.getAttribute('placeholder') ||
        n.getAttribute('aria-label') ||
        ''
      ).slice(0, 100),
    })),
    endVisible: [
      ...document.querySelectorAll(
        '.end-container,.comments-end,[class*="end-tip"]',
      ),
    ].some(
      (n) =>
        visible(n) &&
        n.getBoundingClientRect().top < innerHeight &&
        n.getBoundingClientRect().bottom > 0 &&
        /没有更多|到底|THE END/i.test(text(n)),
    ),
    position: scrollable.scrollTop,
  };
}
