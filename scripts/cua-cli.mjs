import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const bundles = { Calculator: 'com.apple.calculator', TextEdit: 'com.apple.TextEdit', Calendar: 'com.apple.iCal' };
const roles = {
  AXWindow: 'standard window', AXButton: 'button', AXStaticText: 'text',
  AXTextField: 'text field', AXTextArea: 'text field', AXSearchField: 'search field',
  AXRadioButton: 'radio button', AXCheckBox: 'checkbox', AXPopUpButton: 'pop up button',
  AXComboBox: 'combo box', AXScrollArea: 'scroll area', AXToolbar: 'toolbar',
  AXList: 'list', AXRow: 'row', AXGroup: 'container', AXMenuBar: 'menu bar',
  AXMenuBarItem: 'container', AXMenu: 'container', AXMenuItem: 'menu item', AXTab: 'tab',
};

async function invokeCli(name, args, options) {
  const { stdout } = await exec('cua-driver', [name, JSON.stringify(args)], { ...options, encoding: 'utf8' });
  return JSON.parse(stdout);
}

export function createCliDriver({ pid, windowId, session, signal, invoke = invokeCli } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('pid must be a positive integer');
  if (!Number.isInteger(windowId) || windowId < 1) throw new Error('windowId must be a positive integer');
  const target = { pid, window_id: windowId, ...(session ? { session } : {}) };
  let bound = false;
  let appName;
  let snapshot = null;
  let staticValues = [];
  let selected = null;
  let busy = false;

  let sessionSeq = 0;
  async function call(name, args) {
    signal?.throwIfAborted();
    const attempt = () => invoke(name, args, { signal, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    let response;
    try {
      response = await attempt();
    } catch (error) {
      // 守护进程可能结束命名会话；普通动作不会复活已结束名称，
      // 按官方路径先 start_session 复活同名再重试一次。
      if (!/has ended|start_session/i.test(String(error?.message ?? error)) || !args.session) throw error;
      sessionSeq += 1;
      target.session = `${session}-${sessionSeq}`;
      args = { ...args, session: target.session };
      await invoke('start_session', { session: target.session }, { signal, timeout: 30_000, maxBuffer: 1024 * 1024 });
      response = await attempt();
    }
    const data = response.structuredContent ?? response;
    if (response.isError || data.error || data.success === false) {
      throw new Error(data.error?.message || data.message || response.content?.find(c => c.type === 'text')?.text || 'cua-driver failed');
    }
    return data;
  }
  function ready() {
    if (busy) throw new Error('operation in progress');
    if (!bound) throw new Error('bind must complete first');
  }
  function element(index) {
    ready();
    if (!snapshot) throw new Error('observe required: snapshot consumed');
    const found = snapshot.elements.find(e => e.element_index === index);
    if (!found) throw new Error('unknown element index');
    return found;
  }
  function inMenu(item) {
    const seen = new Set();
    while (item && !seen.has(item.element_index)) {
      if (item.role === 'AXMenuBar' || item.role === 'AXMenuBarItem') return true;
      seen.add(item.element_index);
      item = snapshot.elements.find(e => e.element_index === item.parent_index);
    }
    return false;
  }
  async function act(name, index, fields) {
    const item = element(index);
    if (inMenu(item)) throw new Error('background menu actions are unsupported');
    if (item.enabled === false) throw new Error('element is disabled');
    const args = { ...target, element_token: item.element_token, ...fields };
    snapshot = null;
    selected = null;
    busy = true;
    try { return await call(name, args); } finally { busy = false; }
  }
  function chosen() {
    ready();
    if (!snapshot) throw new Error('observe required: snapshot consumed');
    if (selected === null) throw new Error('selectTarget required');
    return selected;
  }
  return {
    async bind(name) {
      if (!Object.hasOwn(bundles, name)) throw new Error('app is not allowed');
      if (busy) throw new Error('operation in progress');
      bound = false;
      snapshot = null;
      busy = true;
      try {
        const apps = await call('list_apps', {});
        const app = apps.apps.find(a => a.pid === pid && a.running && a.bundle_id === bundles[name]);
        if (!app) throw new Error('app identity mismatch');
        const windows = await call('list_windows', { pid });
        if (!windows.windows.some(w => w.pid === pid && w.window_id === windowId)) throw new Error('window identity mismatch');
        bound = true;
        appName = name;
        return { pid, windowId, appName, bundleId: bundles[name] };
      } finally { busy = false; }
    },
    async observe() {
      ready();
      snapshot = null;
      selected = null;
      busy = true;
      try {
        const data = await call('get_window_state', { ...target, include_screenshot: false });
        if (data.pid !== pid || data.window_id !== windowId) throw new Error('snapshot identity mismatch');
        if (!data.snapshot_id || !Array.isArray(data.elements)) throw new Error('snapshot elements missing');
        const indices = new Set();
        for (const item of data.elements) {
          if (!Number.isInteger(item.element_index) || !item.element_token || indices.has(item.element_index)) {
            throw new Error('invalid snapshot elements');
          }
          indices.add(item.element_index);
        }
        snapshot = data;
        // 当前驱动只给可操作元素分配索引；计算器结果仅在同一快照的 AX 文本中。
        staticValues = [];
        for (const line of String(data.tree_markdown ?? '').split('\n')) {
          if (/^\s*-\s+(?:\[\d+\]\s+)?AXMenuBar\b/.test(line)) break;
          const match = line.match(/^\s*- AXStaticText = "(.*)"$/);
          if (match) staticValues.push({ role: 'AXStaticText', value: match[1], readOnly: true, normalizedRole: 'text' });
        }
        const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
        return [`Window: "${appName}", App: ${appName}.`, ...data.elements.map(item => {
          const role = inMenu(item) || item.enabled === false ? 'container' : (roles[item.role] ?? 'container');
          const value = item.value === undefined ? '' : ` Value: ${clean(item.value)}`;
          return `${' '.repeat(item.depth ?? 0)}${item.element_index} ${role} ${clean(item.label)}${value}`;
        }), ...staticValues.map((item, i) => `${Math.max(-1, ...indices) + 1 + i} text Value: ${clean(item.value)}`)].join('\n');
      } finally { busy = false; }
    },
    getSnapshot() {
      if (!snapshot) return null;
      return { pid, windowId, elements: [...snapshot.elements.map(({ element_token, ...item }) => ({ ...structuredClone(item), normalizedRole: roles[item.role] ?? 'container' })), ...structuredClone(staticValues)] };
    },
    selectTarget(index) { element(index); selected = index; },
    async click(index, options) {
      if (Array.isArray(index)) throw new Error('coordinate clicks are unsupported');
      if (options && Object.keys(options).some(k => k !== 'mouseButton')) throw new Error('unsupported click options');
      if (options?.mouseButton && !['left', 'right'].includes(options.mouseButton)) throw new Error('unsupported mouse button');
      return act('click', index, { delivery_mode: 'background', ...(options?.mouseButton ? { button: options.mouseButton } : {}) });
    },
    async drag() { throw new Error('drag is unsupported'); },
    async setValue(index, value) { return act('set_value', index, { value }); },
    async typeText(text) { return act('type_text', chosen(), { text, delivery_mode: 'background' }); },
    async pressKey(key) { return act('press_key', chosen(), { key: key.toLowerCase(), delivery_mode: 'background' }); },
    async scroll(index, direction, amount) {
      if (!['up', 'down', 'left', 'right'].includes(direction)) throw new Error('unsupported direction');
      if (!Number.isInteger(amount) || amount < 1 || amount > 50) throw new Error('invalid amount');
      return act('scroll', index, { direction, amount, by: 'page', delivery_mode: 'background' });
    },
  };
}
