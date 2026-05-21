(async function() {
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
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function init() {
    loadSettings();
    renderProviderSelect();
    loadProjects();
    loadMessages();
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
      let items = all.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
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

      if (contextImages.length > 0) {
        const provider = providers.getProvider(state.selectedProvider);
        const modelInfo = provider?.models?.find(m => m.id === state.selectedModel);
        if (modelInfo && modelInfo.i2i === false) {
          throw new Error('当前模型不支持图生图，请切换模型');
        }
      }

      if (state.abortController.signal.aborted) throw new Error('已取消');

      let result;
      if (contextImages.length > 0) {
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
    sendBtn.disabled = false;
    sendBtn.textContent = '↑';
    sendBtn.classList.remove('btn-cancel');
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
    providers.getProviderKeys().forEach(key => {
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

  // ===== Events =====
  function bindEvents() {
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

    document.addEventListener('paste', handlePaste);
    document.addEventListener('keydown', handleKeyDown);

    const inputBar = $('#inputBar');
    const dragOverlay = $('#dragOverlay');
    if (inputBar && dragOverlay) {
      let dragCounter = 0;
      ['dragenter','dragover'].forEach(evt => {
        inputBar.addEventListener(evt, (e) => { e.preventDefault(); e.stopPropagation(); });
      });
      document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; inputBar.classList.add('drag-over'); });
      document.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; inputBar.classList.remove('drag-over'); } });
      document.addEventListener('dragover', (e) => { e.preventDefault(); });
      document.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        inputBar.classList.remove('drag-over');
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

    $('#projectModalClose')?.addEventListener('click', () => $('#projectModal').classList.add('hidden'));
    $('#projectModal')?.addEventListener('click', (e) => { if (e.target === e.currentTarget) $('#projectModal').classList.add('hidden'); });
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML; }

  init();
  console.log('🎨 AI Image Gen Workspace Ready');
})();