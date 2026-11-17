document.addEventListener('DOMContentLoaded', async () => {
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const liveStatusContent = document.getElementById('liveStatusContent');
  const statProcessed = document.getElementById('statProcessed');
  const statDm = document.getElementById('statDm');
  const statSuccessLabel = document.getElementById('statSuccessLabel');
  const statErrors = document.getElementById('statErrors');
  const emergencyAlert = document.getElementById('emergencyAlert');
  const emergencyDesc = document.getElementById('emergencyDesc');
  const btnResetBrake = document.getElementById('btnResetBrake');
  const btnStart = document.getElementById('btnStart');
  const btnPause = document.getElementById('btnPause');
  const btnStop = document.getElementById('btnStop');
  const btnOpenDashboard = document.getElementById('btnOpenDashboard');
  const btnOpenCommentsManager = document.getElementById('btnOpenCommentsManager');
  const btnOpenWorkspaceText = document.getElementById('btnOpenWorkspaceText');
  const identityNoticeText = document.getElementById('identityNoticeText');
  const tabBtnFb = document.getElementById('tabBtnFb');
  const tabBtnYt = document.getElementById('tabBtnYt');
  const dotFb = document.getElementById('dotFb');
  const dotYt = document.getElementById('dotYt');

  if (!btnStart) return;

  let currentPlatform = 'facebook';

  // 智能识别当前活动标签页，若用户正在看 YouTube Studio 则默认切到 YT 面板
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.url && activeTab.url.includes('studio.youtube.com')) {
      currentPlatform = 'youtube';
    }
  } catch (e) { /* ignore */ }

  function updatePlatformTabUI() {
    if (currentPlatform === 'facebook') {
      tabBtnFb?.classList.add('active');
      tabBtnYt?.classList.remove('active');
      if (identityNoticeText) identityNoticeText.textContent = "请确保在 FB 中已切换至目标公共主页";
      if (statSuccessLabel) statSuccessLabel.textContent = "成功私信";
      if (btnOpenWorkspaceText) btnOpenWorkspaceText.textContent = "💬 打开专业面板【评论管理工具】";
    } else {
      tabBtnYt?.classList.add('active');
      tabBtnFb?.classList.remove('active');
      if (identityNoticeText) identityNoticeText.textContent = "请确保已登录目标频道的 YouTube Studio 后台";
      if (statSuccessLabel) statSuccessLabel.textContent = "成功回复";
      if (btnOpenWorkspaceText) btnOpenWorkspaceText.textContent = "📺 打开 YouTube Studio【评论收件箱】";
    }
  }

  tabBtnFb?.addEventListener('click', () => {
    currentPlatform = 'facebook';
    updatePlatformTabUI();
    refreshUI();
  });

  tabBtnYt?.addEventListener('click', () => {
    currentPlatform = 'youtube';
    updatePlatformTabUI();
    refreshUI();
  });

  async function refreshUI() {
    let settings;
    try {
      settings = await StorageUtil.getSettings();
    } catch (e) {
      liveStatusContent.textContent = "存储读取失败，请检查插件权限";
      return;
    }

    // 同步两个 Tab 上的运行绿点指示器
    if (dotFb) dotFb.className = (settings.isRunning && !settings.isPaused) ? 'tab-dot running' : 'tab-dot';
    if (dotYt) dotYt.className = (settings.ytIsRunning && !settings.ytIsPaused) ? 'tab-dot running' : 'tab-dot';

    const isYt = currentPlatform === 'youtube';
    const isRunning = isYt ? settings.ytIsRunning : settings.isRunning;
    const isPaused = isYt ? settings.ytIsPaused : settings.isPaused;
    const brakeReason = isYt ? settings.ytEmergencyBrakeReason : settings.emergencyBrakeReason;
    const statusMsg = isYt ? settings.ytStatusMessage : settings.statusMessage;

    if (isYt) {
      const ytStats = settings.ytStats || { totalProcessed: 0, totalReplied: 0, totalErrors: 0 };
      statProcessed.textContent = ytStats.totalProcessed || 0;
      statDm.textContent = ytStats.totalReplied || 0;
      statErrors.textContent = ytStats.totalErrors || 0;
    } else {
      const stats = settings.stats || { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
      statProcessed.textContent = stats.totalProcessed || 0;
      statDm.textContent = stats.totalDmSent || 0;
      statErrors.textContent = stats.totalErrors || 0;
    }

    liveStatusContent.textContent = statusMsg || "等待任务启动...";

    // 熔断警报
    if (brakeReason) {
      statusBadge.className = 'status-badge brake';
      statusText.textContent = '熔断锁定';
      emergencyAlert.style.display = 'block';
      emergencyDesc.textContent = brakeReason;
      setButtonState(false, false, false);
      return;
    }

    emergencyAlert.style.display = 'none';

    if (isRunning && !isPaused) {
      statusBadge.className = 'status-badge running';
      statusText.textContent = '运行中 🟢';
      btnStart.style.background = 'linear-gradient(135deg, #059669, #10b981)';
      btnStart.style.boxShadow = '0 0 14px rgba(16,185,129,0.5)';
      btnStart.querySelector('span:last-child').textContent = '🟢 监控运行中';
      setButtonState(false, false, false);
      btnPause.disabled = false;
      btnStop.disabled = false;
    } else if (isRunning && isPaused) {
      statusBadge.className = 'status-badge paused';
      statusText.textContent = '已暂停 ⏸';
      btnStart.style.background = '';
      btnStart.style.boxShadow = '';
      btnStart.querySelector('span:last-child').textContent = '▶ 继续运行';
      setButtonState(false, true, false);
    } else {
      statusBadge.className = 'status-badge';
      statusText.textContent = '就绪';
      btnStart.style.background = '';
      btnStart.style.boxShadow = '';
      btnStart.querySelector('span:last-child').textContent = '一键启动监控';
      setButtonState(false, true, true);
    }
  }

  function setButtonState(startDisabled, pauseDisabled, stopDisabled) {
    btnStart.disabled = startDisabled;
    btnPause.disabled = pauseDisabled;
    btnStop.disabled = stopDisabled;
  }

  function sendMessageSafe(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        if (chrome.runtime.lastError) { /* ignore */ }
      });
    } catch (e) { /* ignore */ }
  }

  btnStart.addEventListener('click', async () => {
    const settings = await StorageUtil.getSettings();
    if (currentPlatform === 'youtube') {
      const isResume = settings.ytIsRunning && settings.ytIsPaused;
      const updatePayload = {
        ytIsRunning: true,
        ytIsPaused: false,
        ytStatusMessage: isResume ? "▶ 恢复 YouTube 自动化监控..." : "🚀 正在启动 YouTube 自动化监控..."
      };
      if (!isResume) {
        updatePayload.ytTaskSessionId = Date.now();
        updatePayload.ytStats = { totalProcessed: 0, totalReplied: 0, totalErrors: 0 };
      }
      await StorageUtil.saveSettings(updatePayload);
      sendMessageSafe({ action: "YT_START_MONITOR" });
    } else {
      const isResume = settings.isRunning && settings.isPaused;
      const updatePayload = {
        isRunning: true,
        isPaused: false,
        enableCommentsManagerMode: true,
        enableTargetUrlsMode: false,
        statusMessage: isResume ? "▶ 恢复自动化监控..." : "🚀 正在启动自动化监控..."
      };
      if (!isResume) {
        updatePayload.taskSessionId = Date.now();
        updatePayload.stats = { totalProcessed: 0, totalDmSent: 0, totalErrors: 0 };
      }
      await StorageUtil.saveSettings(updatePayload);
      sendMessageSafe({ action: "START_MONITOR" });
    }
    await refreshUI();
  });

  btnPause.addEventListener('click', async () => {
    if (currentPlatform === 'youtube') {
      await StorageUtil.saveSettings({ ytIsPaused: true, ytStatusMessage: "⏸ YouTube 任务已暂停" });
      sendMessageSafe({ action: "YT_PAUSE_MONITOR" });
    } else {
      await StorageUtil.saveSettings({ isPaused: true, statusMessage: "⏸ 任务已暂停" });
      sendMessageSafe({ action: "PAUSE_MONITOR" });
    }
    await refreshUI();
  });

  btnStop.addEventListener('click', async () => {
    if (currentPlatform === 'youtube') {
      await StorageUtil.saveSettings({
        ytIsRunning: false,
        ytIsPaused: false,
        ytStatusMessage: "⏹ YouTube 任务已手动终止"
      });
      sendMessageSafe({ action: "YT_STOP_MONITOR" });
    } else {
      await StorageUtil.saveSettings({
        isRunning: false,
        isPaused: false,
        statusMessage: "⏹ 任务已手动终止"
      });
      sendMessageSafe({ action: "STOP_MONITOR" });
    }
    await refreshUI();
  });

  btnResetBrake.addEventListener('click', async () => {
    if (currentPlatform === 'youtube') {
      await StorageUtil.saveSettings({
        ytEmergencyBrakeReason: "",
        ytStatusMessage: "已解除 YouTube 熔断锁定，系统恢复就绪"
      });
    } else {
      await StorageUtil.saveSettings({
        emergencyBrakeReason: "",
        statusMessage: "已解除熔断锁定，系统恢复就绪"
      });
    }
    await refreshUI();
  });

  btnOpenDashboard.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  btnOpenCommentsManager?.addEventListener('click', () => {
    if (currentPlatform === 'youtube') {
      sendMessageSafe({ action: "OPEN_YT_STUDIO_COMMENTS" });
    } else {
      chrome.tabs.create({ url: "https://www.facebook.com/professional_dashboard/engagement/comments_manager/" });
    }
  });

  updatePlatformTabUI();
  await refreshUI();

  const timer = setInterval(refreshUI, 1500);
  window.addEventListener('unload', () => clearInterval(timer));
});
