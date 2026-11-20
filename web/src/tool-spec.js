/** 六个工具的契约。宿主只支持 string/number/integer/boolean/null/array/object/json/oneOf 注解。 */

const out = (d) => ({
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true, description: d } } },
  render(_a, v) { return [{ type: 'text', text: v.text }]; },
});

const WHY = 'Works without touching the screen: it talks to the phone browser over the DevTools protocol (adb forward → ws).';

export function ensureSpec() {
  return {
    name: 'web_ensure',
    description: [
      'Check the browser automation channel and repair it if the forward went stale.',
      WHY,
      '',
      'Call this first when web_* tools fail. If the browser process was killed, this reports it;',
      'with allowForeground:true it will launch the browser (which briefly takes over the screen).',
    ].join('\n'),
    parameters: {
      allowForeground: { type: 'boolean', description: 'If the browser is dead, launch it. Takes the screen for ~1-2s. Default false.' },
    },
    output: out('Channel status, browser version, or why it cannot work plus the next step.'),
  };
}

export function openSpec() {
  return {
    name: 'web_open',
    description: [
      'Open a URL in a tab OWNED BY THIS PLUGIN and return its targetId.',
      WHY,
      '',
      'The tab is tagged in its URL fragment (#dsh-<marker>) so it can be found and closed later even',
      'after a crash. It NEVER reuses or navigates a tab the user owns.',
    ].join('\n'),
    parameters: {
      url: { type: 'string', required: true, description: 'Absolute http(s) URL.' },
      reuse: { type: 'boolean', description: 'Reuse our own previous tab instead of creating another. Default true.' },
    },
    output: out('targetId plus the resulting title/url.'),
  };
}

export function readSpec() {
  return {
    name: 'web_read',
    description: [
      'Read the current page of one of our tabs: url, title, and visible text (first 4000 chars).',
      WHY,
      'Costs no image tokens — prefer it over screenshots when you only need to know what the page says.',
    ].join('\n'),
    parameters: {
      targetId: { type: 'string', required: true, description: 'targetId returned by web_open.' },
      maxChars: { type: 'integer', description: 'How many characters of body text, default 4000, max 20000.' },
    },
    output: out('Page url, title and visible text.'),
  };
}

export function clickSpec() {
  return {
    name: 'web_click',
    description: [
      'Click an element by CSS selector in one of our tabs.',
      WHY,
      'No coordinates involved: it scrolls the element into view and dispatches a real click, so page',
      'scrolling or layout shifts cannot make it hit the wrong thing.',
    ].join('\n'),
    parameters: {
      targetId: { type: 'string', required: true, description: 'targetId from web_open.' },
      selector: { type: 'string', description: 'CSS selector, e.g. "#submit". Optional if text is given.' },
      text: { type: 'string', description: 'Visible text to match instead, e.g. "创建仓库". Optional if selector is given.' },
      touch: {
        type: 'boolean',
        description: '默认 true：走触摸事件（手机浏览器上真人用手指，而且拟人化轨迹接在这条路上）。'
          + '传 false 走鼠标事件，只在桌面浏览器或需要 hover 的页面用 —— '
          + '手机上鼠标路径本身是可识别的机器特征（"声明支持触摸却零个 touch 事件"）。',
      },
    },
    output: out('Whether the element was found and clicked.'),
  };
}

export function fillSpec() {
  return {
    name: 'web_fill',
    description: [
      'Type into an input/textarea by CSS selector.',
      WHY,
      'Dispatches per-character key events (not Input.insertText) so frameworks see a real key sequence. Setting',
      'element.value directly leaves their state empty — that is why the page says "still blank".',
    ].join('\n'),
    parameters: {
      targetId: { type: 'string', required: true, description: 'targetId from web_open.' },
      selector: { type: 'string', required: true, description: 'CSS selector of the field.' },
      text: { type: 'string', required: true, description: 'Text to type.' },
    },
    output: out('What the field reads back after typing.'),
  };
}

