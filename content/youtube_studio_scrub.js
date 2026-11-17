/**
 * FB & YT 智能营销助手 - YouTube Studio 集中回复引擎 (v1.7.0)
 * 适用页面: https://studio.youtube.com/*
 * 核心能力:
 *   1. 全面兼容 YouTube Studio 英文 (English)、简体中文、繁体中文 三语界面
 *   2. 自动覆盖频道下所有 长视频 (Videos)、短视频 (Shorts)、社区贴 (Community Posts)
 *   3. 支持 Shadow DOM 深度穿透解析，自动激活【尚未回复 / Unresponded】筛选器
 *   4. 可选开启【顺便点红心 ❤️】（默认关闭），带 1.5~3.5 秒拟人化随机延迟
 *   5. 独立 24 小时用户冷却去重、多套话术随机轮播、空闲自动刷新拉取新留言
 */

(async function () {
  if (window.location.hostname !== 'studio.youtube.com') {
    return;
  }

  console.log("[YT Studio Engine v1.7.0] YouTube Studio 集中回复引擎已挂载！");

  let isProcessingLoop = false;
  let pollTimer = null;
  const sessionProcessedKeys = new Set();
  let localTaskSessionId = null;
  let sessionScannedKeys = new Set();

  // ── 通用工具：穿透 Shadow DOM 的深层查询 ──────────────────────────────────
  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    const visited = new Set();

    function traverse(node) {
      if (!node || visited.has(node)) return;
      visited.add(node);

      if (node.querySelectorAll) {
        try {
          const matched = node.querySelectorAll(selector);
          for (const el of matched) results.push(el);
        } catch (e) { /* ignore invalid selector in shadow */ }
      }

      if (node.shadowRoot) {
        traverse(node.shadowRoot);
      }

      const children = node.children || node.childNodes;
      if (children) {
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child.nodeType === 1) {
            traverse(child);
          }
        }
      }
    }

    traverse(root);
    return Array.from(new Set(results));
  }

  function querySelectorDeep(selector, root = document) {
    const all = querySelectorAllDeep(selector, root);
    return all.length > 0 ? all[0] : null;
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ── 初始化本次任务扫描计数 ────────────────────────────────────────────────
  function initScannedKeys(settings) {
    const currentTaskSession = settings.ytTaskSessionId || 0;
    const stats = settings.ytStats || { totalProcessed: 0 };
    if (localTaskSessionId !== currentTaskSession || stats.totalProcessed === 0) {
      localTaskSessionId = currentTaskSession;
      sessionScannedKeys.clear();
      try { sessionStorage.removeItem('yt_studio_scanned_keys'); } catch (e) {}
    } else if (sessionScannedKeys.size === 0) {
      try {
        const cached = sessionStorage.getItem('yt_studio_scanned_keys');
        if (cached) sessionScannedKeys = new Set(JSON.parse(cached));
      } catch (e) {}
    }
  }

  function persistScannedKey(key) {
    sessionScannedKeys.add(key);
    try {
      sessionStorage.setItem('yt_studio_scanned_keys', JSON.stringify(Array.from(sessionScannedKeys).slice(-2000)));
    } catch (e) {}
  }

  // ── 调度下一次巡检或自动刷新 ──────────────────────────────────────────────
  function scheduleNextPollOrReload(seconds, shouldReload = false) {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    pollTimer = setTimeout(async () => {
      const current = await StorageUtil.getSettings();
      if (!current.ytIsRunning || current.ytIsPaused) {
        return;
      }
      if (shouldReload) {
        await StorageUtil.saveSettings({
          ytStatusMessage: "🔄 正在自动刷新 YouTube Studio，同步最新留言..."
        });
        window.location.reload();
      } else {
        runYoutubeCommentsLoop();
      }
    }, seconds * 1000);
  }

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (req.action === "SOFT_REFRESH_YT_COMMENTS") {
      if (!isProcessingLoop) {
        runYoutubeCommentsLoop();
      }
      sendResponse({ status: "ACK" });
    }
    return true;
  });

  // ── 风控与安全验证检测（三语） ────────────────────────────────────────────
  function checkYoutubeEmergencyBrake() {
    const bodyText = (document.body.innerText || '').toLowerCase();
    const dangerSignals = [
      "verify it's you",
      "verify your identity",
      "unusual traffic",
      "too many requests",
      "验证您的身份",
      "验证你的身份",
      "異常流量",
      "驗證您的身分",
      "操作过于频繁",
      "操作過於頻繁"
    ];
    for (const sig of dangerSignals) {
      if (bodyText.includes(sig)) {
        chrome.runtime.sendMessage({
          action: "YT_TRIGGER_EMERGENCY_BRAKE",
          reason: `检测到 YouTube 安全/频率提示 (${sig})，已自动触发熔断保护！`
        });
        return true;
      }
    }
    return false;
  }

  // ── 确保当前位于评论收件箱 (/comments/inbox) ──────────────────────────────
  async function ensureOnCommentsInboxPage() {
    const path = window.location.pathname;
    if (path.includes('/comments')) {
      return true;
    }

    // 尝试从 URL 提取 /channel/UCxxxx 并直接跳转（严格校验频道 ID 字符集）
    const match = path.match(/^(\/channel\/[A-Za-z0-9_-]+)/);
    if (match) {
      const targetUrl = `https://studio.youtube.com${match[1]}/comments/inbox`;
      console.log("[YT Studio Engine] 当前不在评论页面，自动跳转至:", targetUrl);
      window.location.href = targetUrl;
      return false;
    }

    // 兜底：尝试点击左侧导航栏的 Comments / 评论 / 留言
    const navLinks = querySelectorAllDeep('a[href*="/comments"]');
    for (const a of navLinks) {
      if (isVisible(a)) {
        a.click();
        await sleep(2500);
        return window.location.pathname.includes('/comments');
      }
    }
    return false;
  }

  // ── 自动激活【尚未回复 / I haven't responded】筛选器（三语） ─────────────
  async function ensureUnrespondedFilterActive() {
    try {
      const chips = querySelectorAllDeep('ytcp-chip, .chip, [role="option"], ytcp-filter-chip');
      const unrespondedKeywords = [
        "haven't responded",
        "i haven't responded",
        "尚未回复",
        "我尚未回复",
        "尚未回覆",
        "我尚未回覆"
      ];

      for (const chip of chips) {
        const txt = (chip.innerText || chip.textContent || '').trim().toLowerCase();
        if (unrespondedKeywords.some(k => txt.includes(k)) && isVisible(chip)) {
          return true; // 已经激活了未回复筛选器
        }
      }

      // 尝试点击筛选栏触发下拉菜单
      const filterInputs = querySelectorAllDeep('ytcp-filter-bar input, input[aria-label*="Filter"], input[aria-label*="筛选"], input[aria-label*="篩選"]');
      const visibleFilterInput = filterInputs.find(el => isVisible(el));
      if (!visibleFilterInput) return false;

      visibleFilterInput.click();
      await sleep(700);

      // 查找一级菜单项：Response status / 回复状态 / 回覆狀態
      const statusKeys = ["response status", "回复状态", "回覆狀態"];
      const menuItems = querySelectorAllDeep('tp-yt-paper-item, ytcp-text-menu tp-yt-paper-item, [role="menuitem"]');
      let statusItem = null;
      for (const item of menuItems) {
        const txt = (item.innerText || item.textContent || '').trim().toLowerCase();
        if (statusKeys.some(k => txt.includes(k)) && isVisible(item)) {
          statusItem = item;
          break;
        }
      }

      if (!statusItem) {
        document.body.click();
        return false;
      }

      statusItem.click();
      await sleep(700);

      // 勾选：I haven't responded / 我尚未回复 / 我尚未回覆
      const checkboxes = querySelectorAllDeep('tp-yt-paper-checkbox, ytcp-checkbox-lit, [role="checkbox"], label');
      for (const cb of checkboxes) {
        const txt = (cb.innerText || cb.textContent || cb.getAttribute('aria-label') || '').trim().toLowerCase();
        if (unrespondedKeywords.some(k => txt.includes(k)) && isVisible(cb)) {
          cb.click();
          await sleep(400);
          break;
        }
      }

      // 点击 Apply / 应用 / 套用
      const applyKeys = ["apply", "应用", "套用"];
      const buttons = querySelectorAllDeep('ytcp-button, button');
      for (const btn of buttons) {
        const txt = (btn.innerText || btn.textContent || '').trim().toLowerCase();
        if (applyKeys.includes(txt) && isVisible(btn)) {
          btn.click();
          await sleep(1500);
          return true;
        }
      }
    } catch (e) {
      console.warn("[YT Studio Engine] 激活未回复筛选器异常:", e);
    }
    return false;
  }

  // ── 扫描评论线程卡片 ──────────────────────────────────────────────────────
  function findCommentThreads() {
    const threads = querySelectorAllDeep('ytcp-comment-thread');
    return threads.filter(t => isVisible(t));
  }

  // ── 解析单条评论线程 ──────────────────────────────────────────────────────
  function parseCommentThread(threadEl) {
    try {
      const comments = querySelectorAllDeep('ytcp-comment', threadEl);
      if (comments.length === 0) return null;

      // 第一个 ytcp-comment 是主评论；如果大于 1 个，通常意味着下面已有回复
      const mainComment = comments[0];
      const hasExistingReplies = comments.length > 1;

      // 提取用户名与频道链接
      let userName = "";
      let profileLink = "";
      let ytUserId = "";

      const authorLink = querySelectorDeep('a#author-text, a.author-text, a[href*="/channel/"], a[href*="/@"]', mainComment);
      if (authorLink) {
        userName = (authorLink.innerText || authorLink.textContent || '').trim();
        profileLink = authorLink.href || '';
      }
      if (!userName) {
        const authorSpan = querySelectorDeep('#author-text, .author-text', mainComment);
        if (authorSpan) userName = (authorSpan.innerText || authorSpan.textContent || '').trim();
      }
      if (!userName) userName = "YouTube用户";

      if (profileLink) {
        const chMatch = profileLink.match(/\/channel\/(UC[\w-]+)/);
        const handleMatch = profileLink.match(/\/(@[\w.-]+)/);
        ytUserId = chMatch ? chMatch[1] : (handleMatch ? handleMatch[1] : '');
      }

      // 提取评论正文
      const contentEl = querySelectorDeep('#content-text, .comment-text, #comment-content', mainComment);
      const commentText = contentEl ? (contentEl.innerText || contentEl.textContent || '').trim() : '';

      // 提取评论时间
      const timeEl = querySelectorDeep('.published-time-text, a[href*="lc="]', mainComment);
      const commentTime = timeEl ? (timeEl.innerText || timeEl.textContent || '').trim() : '';

      // 提取作品链接（兼容长视频 / Shorts / 社区贴）
      let postUrl = "";
      const videoLinks = querySelectorAllDeep('a[href*="youtube.com/watch"], a[href*="/shorts/"], a[href*="/post/"], a[href*="/video/"]', threadEl);
      for (const a of videoLinks) {
        if (a.href && !a.href.includes('/channel/')) {
          postUrl = a.href;
          break;
        }
      }
      if (!postUrl) postUrl = window.location.href;

      return {
        threadEl,
        mainComment,
        hasExistingReplies,
        userName,
        ytUserId,
        profileLink,
        commentText,
        commentTime,
        postUrl
      };
    } catch (e) {
      console.warn("[YT Studio Engine] 解析评论卡片异常:", e);
      return null;
    }
  }

  // ── 解析评论时间距今分钟数（支持英 / 简 / 繁） ────────────────────────────
  function parseCommentAgeMinutes(timeStr) {
    if (!timeStr) return 0;
    const s = timeStr.toLowerCase().trim();
    if (s.includes('just now') || s.includes('刚刚') || s.includes('剛剛') || s.includes('second') || s.includes('秒')) {
      return 0;
    }
    const numMatch = s.match(/(\d+)/);
    const num = numMatch ? parseInt(numMatch[1], 10) : 0;
    if (s.includes('minute') || s.includes('min') || s.includes('分钟') || s.includes('分鐘')) {
      return num;
    }
    if (s.includes('hour') || s.includes('hr') || s.includes('小时') || s.includes('小時')) {
      return num * 60;
    }
    if (s.includes('day') || s.includes('天')) {
      return num * 1440;
    }
    if (s.includes('week') || s.includes('周') || s.includes('週')) {
      return num * 10080;
    }
    if (s.includes('month') || s.includes('月')) {
      return num * 43200;
    }
    if (s.includes('year') || s.includes('年')) {
      return num * 525600;
    }
    return 0;
  }

  // ── 规则匹配（仅匹配 youtube 或 all 平台） ───────────────────────────────
  function findMatchingRule(commentText, rules) {
    if (!commentText || !Array.isArray(rules)) return null;
    const normalize = (s) => (s || '').normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    const lowerText = normalize(commentText);

    for (const rule of rules) {
      const platform = rule.platform || 'facebook';
      if (platform !== 'youtube' && platform !== 'all') continue;

      const keywords = rule.keywords || [];
      const templates = rule.dmTemplates || [];
      if (keywords.length === 0 || templates.length === 0) continue;

      for (const kw of keywords) {
        const cleanKw = normalize(kw);
        if (!cleanKw) continue;
        if (rule.matchType === 'exact') {
          if (lowerText === cleanKw) return { rule, matchedKeyword: kw };
        } else {
          if (lowerText.includes(cleanKw)) return { rule, matchedKeyword: kw };
        }
      }
    }
    return null;
  }

  // ── 可选动作：点亮创作者红心 ❤️ ───────────────────────────────────────────
  async function tryClickCreatorHeart(mainComment) {
    try {
      const heartBtns = querySelectorAllDeep('#creator-heart-button, ytcp-icon-button, button', mainComment);
      const heartKeys = ['heart', '红心', '紅心', '爱心', '愛心'];
      const alreadyHeartedKeys = ['remove heart', 'unheart', '取消红心', '移除紅心', '取消爱心', '移除愛心'];

      for (const btn of heartBtns) {
        if (!isVisible(btn)) continue;
        const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
        const pressed = btn.getAttribute('aria-pressed');
        if (pressed === 'true' || alreadyHeartedKeys.some(k => label.includes(k))) {
          return false; // 已经点过红心了
        }
        if (btn.id === 'creator-heart-button' || heartKeys.some(k => label.includes(k))) {
          btn.click();
          // 拟人化延迟 1.5 ~ 3.5 秒，打破固定脚本特征
          const delay = 1500 + Math.floor(Math.random() * 2000);
          await sleep(delay);
          return true;
        }
      }
    } catch (e) {
      console.warn("[YT Studio Engine] 点红心操作异常:", e);
    }
    return false;
  }

  // ── 拟人化填入回复并点击发送 ──────────────────────────────────────────────
  async function performCommentReply(parsed, replyText) {
    const { threadEl, mainComment } = parsed;

    try {
      threadEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(500);

      // 1. 寻找“回复 / Reply / 回覆”按钮
      const replyLabels = ['reply', '回复', '回覆'];
      let replyTrigger = querySelectorDeep('#reply-button', mainComment);
      if (!replyTrigger || !isVisible(replyTrigger)) {
        const btns = querySelectorAllDeep('ytcp-button, button', mainComment);
        replyTrigger = btns.find(b => {
          if (!isVisible(b)) return false;
          const txt = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
          return replyLabels.includes(txt);
        });
      }

      if (!replyTrigger) {
        return { success: false, statusText: "未找到回复按钮" };
      }

      replyTrigger.click();
      await sleep(800);

      // 2. 寻找回复输入框 (textarea 或 contenteditable)
      let inputBox = null;
      for (let retry = 0; retry < 5; retry++) {
        const candidates = querySelectorAllDeep('textarea, [contenteditable="true"]', threadEl);
        inputBox = candidates.find(el => isVisible(el));
        if (inputBox) break;
        await sleep(400);
      }

      if (!inputBox) {
        return { success: false, statusText: "未找到回复输入框" };
      }

      inputBox.focus();
      await sleep(300);

      // 3. 写入回复文本并触发框架事件
      if (inputBox.tagName === 'TEXTAREA' || inputBox.tagName === 'INPUT') {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(inputBox, replyText);
        } else {
          inputBox.value = replyText;
        }
        inputBox.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        inputBox.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, replyText);
        if (!(inputBox.innerText || '').includes(replyText.slice(0, 10))) {
          inputBox.textContent = replyText;
        }
        inputBox.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: replyText }));
      }

      await sleep(700);

      // 4. 寻找提交按钮（#submit-button 或 visible Reply/回复/回覆 按钮）
      let submitBtn = querySelectorDeep('#submit-button', threadEl);
      if (!submitBtn || !isVisible(submitBtn)) {
        const allBtns = querySelectorAllDeep('ytcp-button, button', threadEl);
        submitBtn = allBtns.find(b => {
          if (!isVisible(b) || b === replyTrigger) return false;
          const txt = (b.innerText || b.textContent || b.getAttribute('aria-label') || '').trim().toLowerCase();
          return replyLabels.includes(txt);
        });
      }

      if (!submitBtn) {
        return { success: false, statusText: "未找到发送按钮" };
      }

      // 等待按钮可用
      for (let w = 0; w < 6; w++) {
        const isDisabled = submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true' || submitBtn.hasAttribute('disabled');
        if (!isDisabled) break;
        await sleep(300);
      }

      if (submitBtn.disabled || submitBtn.getAttribute('aria-disabled') === 'true') {
        return { success: false, statusText: "发送按钮仍处于禁用状态" };
      }

      submitBtn.click();
      await sleep(2000);

      return { success: true, statusText: "YT公开回复成功" };
    } catch (err) {
      return { success: false, statusText: "回复异常: " + err.message };
    }
  }

  // ── 核心主巡检循环 ────────────────────────────────────────────────────────
  async function runYoutubeCommentsLoop() {
    if (isProcessingLoop) return;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }

    const settings = await StorageUtil.getSettings();
    if (!settings.ytIsRunning || settings.ytIsPaused) {
      return;
    }

    if (checkYoutubeEmergencyBrake()) return;

    isProcessingLoop = true;
    initScannedKeys(settings);

    try {
      const onInbox = await ensureOnCommentsInboxPage();
      if (!onInbox) {
        isProcessingLoop = false;
        return;
      }

      await StorageUtil.saveSettings({
        ytStatusMessage: "正在扫描 YouTube Studio 留言，检索未回复内容..."
      });

      await ensureUnrespondedFilterActive();
      await sleep(800);

      let threads = findCommentThreads();
      if (threads.length === 0) {
        window.scrollBy({ top: 400, behavior: 'smooth' });
        await sleep(1500);
        threads = findCommentThreads();
      }

      if (threads.length === 0) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        const waitSec = Math.max(5, settings.ytIdleRefreshSeconds || 20);
        await StorageUtil.saveSettings({
          ytStatusMessage: `暂无待回复 YouTube 新留言，${waitSec} 秒后自动刷新同步...`
        });
        isProcessingLoop = false;
        scheduleNextPollOrReload(waitSec, true);
        return;
      }

      const rules = await StorageUtil.getRules();
      const processedComments = await StorageUtil.getYtProcessedComments();
      const userHistory = await StorageUtil.getYtUserHistory();
      const cooldownHours = settings.ytCooldownHours !== undefined ? settings.ytCooldownHours : 24;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;

      let processedInBatch = 0;

      for (const threadEl of threads) {
        const curSettings = await StorageUtil.getSettings();
        if (!curSettings.ytIsRunning || curSettings.ytIsPaused) {
          isProcessingLoop = false;
          return;
        }
        if (checkYoutubeEmergencyBrake()) {
          isProcessingLoop = false;
          return;
        }

        const parsed = parseCommentThread(threadEl);
        if (!parsed || !parsed.commentText) continue;

        // 兜底检查：若已有子评论回复，跳过
        if (parsed.hasExistingReplies) continue;

        const commentKey = `yt_${parsed.userName}_${parsed.commentText}`.replace(/\s+/g, '_');

        // 统计已扫留言（跨自动刷新去重）
        if (!sessionScannedKeys.has(commentKey)) {
          persistScannedKey(commentKey);
          const stats = curSettings.ytStats || { totalProcessed: 0, totalReplied: 0, totalErrors: 0 };
          stats.totalProcessed += 1;
          await StorageUtil.saveSettings({ ytStats: stats });
        }

        if (sessionProcessedKeys.has(commentKey) || processedComments.includes(commentKey)) {
          continue;
        }

        // 时效过滤
        if (curSettings.ytEnableTimeWindowFilter) {
          const maxAge = curSettings.ytMaxCommentAgeMinutes || 15;
          const age = parseCommentAgeMinutes(parsed.commentTime);
          if (age > maxAge) continue;
        }

        // 24小时用户冷却去重
        const normName = parsed.userName.toLowerCase().trim();
        const userKey = "yt_usr_" + normName;
        const idKey = parsed.ytUserId ? ("yt_id_" + parsed.ytUserId) : null;
        const lastReply = Math.max(
          userHistory[userKey]?.lastReplyTime || 0,
          idKey ? (userHistory[idKey]?.lastReplyTime || 0) : 0
        );
        if (cooldownHours > 0 && lastReply > 0 && (Date.now() - lastReply < cooldownMs)) {
          continue;
        }

        // 关键词匹配（仅匹配 youtube / all 规则）
        const matchResult = findMatchingRule(parsed.commentText, rules);
        if (!matchResult) {
          sessionProcessedKeys.add(commentKey);
          continue;
        }

        // 随机挑选一套回复模板并替换变量
        const templates = matchResult.rule.dmTemplates || [];
        const rawTpl = templates[Math.floor(Math.random() * templates.length)];
        const firstName = parsed.userName.split(/\s+/)[0] || parsed.userName;
        const finalReplyText = rawTpl
          .replace(/\[userName\]/ig, parsed.userName)
          .replace(/\{userName\}/ig, parsed.userName)
          .replace(/\[FullName\]/ig, parsed.userName)
          .replace(/\{FullName\}/ig, parsed.userName)
          .replace(/\[FirstName\]/ig, firstName)
          .replace(/\{FirstName\}/ig, firstName)
          .replace(/\[姓名\]/g, parsed.userName)
          .replace(/\{姓名\}/ig, parsed.userName)
          .replace(/\[名\]/g, firstName)
          .replace(/\{名\}/ig, firstName);

        threadEl.style.boxShadow = '0 0 0 2px #ff0000';

        // 可选：先点创作者红心 ❤️
        let hearted = false;
        if (curSettings.ytAutoHeart === true) {
          hearted = await tryClickCreatorHeart(parsed.mainComment);
        }

        // 执行回复
        const replyResult = await performCommentReply(parsed, finalReplyText);
        threadEl.style.boxShadow = '';

        sessionProcessedKeys.add(commentKey);
        await StorageUtil.markYtCommentProcessed(commentKey);
        if (!processedComments.includes(commentKey)) processedComments.push(commentKey);

        const nowTs = replyResult.success ? Date.now() : 0;
        await StorageUtil.recordYtUserTouch(userKey, {
          userName: parsed.userName,
          ytUserId: parsed.ytUserId,
          replySentSuccess: replyResult.success
        });
        userHistory[userKey] = { userName: parsed.userName, lastReplyTime: nowTs };
        if (idKey) {
          await StorageUtil.recordYtUserTouch(idKey, {
            userName: parsed.userName,
            ytUserId: parsed.ytUserId,
            replySentSuccess: replyResult.success
          });
          userHistory[idKey] = { userName: parsed.userName, lastReplyTime: nowTs };
        }

        const latestSettings = await StorageUtil.getSettings();
        const stats = latestSettings.ytStats || { totalProcessed: 0, totalReplied: 0, totalErrors: 0 };
        if (replyResult.success) stats.totalReplied += 1;
        else stats.totalErrors += 1;
        await StorageUtil.saveSettings({ ytStats: stats });

        const statusDesc = replyResult.success
          ? (hearted ? "YT公开回复成功 (已点❤️)" : "YT公开回复成功")
          : replyResult.statusText;

        await StorageUtil.addLog({
          platform: "youtube",
          userName: parsed.userName,
          commentText: parsed.commentText,
          postUrl: parsed.postUrl,
          profileLink: parsed.profileLink,
          matchedKeyword: matchResult.matchedKeyword,
          dmStatus: statusDesc,
          level: replyResult.success ? "info" : "error"
        });

        // 异步同步 Google Sheets
        try {
          const now = new Date();
          const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
          const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
          const rowData = [
            timeStr,
            dateStr,
            parsed.ytUserId || "",
            parsed.userName,
            parsed.profileLink || "",
            parsed.postUrl || window.location.href,
            parsed.commentText || "",
            "YouTube评论",
            matchResult.rule.name || matchResult.matchedKeyword,
            parsed.commentTime || "刚刚",
            ""
          ];
          chrome.runtime.sendMessage({ action: "SYNC_GOOGLE_SHEETS", payload: rowData }, () => {
            if (chrome.runtime.lastError) { /* ignore */ }
          });
        } catch (e) { /* ignore */ }

        processedInBatch++;

        // 防吞评间隔 (默认 20 秒 + 0~5 秒随机浮动)
        const baseInterval = curSettings.ytReplyIntervalSeconds !== undefined ? curSettings.ytReplyIntervalSeconds : 20;
        const waitMs = baseInterval * 1000 + Math.floor(Math.random() * 5000);
        await StorageUtil.saveSettings({
          ytStatusMessage: `已回复 [${parsed.userName}]，等待 ${Math.round(waitMs / 1000)} 秒防风控后继续...`
        });
        await sleep(waitMs);
      }

      // 扫描完成一轮
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const waitSec = Math.max(5, settings.ytIdleRefreshSeconds || 20);
      await StorageUtil.saveSettings({
        ytStatusMessage: processedInBatch > 0
          ? `本轮已处理 ${processedInBatch} 条，${waitSec} 秒后自动刷新同步新留言...`
          : `当前未发现匹配规则的新留言，${waitSec} 秒后自动刷新同步...`
      });
      isProcessingLoop = false;
      scheduleNextPollOrReload(waitSec, true);

    } catch (err) {
      console.error("[YT Studio Engine] 巡检异常:", err);
      isProcessingLoop = false;
      const waitSec = Math.max(5, settings.ytIdleRefreshSeconds || 20);
      scheduleNextPollOrReload(waitSec, true);
    }
  }

  // 页面加载完成 3 秒后检查是否处于运行状态并自动拉起
  setTimeout(async () => {
    const settings = await StorageUtil.getSettings();
    if (settings.ytIsRunning && !settings.ytIsPaused) {
      runYoutubeCommentsLoop();
    }
  }, 3000);
})();
