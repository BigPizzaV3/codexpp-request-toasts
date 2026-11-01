// 请求滚动提示：仿「我的世界」右下角提示。
// 每秒轮询 /request-log/recent（与托盘「实时请求」同一份日志），发现新完成的请求就弹一条：
// 新条目从底部出现、把旧条目往上顶；越靠上越淡，到时间后淡出并收起。
codexPlus.extension((ctx) => {
  const EXT = "request-toasts";
  const POLL_MS = 1000;
  const FETCH_LIMIT = 20;
  const SEEN_LIMIT = 400;

  const clamp = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  };
  const lifetimeMs = clamp(ctx.config.lifetimeSeconds, 2, 60, 8) * 1000;
  const maxVisible = Math.round(clamp(ctx.config.maxVisible, 1, 10, 5));
  const bottomOffset = clamp(ctx.config.bottomOffset, 0, 600, 96);
  const rightOffset = clamp(ctx.config.rightOffset, 0, 600, 18);

  const zh = (document.documentElement?.lang || navigator.language || "zh").toLowerCase().startsWith("zh");
  const text = zh
    ? { ok: "成功", failed: "失败" }
    : { ok: "OK", failed: "Failed" };

  // ---------- 样式 ----------
  ctx.effect(() => {
    const style = document.createElement("style");
    style.id = "codex-plus-ext-request-toasts-style";
    style.setAttribute("data-codex-plus-ext", EXT);
    style.textContent = `
      .rt-stack {
        position: fixed;
        right: ${rightOffset}px;
        bottom: ${bottomOffset}px;
        z-index: 2147482000; /* 比内置 toast 低，不盖住「删除成功（可撤销）」这类提示 */
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        width: 300px;
        pointer-events: none;
      }
      /* 外层用 grid 行高 0fr→1fr 做展开 / 收起：新条目长高时把上面的平滑顶上去 */
      .rt-item {
        display: grid;
        grid-template-rows: 0fr;
        width: 100%;
        opacity: 0;
        transform: translateX(24px);
        transition:
          grid-template-rows 280ms cubic-bezier(.2,.8,.2,1),
          opacity 600ms ease,
          transform 280ms cubic-bezier(.2,.8,.2,1);
      }
      .rt-item[data-state="shown"] { grid-template-rows: 1fr; transform: none; }
      .rt-item[data-state="leaving"] {
        grid-template-rows: 0fr;
        opacity: 0 !important;
        transition: grid-template-rows 360ms ease 420ms, opacity 520ms ease, transform 280ms ease;
      }
      .rt-clip { min-height: 0; overflow: hidden; }
      .rt-card {
        position: relative;
        margin-top: 8px;
        padding: 9px 12px 9px 16px;
        border-radius: 10px;
        border: 1px solid var(--codex-plus-border, rgba(255,255,255,.08));
        background: color-mix(in srgb, var(--codex-plus-bg-elevated, #1c1c20) 94%, transparent);
        color: var(--codex-plus-text, #e8e8ea);
        box-shadow: 0 6px 20px rgba(0,0,0,.28);
        backdrop-filter: blur(8px);
        font-size: 12px;
        line-height: 1.45;
        font-variant-numeric: tabular-nums;
      }
      .rt-card::before {
        content: "";
        position: absolute;
        left: 6px; top: 9px; bottom: 9px;
        width: 3px;
        border-radius: 2px;
        background: var(--codex-plus-success, #3fa76b);
      }
      .rt-item[data-ok="false"] .rt-card::before { background: var(--codex-plus-error, #e5534b); }
      .rt-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
      .rt-model { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rt-duration { flex: none; font-weight: 600; }
      .rt-meta { margin-top: 2px; opacity: .72; }
      .rt-relay { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .rt-tokens, .rt-status { flex: none; white-space: nowrap; }
      .rt-item[data-ok="false"] .rt-status { color: var(--codex-plus-error, #e5534b); opacity: 1; }
      @media (prefers-reduced-motion: reduce) {
        .rt-item, .rt-item[data-state="leaving"] { transition: opacity 200ms linear; transform: none; }
      }
    `;
    document.head.append(style);
    return () => style.remove();
  });

  // ---------- 容器 ----------
  // Codex 重建 DOM 不会动 body 的直接子节点，但仍每次用前检查一下，掉了就重挂。
  let stack = null;
  function ensureStack() {
    if (stack?.isConnected) return stack;
    stack = document.createElement("div");
    stack.className = "rt-stack";
    stack.setAttribute("data-codex-plus-ext", EXT);
    document.body.append(stack);
    return stack;
  }
  ctx.effect(() => () => {
    stack?.remove();
    stack = null;
  });

  // ---------- 格式化 ----------
  function compact(value) {
    const n = Number(value) || 0;
    if (n >= 1e6) return `${trim(n / 1e6, n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${trim(n / 1e3, n >= 1e4 ? 0 : 1)}K`;
    return String(n);
  }
  function trim(value, digits) {
    return value.toFixed(digits).replace(/\.0$/, "");
  }
  function duration(ms) {
    const seconds = (Number(ms) || 0) / 1000;
    if (seconds < 10) return `${seconds.toFixed(1)} s`;
    if (seconds < 100) return `${Math.round(seconds)} s`;
    return `${Math.floor(seconds / 60)} m ${Math.round(seconds % 60)} s`;
  }
  // 供应商名里的账号打码，规则同管理器的 maskAccountName：邮箱只露头尾，订阅账号名只露头尾。
  function maskToken(token) {
    if (token.length <= 2) return `${token[0] || ""}*`;
    if (token.length <= 4) return `${token[0]}**${token.slice(-1)}`;
    return `${token.slice(0, 2)}***${token.slice(-1)}`;
  }
  function maskRelay(name) {
    const masked = String(name || "").replace(
      /(^|[^A-Za-z0-9._%+*-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
      (_m, lead, user, domain) => `${lead}${maskToken(user)}@${domain}`,
    );
    const match = /^((?:ChatGPT|Copilot|SuperGrok|GitHub Copilot)[^·]*·\s*)(.+)$/.exec(masked);
    if (!match || match[2].includes("@") || match[2].includes("*")) return masked;
    return match[1] + maskToken(match[2].trim());
  }
  function isOk(entry) {
    return entry.success !== false && !(Number(entry.statusCode) >= 400);
  }

  // ---------- 条目 ----------
  const items = []; // 由旧到新：{ node, timer }

  function span(className, value) {
    const element = document.createElement("span");
    element.className = className;
    element.textContent = value;
    return element;
  }

  function buildItem(entry) {
    const ok = isOk(entry);
    const item = document.createElement("div");
    item.className = "rt-item";
    item.setAttribute("data-codex-plus-ext", EXT);
    item.dataset.ok = String(ok);

    const card = document.createElement("div");
    card.className = "rt-card";

    const head = document.createElement("div");
    head.className = "rt-row";
    const agent = entry.agent && entry.agent !== "codex" ? `${entry.agent} · ` : "";
    head.append(
      span("rt-model", agent + (entry.upstreamModel || entry.model || "?")),
      span("rt-duration", duration(entry.durationMs)),
    );

    const meta = document.createElement("div");
    meta.className = "rt-row rt-meta";
    const usage = entry.usage;
    const status = ok
      ? `✓ ${text.ok}`
      : `✕ ${text.failed}${entry.statusCode ? ` ${entry.statusCode}` : ""}`;
    meta.append(span("rt-relay", maskRelay(entry.relayName || entry.relayId || "")));
    if (usage) meta.append(span("rt-tokens", `↑${compact(usage.inputTokens)} ↓${compact(usage.outputTokens)}`));
    meta.append(span("rt-status", status));
    if (!ok && entry.error) card.title = String(entry.error);

    card.append(head, meta);
    const clip = document.createElement("div");
    clip.className = "rt-clip";
    clip.append(card);
    item.append(clip);
    return item;
  }

  /** 越靠上（越旧）越淡：最新一条不透明，每往上一层减一点，最低 0.35。 */
  function restyle() {
    // 只排已展开的：刚插入还没展开的条目保持 CSS 里的 opacity:0，展开时再淡入。
    const live = items.filter((item) => item.node.dataset.state === "shown");
    live.forEach((item, index) => {
      const rank = live.length - 1 - index;
      item.node.style.opacity = String(Math.max(0.35, 1 - rank * 0.17));
    });
  }

  function dismiss(item) {
    if (item.node.dataset.state === "leaving") return;
    clearTimeout(item.timer);
    item.node.dataset.state = "leaving";
    restyle();
    item.removeTimer = setTimeout(() => {
      item.node.remove();
      const index = items.indexOf(item);
      if (index >= 0) items.splice(index, 1);
    }, 900);
  }

  function push(entry) {
    const node = buildItem(entry);
    ensureStack().append(node);
    const item = { node, timer: 0, removeTimer: 0 };
    items.push(item);
    // 先以收起状态进入文档并强制一次布局，再切到展开，过渡才会生效。
    // 不用 requestAnimationFrame：窗口在后台时 rAF 被节流，条目会一直停在不可见状态。
    void node.offsetHeight;
    node.dataset.state = "shown";
    item.timer = setTimeout(() => dismiss(item), lifetimeMs);
    const live = items.filter((other) => other.node.dataset.state !== "leaving");
    for (const extra of live.slice(0, Math.max(0, live.length - maxVisible))) dismiss(extra);
    restyle();
  }

  ctx.effect(() => () => {
    for (const item of items) {
      clearTimeout(item.timer);
      clearTimeout(item.removeTimer);
    }
    items.length = 0;
  });

  // ---------- 轮询 ----------
  const seen = new Set();
  let seeded = false;
  let inFlight = false;

  function remember(id) {
    seen.add(id);
    if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value);
  }

  async function poll() {
    if (inFlight || document.hidden || ctx.disposed) return;
    inFlight = true;
    try {
      const result = await ctx.call("/request-log/recent", { limit: FETCH_LIMIT }, { timeout: 5000 });
      if (ctx.disposed) return;
      const entries = (Array.isArray(result?.entries) ? result.entries : [])
        .filter((entry) => entry?.id && entry.state !== "running");
      // 第一次只记下已有的请求，不把历史一口气弹出来。
      if (!seeded) {
        entries.forEach((entry) => remember(entry.id));
        seeded = true;
        return;
      }
      const fresh = entries.filter((entry) => !seen.has(entry.id));
      fresh.forEach((entry) => remember(entry.id));
      // 接口按开始时间倒序；按完成先后弹出，最新的落在最下面。离开页面一阵后回来最多补弹 maxVisible 条。
      fresh
        .sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0))
        .slice(-maxVisible)
        .forEach(push);
    } catch {
      // 桥接未连上或超时：下一轮再试，不打扰用户。
    } finally {
      inFlight = false;
    }
  }

  ctx.setInterval(() => void poll(), POLL_MS);
  void poll();
});