export function shotSpec() {
  return {
    name: 'web_shot',
    description: [
      'Screenshot our tab and save it as PNG.',
      WHY,
      'Useful when layout matters; prefer web_read when you only need text (no image tokens).',
    ].join('\n'),
    parameters: {
      targetId: { type: 'string', required: true, description: 'targetId from web_open.' },
      dir: { type: 'string', description: 'Directory on this machine, default /tmp.' },
    },
    output: out('Saved path and byte size.'),
  };
}

export function tabsSpec() {
  return {
    name: 'web_tabs',
    description: [
      'List every page tab in the browser — the user\'s own tabs included, not just this plugin\'s.',
      WHY,
      '',
      'Each entry says whose it is: 插件开的 (we created it), 已接管 (the user\'s, adopted this session),',
      'or 你自己的 (the user\'s, untouched). Listing is read-only; it changes nothing.',
      '',
      'Use this when the user says "用我已经开着的那个页面" — find the tab here, then web_attach it.',
    ].join('\n'),
    parameters: {},
    output: out('Every open tab with its title, URL, targetId, and who owns it.'),
  };
}

export function attachSpec() {
  return {
    name: 'web_attach',
    description: [
      'Take over an existing tab by targetId, so this plugin\'s other tools can drive it.',
      WHY,
      '',
      'It only registers the tab. It does NOT navigate, reload, or change the URL — the point is to',
      'reuse a page the user is already signed in to, instead of opening a fresh tab and logging in again.',
      '',
      'The tab stays the user\'s: web_close will refuse to close it unless the call carries confirm:true.',
      'Get the targetId from web_tabs first.',
    ].join('\n'),
    parameters: {
      targetId: { type: 'string', required: true, description: 'targetId from web_tabs.' },
      wake: { type: 'boolean', description: 'If the tab is asleep (Chromium freezes background tabs — common when the browser has many), revive it. NOTE: this calls Target.activateTarget, which makes that tab the active one in the browser — if the user is looking at the browser, their view switches to this tab. It does NOT reload unless activation alone fails; a reload would lose scroll position and unsaved form input. Only pass this after the user agrees.' },
    },
    output: out('The adopted tab\'s title, URL, and whether it was asleep (frozen) or had to be woken.'),
  };
}

export function closeSpec() {
  return {
    name: 'web_close',
    description: [
      'Close a tab, or finish up by closing every tab this plugin created and removing the adb forward.',
      WHY,
      '',
      'Without targetId: closes only tabs carrying our #dsh-<marker> tag, then drops the forward.',
      'The user\'s tabs are never touched on this path.',
      '',
      'With targetId: closes that one tab. Tabs this plugin created close straight away; a tab the user',
      'owns (including one adopted via web_attach) is REFUSED unless you pass confirm:true — because',
      'closing the user\'s tabs is exactly how 60+ of them were lost once. Ask the user first.',
      '',
      'Call the no-argument form when the task is done — a stale forward is what makes later',
      'connections hang with "socket hang up".',
    ].join('\n'),
    parameters: {
      targetId: { type: 'string', description: 'Optional. Close just this tab instead of all of ours.' },
      confirm: { type: 'boolean', description: 'Required to close a tab the user owns. Only pass it after the user agrees.' },
    },
    output: out('How many tabs were closed and whether the forward was removed.'),
  };
}

export function browserSpec() {
  return {
    name: 'web_browser',
    description: [
      '查看或切换要操作的浏览器（默认 Edge）。',
      '',
      'Chromium 系（Edge / Chrome / 红魔浏览器）的 devtools socket 都叫 chrome_devtools_remote，',
      '同一时刻只允许一个进程绑定，所以切换前要先关掉另一个浏览器。',
    ].join('\n'),
    parameters: {
      select: { type: 'string', description: '要切到的浏览器：edge / chrome / nubia。省略则只查看当前状态。' },
    },
    output: out('当前浏览器与可选项。'),
  };
}
