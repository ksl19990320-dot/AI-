(async function() {
  // v2.1.0 | 2026-05-21 | drag-fix + async-init + null-guards
  window.addEventListener('error', function(e) {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#ef4444;color:#fff;padding:8px 16px;border-radius:8px;z-index:99999;font-size:13px;max-width:90vw';
    el.textContent = 'JS Error: ' + (e.message || 'unknown') + ' (' + (e.filename || '') + ':' + (e.lineno || '') + ')';
    document.body.appendChild(el);
    setTimeout(function(){ el.remove(); }, 8000);
    console.error('Global error:', e.message, e.filename, e.lineno);
  });

  const db = new ImageDB();
  try { await db.open(); } catch(e) { console.error('DB open failed:', e); }

  const providers = new ImageProviders();

  const state = {
    currentProjectId: null,
    selectedProvider: null,
    selectedModel: null,
    uploadedImages: [],
    darkMode: true,
    generating: false,
    viewMode: 'thumb',
    abortController: null,
    currentTab: 'image',
    dialogGenerating: false, dialogAttachments: [],
  };

  // ===== Simple Markdown Renderer =====
  function renderMarkdown(text) {
    if (!text) return '';
    let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/\n\n/g, '</p><p>');
    html = '<p>' + html + '</p>';
    html = html.replace(/<p>\s*<\/p>/g, '');
    html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, '<ul>$1</ul>');
    return html;
  }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  async function init() {
    await loadSettings();
    renderProviderSelect();
    loadProjects();
    loadMessages();
    loadDialogMessages();
    bindEvents();
    document.body.classList.add('dark');
    $('#chatInput').focus();
  }

  async function loadSettings() {
    try {
      const settings = await db.getAllSettings();
      if (settings.theme === 'light') { state.darkMode = false; document.body.classList.remove('dark'); }
      if (settings.lastProvider) state.selectedProvider = settings.lastProvider;
      if (settings.lastModel) state.selectedModel = settings.lastModel;
      if (settings.lastProject) state.currentProjectId = settings.lastProject;
      renderModelSelect();
    } catch(e) { console.error('loadSettings:', e); }
  }

  // ===== Project =====
  async function loadProjects() {
    try {
      const projects = await db.getProjects();
      const thumbs = await db.getAllProjectThumbnails();
      const list = $('#projectList');
      if (!list) return;
      const isThumb = state.viewMode === 'thumb';

      let html = '<div class="project-item' + (!state.currentProjectId ? ' active' : '') + (isThumb ? '' : ' list-view') + '" data-project="">'
        + '<div class="proj-thumb-placeholder">📁</div>'
        + '<div class="proj-info"><span class="proj-name">全部</span></div>'
        + '</div>';

      projects.forEach(p => {
        const thumb = thumbs[p.id];
        html += '<div class="project-item' + (state.currentProjectId === p.id ? ' active' : '') + (isThumb ? '' : ' list-view') + '" data-project="' + p.id + '">'
          + (thumb ? '<img class="proj-thumb" src="data:image/webp;base64,' + thumb + '" alt="">' : '<div class="proj-thumb-placeholder">📁</div>')
          + '<div class="proj-info"><span class="proj-name">' + escapeHtml(p.name) + '</span><span class="proj-date">' + formatTime(p.created_at) + '</span></div>'
          + '<span class="proj-del" onclick="event.stopPropagation();window._deleteProject(\'' + p.id + '\')" title="删除">×</span>'
          + '</div>';
      });
      list.innerHTML = html;
      list.querySelectorAll('.project-item').forEach(item => {
        item.addEventListener('click', () => {
          window._selectProject(item.dataset.project || null);
        });
      });
    } catch(e) { console.error('loadProjects:', e); }
  }

  window._selectProject = async function(projectId) {
    state.currentProjectId = projectId || null;
    state.uploadedImages = [];
    renderAttachPreview();
    await db.setSetting('lastProject', projectId || '');
    await loadProjects();
    loadMessages();
    loadDialogMessages();
    $('#chatInput').focus();
  };

  window._newProject = function() {
    $('#projectModalTitle').textContent = '新建项目';
    $('#projectNameInput').value = '';
    $('#projectModalSave').onclick = async () => {
      const name = $('#projectNameInput').value.trim();
      if (!name) return;
      const p = await db.createProject(name);
      $('#projectModal').classList.add('hidden');
      window._selectProject(p.id);
      toast('项目已创建', 'success');
    };
    $('#projectModal').classList.remove('hidden');
    setTimeout(() => $('#projectNameInput').focus(), 100);
  };

  window._deleteProject = async function(projectId) {
    if (!confirm('删除项目？图片将取消分类。')) return;
    await db.deleteProject(projectId);
    if (state.currentProjectId === projectId) window._selectProject(null);
    else await loadProjects();
    toast('项目已删除', 'info');
  };

  // ===== Messages =====
  async function loadMessages() {
    try {
      const all = await db._getAll('history');
      let items = all.filter(i => i.type !== 'dialog').sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (state.currentProjectId) items = items.filter(i => i.project_id === state.currentProjectId);

      const container = $('#chatMessages');
      container.innerHTML = '';
      if (items.length === 0) {
        $('#chatEmpty').classList.remove('hidden');
        return;
      }
      $('#chatEmpty').classList.add('hidden');

      items.forEach(item => {
        if (item.role === 'user' || !item.imageBase64) {
          renderUserBubble(item);
        }
        if (item.imageBase64) {
          renderAiBubble(item);
        }
      });
      scrollToBottom();
    } catch(e) { console.error('loadMessages:', e); }
  }

  function renderUserBubble(item) {
    const el = document.createElement('div');
    el.className = 'chat-bubble user';
    el.dataset.messageId = item.id;
    el.innerHTML = '<div class="chat-bubble-text">' + escapeHtml(item.prompt || '') + '</div>'
      + '<button class="msg-del-btn" onclick="event.stopPropagation();window._deleteMsg(\'' + item.id + '\')" title="删除">×</button>';
    $('#chatMessages').appendChild(el);
  }

  function renderAiBubble(item) {
    const el = document.createElement('div');
    el.className = 'chat-bubble ai';
    el.dataset.messageId = item.id;
    el.innerHTML = ''
      + '<div class="chat-bubble-image">'
      + '<img src="data:image/webp;base64,' + item.imageBase64 + '" onclick="window._openLightbox(\'' + item.id + '\')" loading="lazy">'
      + '</div>'
      + '<div class="chat-bubble-actions">'
      + '<button onclick="window._favMsg(\'' + item.id + '\')" title="收藏">' + (item.favorite ? '♥' : '♡') + '</button>'
      + '<button onclick="window._copyPrompt(\'' + item.id + '\')" title="复制提示词">↰</button>'
      + '<button onclick="window._downloadMsg(\'' + item.id + '\')" title="下载">↓</button>'
      + '</div>'
      + '<button class="msg-del-btn" onclick="event.stopPropagation();window._deleteMsg(\'' + item.id + '\')" title="删除">×</button>';
    $('#chatMessages').appendChild(el);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      $('#chatContainer').scrollTop = $('#chatContainer').scrollHeight;
    });
  }

  // ===== Send =====
  async function sendMessage() {
    if (state.generating) {
      cancelGeneration();
      return;
    }
    const prompt = $('#chatInput').value.trim();
    if (!prompt && state.uploadedImages.length === 0) return;
    if (!state.selectedProvider) { toast('请选择模型', 'error'); return; }
    if (!state.selectedModel) { toast('请选择模型', 'error'); return; }
    const hasKey = providers.getApiKey(state.selectedProvider);
    if (!hasKey) { toast('请先配置 API Key', 'error'); openSettings(); return; }

    await db.setSetting('lastProvider', state.selectedProvider);
    await db.setSetting('lastModel', state.selectedModel);

    $('#chatEmpty').classList.add('hidden');

    const userMsg = { id: crypto.randomUUID(), role: 'user', prompt: prompt || '(已上传参考图)', created_at: new Date().toISOString() };
    renderUserBubble(userMsg);
    await db._put('history', { ...userMsg, project_id: state.currentProjectId, favorite: false });

    const inputEl = $('#chatInput');
    const pendingPrompt = inputEl.value;
    inputEl.value = '';
    autoResizeTextarea();
    scrollToBottom();

    state.generating = true;
    state.abortController = new AbortController();

    const sendBtn = $('#sendBtn');
    if (!sendBtn) return;
    sendBtn.textContent = '×';
    sendBtn.classList.add('btn-cancel');

    const loadingEl = document.createElement('div');
    loadingEl.className = 'loading-dots';
    loadingEl.id = 'loadingDots';
    loadingEl.innerHTML = '<span></span><span></span><span></span>';
    $('#chatMessages').appendChild(loadingEl);
    scrollToBottom();

    try {
      let width = 1024; let height = 1024;
      const sizeVal = $('#sizeSelect')?.value;
      if (sizeVal && sizeVal.includes('x')) {
        const [w, h] = sizeVal.split('x');
        width = parseInt(w); height = parseInt(h);
      }
      const style = $('#styleSelect')?.value || '';
      const imageSize = $('#qualitySelect')?.value || '2K';

      const allMsgs = await db._getAll('history');
      let projectMsgs = allMsgs.filter(m => m.project_id === state.currentProjectId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      const lastAiMsg = projectMsgs.find(m => m.role === 'ai' && m.imageBase64);
      let contextImages = [...state.uploadedImages.map(img => img.base64)];
      if (contextImages.length === 0 && lastAiMsg && pendingPrompt) {
        contextImages = [lastAiMsg.imageBase64];
      }

      if (state.selectedProvider === 'google') {
        const gModel = state.selectedModel || 'imagen-4.0-generate-001';
        result = await providers.googleTextToImage(gModel, pendingPrompt);
      } else if (contextImages.length > 0) {
        const provider = providers.getProvider(state.selectedProvider);
        const modelInfo = provider?.models?.find(m => m.id === state.selectedModel);
        if (modelInfo && modelInfo.i2i === false) {
          throw new Error('当前模型不支持图生图，请切换模型');
        }
      }

      if (state.abortController.signal.aborted) throw new Error('已取消');

      let result;
      if (state.selectedProvider === 'google') {
        const gModel = state.selectedModel || 'imagen-4.0-generate-001';
        result = await providers.googleTextToImage(gModel, pendingPrompt);
      } else if (contextImages.length > 0) {
        result = await providers.imageToImage({
          providerKey: state.selectedProvider, model: state.selectedModel,
          prompt: pendingPrompt || 'enhance this image', negativePrompt: '',
          width, height, style, imageSize,
          imageBase64: contextImages, strength: 0.7,
        });
      } else {
        result = await providers.textToImage({
          providerKey: state.selectedProvider, model: state.selectedModel,
          prompt: pendingPrompt, negativePrompt: '', width, height, style, imageSize,
        });
      }

      if (!result.base64) { throw new Error(result.error || '生成失败'); }

      state.uploadedImages = [];
      renderAttachPreview();

      const aiMsg = {
        id: crypto.randomUUID(), role: 'ai', prompt: pendingPrompt || '',
        project_id: state.currentProjectId, favorite: false,
        provider: state.selectedProvider, model: state.selectedModel,
        params: { width, height, style, imageSize },
        imageBase64: result.base64, revisedPrompt: result.revisedPrompt || pendingPrompt,
        created_at: new Date().toISOString(),
      };
      await db._put('history', aiMsg);
      if (state.currentProjectId) await db.updateProjectTimestamp(state.currentProjectId);

      finishGeneration();
      renderAiBubble(aiMsg);
      scrollToBottom();
      launchFireworks();
      loadProjects();
    } catch (err) {
      finishGeneration();
      if (pendingPrompt && err.message !== '已取消') {
        inputEl.value = pendingPrompt;
        autoResizeTextarea();
      }
      if (err.message !== '已取消') {
        toast(err.message || '生成失败', 'error');
      }
      console.error(err);
    }
  }

  function cancelGeneration() {
    if (state.abortController) {
      state.abortController.abort();
    }
    finishGeneration();
    toast('已取消生成', 'info');
  }

  function finishGeneration() {
    state.generating = false;
    state.abortController = null;
    const ld = $('#loadingDots');
    if (ld) ld.remove();
    const sendBtn = $('#sendBtn');
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.textContent = '↑';
      sendBtn.classList.remove('btn-cancel');
    }
  }

  // ===== Message actions =====
  window._favMsg = async function(id) {
    await db.toggleFavorite(id);
    loadMessages();
  };

  window._copyPrompt = async function(id) {
    const item = await db.getHistoryItem(id);
    if (!item || !item.prompt) return;
    $('#chatInput').value = item.prompt;
    autoResizeTextarea();
    $('#chatInput').focus();
    toast('提示词已复制到输入框', 'success');
  };

  window._downloadMsg = async function(id) {
    const item = await db.getHistoryItem(id);
    if (!item || !item.imageBase64) return;
    const link = document.createElement('a');
    link.href = 'data:image/png;base64,' + item.imageBase64;
    link.download = 'ai-gen-' + id + '.png';
    link.click();
    toast('下载中...', 'success');
  };

  window._deleteMsg = async function(id) {
    await db.deleteHistory(id);
    loadMessages();
    toast('已删除', 'info');
  };

  window._openLightbox = async function(id) {
    const item = await db.getHistoryItem(id);
    if (!item || !item.imageBase64) return;
    const lb = $('#lightbox');
    lb.querySelector('img').src = 'data:image/png;base64,' + item.imageBase64;
    lb.querySelector('.lightbox-info').textContent = (item.prompt || '').substring(0, 100);
    lb.dataset.messageId = id;
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
  };

  function closeLightbox() { $('#lightbox').classList.remove('open'); document.body.style.overflow = ''; }

  // ===== Attachments =====
  function handleAttach(files) {
    const fileList = Array.from(files || []);
    fileList.forEach(file => {
      if (!file || !file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        state.uploadedImages.push({ id: crypto.randomUUID(), base64: e.target.result.split(',')[1] });
        renderAttachPreview();
      };
      reader.readAsDataURL(file);
    });
  }

  function handlePaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) imageItems.push(item.getAsFile());
    }
    if (imageItems.length > 0) {
      e.preventDefault();
      handleAttach(imageItems);
      toast('已添加 ' + imageItems.length + ' 张参考图', 'success');
    }
  }

  function renderAttachPreview() {
    const container = $('#attachPreview');
    if (state.uploadedImages.length === 0) { container.classList.add('hidden'); container.innerHTML = ''; return; }
    container.classList.remove('hidden');
    container.innerHTML = state.uploadedImages.map(img =>
      '<div class="attach-item"><img src="data:image/png;base64,' + img.base64 + '"><button class="attach-del" onclick="event.stopPropagation();window._removeAttach(\'' + img.id + '\')">×</button></div>'
    ).join('');
  }

  window._removeAttach = function(imgId) {
    state.uploadedImages = state.uploadedImages.filter(img => img.id !== imgId);
    renderAttachPreview();
  };

  // ===== Textarea auto-resize =====
  function autoResizeTextarea() {
    const el = $('#chatInput');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 360) + 'px';
  }

  // ===== Fireworks =====
  function launchFireworks() {
    const colors = ['#ff6b6b','#ffd93d','#6bcb77','#4d96ff','#ff922b','#cc5de8','#20c997','#ff6eb4'];
    ['left','right'].forEach(side => {
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'position:fixed;' + side + ':0;top:0;z-index:2001;pointer-events:none';
      canvas.width = 200; canvas.height = window.innerHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');
      const particles = [];
      const cx = side === 'left' ? 60 : 140;
      for (let i = 0; i < 80; i++) {
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2;
        const speed = 3 + Math.random() * 8;
        particles.push({ x: cx + (Math.random() - 0.5) * 30, y: canvas.height - 20, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 4, size: 3 + Math.random() * 5, color: colors[Math.floor(Math.random() * colors.length)], life: 1, decay: 0.008 + Math.random() * 0.015 });
      }
      let frame = 0;
      const animate = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;
        particles.forEach(p => {
          if (p.life <= 0) return;
          alive = true;
          p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.vx *= 0.995; p.life -= p.decay;
          ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
          const s = p.size;
          ctx.fillRect(Math.round(p.x), Math.round(p.y), s, s);
          ctx.globalAlpha = p.life * 0.5;
          ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - 2), s - 1, s - 1);
        });
        ctx.globalAlpha = 1;
        frame++;
        if (alive && frame < 150) { requestAnimationFrame(animate); }
        else { canvas.remove(); }
      };
      animate();
    });
  }

  // ===== Provider =====
  function renderProviderSelect() {
    const select = $('#providerSelect');
    if (!select) return;
    select.innerHTML = '<option value="">提供商</option>';
    providers.getProviderKeys().forEach(key => { if (key === 'google' && state.currentTab === 'dialog') return;
      const p = providers.getProvider(key);
      select.innerHTML += '<option value="' + key + '" ' + (state.selectedProvider === key ? 'selected' : '') + '>' + p.name + '</option>';
    });
  }

  function renderModelSelect() {
    const select = $('#modelSelect');
    if (!select) return;
    const provider = providers.getProvider(state.selectedProvider);
    if (!provider) { select.innerHTML = '<option value="">模型</option>'; return; }
    select.innerHTML = '<option value="">模型</option>';
    provider.models.forEach(m => {
      select.innerHTML += '<option value="' + m.id + '" ' + (state.selectedModel === m.id ? 'selected' : '') + '>' + m.name + '</option>';
    });
  }

  // ===== Theme =====
  function toggleTheme() {
    state.darkMode = !state.darkMode;
    document.body.classList.toggle('dark', state.darkMode);
    db.setSetting('theme', state.darkMode ? 'dark' : 'light');
    $('#themeToggle').textContent = state.darkMode ? '☀' : '🌙';
  }

  // ===== Settings =====
  function openSettings() {
    $$('.apikey-input').forEach(input => { input.value = providers.getApiKey(input.dataset.provider); });
    $('#settingsModal').classList.remove('hidden');
  }
  function closeSettings() { $('#settingsModal').classList.add('hidden'); }
  window._saveSettings = function() {
    $$('.apikey-input').forEach(input => { providers.setApiKey(input.dataset.provider, input.value.trim()); });
    closeSettings();
    renderProviderSelect();
    toast('设置已保存', 'success');
  };

  // ===== Toast =====
  function toast(message, type) {
    type = type || 'info';
    const container = $('#toastContainer');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => { if (el.parentNode) el.remove(); }, 3000);
  }

  // ===== Keyboard shortcuts =====
  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      if ($('#lightbox').classList.contains('open')) {
        closeLightbox();
        return;
      }
      if (!$('#settingsModal').classList.contains('hidden')) {
        closeSettings();
        return;
      }
      if (!$('#projectModal').classList.contains('hidden')) {
        $('#projectModal').classList.add('hidden');
        return;
      }
    }
  }

  // ===== Tab Switching =====
  function switchTab(tab) {
    state.currentTab = tab;
    document.querySelectorAll('.header-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    document.querySelectorAll('.chat-view').forEach(v => v.classList.remove('active'));
    if (tab === 'image') {
      document.getElementById('imageView').classList.add('active');
      document.getElementById('inputBar').classList.add('active');
      document.getElementById('chatInput').focus();
    } else {
      document.getElementById('dialogView').classList.add('active');
      document.getElementById('dialogInputBar').classList.add('active');
      document.getElementById('dialogInput').focus();
    }
  }

  // ===== Dialogue =====
  async function loadDialogMessages() {
    try {
      const all = await db._getAll('history');
      let items = all.filter(i => i.type === 'dialog').sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (state.currentProjectId) items = items.filter(i => i.project_id === state.currentProjectId);
      const container = document.getElementById('dialogMessages');
      if (!container) return;
      container.innerHTML = '';
      if (items.length === 0) { document.getElementById('dialogEmpty').classList.remove('hidden'); return; }
      document.getElementById('dialogEmpty').classList.add('hidden');
      items.forEach(item => renderDialogBubble(item));
      scrollDialogToBottom();
    } catch(e) { console.error('loadDialogMessages:', e); }
  }

  function renderDialogBubble(item) {
    const container = document.getElementById('dialogMessages');
    if (!container) return;
    const el = document.createElement('div');
    if (item.role === 'user') {
      el.className = 'dialog-bubble user';
      el.innerHTML = '<div class="dialog-bubble-text">' + escapeHtml(item.content || '') + '</div>';
    } else {
      el.className = 'dialog-bubble ai';
      el.innerHTML = '<div class="dialog-bubble-text">' + renderMarkdown(item.content || '') + '</div>'
        + '<div class="dialog-bubble-actions"><button class="dialog-bridge-btn" onclick="window._bridgeToImage(\'' + item.id + '\')">用此描述生图</button></div>';
    }
    container.appendChild(el);
  }

  function scrollDialogToBottom() {
    requestAnimationFrame(() => {
      const dc = document.getElementById('dialogContainer');
      if (dc) dc.scrollTop = dc.scrollHeight;
    });
  }

  // ===== Dialog Attachments =====
  function handleDialogAttach(files) {
    (Array.from(files||[])).forEach(file => {
      if (!file||!file.type.startsWith('image/')) return;
      const r = new FileReader();
      r.onload = e => { state.dialogAttachments.push({id:crypto.randomUUID(),base64:e.target.result.split(',')[1]}); renderDialogAttachPreview(); };
      r.readAsDataURL(file);
    });
  }
  function handleDialogPaste(e) {
    if (state.currentTab!=='dialog') return;
    const imgs = []; for (const it of (e.clipboardData?.items||[])) { if (it.type.startsWith('image/')) imgs.push(it.getAsFile()); }
    if (imgs.length>0) { e.preventDefault(); handleDialogAttach(imgs); }
  }
  function renderDialogAttachPreview() {
    const c = document.getElementById('dialogAttachPreview'); if(!c) return;
    if (state.dialogAttachments.length===0) { c.classList.add('hidden'); c.innerHTML=''; return; }
    c.classList.remove('hidden');
    c.innerHTML = state.dialogAttachments.map(img => '<div class="attach-item"><img src="data:image/png;base64,'+img.base64+'"><button class="attach-del" onclick="event.stopPropagation();window._removeDialogAttach(\''+img.id+'\')">\u00d7</button></div>').join('');
  }
  window._removeDialogAttach = function(id) { state.dialogAttachments = state.dialogAttachments.filter(i=>i.id!==id); renderDialogAttachPreview(); };
  async function sendDialogMessage() {
    if (state.dialogGenerating) return;
    const input = document.getElementById('dialogInput');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;
    const hasKey = providers.getApiKey('bltcy');
    if (!hasKey) { toast('请先配置 BLTCY AI 的 API Key', 'error'); openSettings(); return; }
    document.getElementById('dialogEmpty').classList.add('hidden');
    const attachedImages = [...state.dialogAttachments];
    state.dialogAttachments = [];
    renderDialogAttachPreview();
    const userMsg = { id: crypto.randomUUID(), role: 'user', type: 'dialog', content, images: attachedImages.map(i => i.base64), project_id: state.currentProjectId, created_at: new Date().toISOString() };
    await db._put('history', userMsg);
    renderDialogBubble(userMsg);
    input.value = '';
    scrollDialogToBottom();
    state.dialogGenerating = true;
    const sendBtn = document.getElementById('dialogSendBtn');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '...'; }
    const loadingEl = document.createElement('div');
    loadingEl.className = 'loading-dots';
    loadingEl.id = 'dialogLoadingDots';
    loadingEl.innerHTML = '<span></span><span></span><span></span>';
    const dm = document.getElementById('dialogMessages');
    if (dm) dm.appendChild(loadingEl);
    scrollDialogToBottom();
    try {
      const all = await db._getAll('history');
      let historyItems = all.filter(i => i.type === 'dialog').sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      if (state.currentProjectId) historyItems = historyItems.filter(i => i.project_id === state.currentProjectId);
      const recentItems = historyItems.slice(-20);
      const messages = [];
      recentItems.forEach(i => {
        if (i.role === 'user' && i.images && i.images.length > 0) {
          const parts = i.images.map(b64 => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }));
          parts.push({ type: 'text', text: i.content });
          messages.push({ role: 'user', content: parts });
        } else {
          messages.push({ role: i.role === 'user' ? 'user' : 'assistant', content: i.content });
        }
      });
      let dialogModel = document.getElementById('dialogModelSelect')?.value || 'gemini-3.1-pro-preview';
      let reply;
      if (dialogModel.startsWith('gemini-')) {
        reply = await providers.googleChat(dialogModel, messages);
      } else {
        reply = await providers.chat({ providerKey: 'bltcy', model: dialogModel, messages }); }
      const aiMsg = { id: crypto.randomUUID(), role: 'ai', type: 'dialog', content: reply, project_id: state.currentProjectId, created_at: new Date().toISOString() };
      await db._put('history', aiMsg);
      const ld = document.getElementById('dialogLoadingDots');
      if (ld) ld.remove();
      renderDialogBubble(aiMsg);
      scrollDialogToBottom();
    } catch (err) {
      const ld = document.getElementById('dialogLoadingDots');
      if (ld) ld.remove();
      toast(err.message || '对话失败', 'error');
      input.value = content;
      console.error(err);
    } finally {
      state.dialogGenerating = false;
      const sb = document.getElementById('dialogSendBtn');
      if (sb) { sb.disabled = false; sb.textContent = '↑'; }
    }
  }

  window._bridgeToImage = async function(msgId) {
    const item = await db.getHistoryItem(msgId);
    if (!item || !item.content) return;
    let prompt = '';
    let match = item.content.match(/(?:["\u201C\u201D])([^"\u201C\u201D]{10,200})(?:["\u201C\u201D])/);
    let codeMatch = item.content.match(/```\n?([\s\S]{10,300}?)```/);
    if (match) prompt = match[1].trim();
    else if (codeMatch) prompt = codeMatch[1].trim().replace(/\n/g, ' ');
    else prompt = item.content.substring(0, 200).trim();
    document.getElementById('chatInput').value = prompt;
    autoResizeTextarea();
    switchTab('image');
    toast('描述词已填入，选择模型后点击生成', 'success');
  };

  // ===== Events =====
  function bindEvents() {
    // Tab switching
    document.querySelectorAll('.header-tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    $('#sendBtn')?.addEventListener('click', sendMessage);

    const inputEl = $('#chatInput');
    inputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    inputEl?.addEventListener('input', autoResizeTextarea);

    $('#attachBtn')?.addEventListener('click', () => {
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true;
      fileInput.onchange = (e) => handleAttach(e.target.files);
      fileInput.click();
    });

    document.addEventListener('paste', (e) => {
      if (state.currentTab === 'dialog') { handleDialogPaste(e); return; }
      handlePaste(e);
    });
    document.addEventListener('keydown', handleKeyDown);

    const inputBar = $('#inputBar');
    const dragOverlay = $('#dragOverlay');
    if (inputBar && dragOverlay) {
      let dragCounter = 0;
      ['dragenter','dragover'].forEach(evt => {
        inputBar.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); });
      });
      document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; inputBar.querySelector('.input-bar-card')?.classList.add('drag-over'); });
      document.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; inputBar.querySelector('.input-bar-card')?.classList.remove('drag-over'); } });
      document.addEventListener('dragover', (e) => { e.preventDefault(); });
      document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        inputBar.querySelector('.input-bar-card')?.classList.remove('drag-over');
        if (e.dataTransfer?.files?.length) handleAttach(e.dataTransfer.files);
      });
    }

    $('#viewToggle')?.addEventListener('click', () => {
      state.viewMode = state.viewMode === 'thumb' ? 'list' : 'thumb';
      $('#viewToggle').textContent = state.viewMode === 'thumb' ? '≡' : '▦';
      loadProjects();
    });

    $('#newProjectBtn')?.addEventListener('click', () => window._newProject());

    $('#providerSelect')?.addEventListener('change', (e) => {
      state.selectedProvider = e.target.value || null;
      state.selectedModel = null;
      renderModelSelect();
    });
    $('#modelSelect')?.addEventListener('change', (e) => { state.selectedModel = e.target.value || null; });

    $('#lightboxClose')?.addEventListener('click', closeLightbox);
    $('#lightbox')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeLightbox(); });
    $('#lightboxDownload')?.addEventListener('click', () => { const id = $('#lightbox').dataset.messageId; if (id) window._downloadMsg(id); });
    $('#lightboxRedo')?.addEventListener('click', () => { const id = $('#lightbox').dataset.messageId; if (id) { db.getHistoryItem(id).then(item => { $('#chatInput').value = item.prompt || ''; autoResizeTextarea(); $('#chatInput').focus(); }); } closeLightbox(); });
    $('#lightboxContinue')?.addEventListener('click', () => { const id = $('#lightbox').dataset.messageId; if (id) { db.getHistoryItem(id).then(item => { if (item?.imageBase64) { state.uploadedImages = [{ id: crypto.randomUUID(), base64: item.imageBase64 }]; renderAttachPreview(); toast('已加载图片，可输入新描述继续修改', 'info'); } }); } closeLightbox(); });

    $('#themeToggle')?.addEventListener('click', toggleTheme);
    $('#settingsBtn')?.addEventListener('click', openSettings);
    $('#settingsClose')?.addEventListener('click', closeSettings);
    $('#settingsModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSettings(); });

    // Dialog events
    const dialogInputEl = document.getElementById('dialogInput');

    document.getElementById('dialogAttachBtn')?.addEventListener('click', () => {
      const fileInput = document.createElement('input');
      fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true;
      fileInput.onchange = (e) => handleDialogAttach(e.target.files);
      fileInput.click();
    });
    dialogInputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDialogMessage(); }
    });
    document.getElementById('dialogSendBtn')?.addEventListener('click', sendDialogMessage);

    $('#projectModalClose')?.addEventListener('click', () => $('#projectModal').classList.add('hidden'));
    $('#projectModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#projectModal').classList.add('hidden'); });
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function getImageDimensions(base64) { return new Promise(resolve => { const img = new Image(); img.onload = () => resolve({w:img.naturalWidth,h:img.naturalHeight}); img.onerror = () => resolve(null); img.src = 'data:image/png;base64,' + base64; }); }
  function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML; }

  init();
  console.log('AI Image Gen Workspace v2.1.0 Ready');
})();