/* ==========================================================================
   Sonar Edge Controller — Application Logic (pywebview edition)
   Calls Python methods directly via window.pywebview.api.*
   No HTTP — pywebview handles serialization automatically.
   ========================================================================== */

const CHANNELS = ['game', 'chat', 'mic', 'media'];
const POLL_INTERVAL = 2000;
const LEVEL_POLL_INTERVAL = 150;
const SESSION_POLL_INTERVAL = 5000;

// Friendly name → Sonar internal device name
const CHANNEL_MAP = {
  game: 'game',
  chat: 'chatRender',
  mic: 'chatCapture',
  media: 'media',
};

// Heuristic: process name → channel (lowercase match)
const PROCESS_CHANNEL_MAP = {
  'discord.exe': 'chat',
  'teamspeak3.exe': 'chat',
  'ts3client_win64.exe': 'chat',
  'slack.exe': 'chat',
  'teams.exe': 'chat',
  'ms-teams.exe': 'chat',
  'zoom.exe': 'chat',
  'skype.exe': 'chat',
  'mumble.exe': 'chat',
  'spotify.exe': 'media',
  'musicbee.exe': 'media',
  'foobar2000.exe': 'media',
  'vlc.exe': 'media',
  'itunes.exe': 'media',
  'windowsmediaplayer.exe': 'media',
  'groove music.exe': 'media',
  'amazon music.exe': 'media',
  'tidal.exe': 'media',
  'chrome.exe': 'media',
  'msedge.exe': 'media',
  'firefox.exe': 'media',
  'opera.exe': 'media',
  'brave.exe': 'media',
  'audiodg.exe': 'mic',
};

/* --------------------------------------------------------------------------
   State
   -------------------------------------------------------------------------- */

let dragging = false;
let draggingChannel = null;
let activePresetChannel = 'game';
let activeSpatialChannel = 'game';
let activeConfigIds = {};
let pollTimer = null;
let levelTimer = null;
let sessionTimer = null;
let volumeDebounceTimers = {};
let channelVolume = { game: 0, chat: 0, mic: 0, media: 0 }; // slider pos 0-1

/* --------------------------------------------------------------------------
   DOM References
   -------------------------------------------------------------------------- */

const $loading = document.getElementById('loading-screen');
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

/* --------------------------------------------------------------------------
   pywebview API helper — waits for the bridge to be ready
   -------------------------------------------------------------------------- */

function api() {
  return window.pywebview.api;
}

/* --------------------------------------------------------------------------
   Startup — poll get_status() until Sonar connects
   -------------------------------------------------------------------------- */

(function boot() {
  // pywebview injects window.pywebview after DOM ready; wait for it
  const waitForBridge = setInterval(() => {
    if (!window.pywebview) return;
    clearInterval(waitForBridge);

    const check = setInterval(async () => {
      try {
        const data = await api().get_status();
        if (data.running) {
          clearInterval(check);
          $loading.classList.add('hidden');
          $app.classList.add('visible');
          initAll();
        }
      } catch (_) { /* bridge not ready yet */ }
    }, 1000);
  }, 100);
})();

/* --------------------------------------------------------------------------
   Initialization
   -------------------------------------------------------------------------- */

function initAll() {
  fetchVolumes();
  fetchPresets('game');
  fetchSpatialState('game');
  fetchSessions();
  fetchAllEqNames();
  bindSliders();
  bindMuteButtons();
  bindPresetTabs();
  bindPresetSearch();
  bindSpatialTabs();
  bindSpatialToggle();
  bindColorPickers();
  restoreChannelColors();
  initLevelBars();
  bindChannelReorder();
  restoreChannelOrder();
  pollTimer = setInterval(fetchVolumes, POLL_INTERVAL);
  levelTimer = setInterval(fetchLevels, LEVEL_POLL_INTERVAL);
  sessionTimer = setInterval(fetchSessions, SESSION_POLL_INTERVAL);
  setInterval(fetchAllEqNames, SESSION_POLL_INTERVAL);
}

/* ==========================================================================
   Channel Color System — per-channel neon glow + fill color
   ========================================================================== */

const COLOR_MAP = {
  blue:   { glow: 'rgba(10, 132, 255, 0.35)',  fill: 'rgba(10, 132, 255, 0.6)',  border: 'rgba(10, 132, 255, 0.8)',  glowBright: 'rgba(10, 132, 255, 0.5)',  rgb: '10, 132, 255' },
  red:    { glow: 'rgba(255, 59, 48, 0.35)',    fill: 'rgba(255, 59, 48, 0.6)',   border: 'rgba(255, 59, 48, 0.8)',   glowBright: 'rgba(255, 59, 48, 0.5)',   rgb: '255, 59, 48' },
  green:  { glow: 'rgba(48, 209, 88, 0.35)',    fill: 'rgba(48, 209, 88, 0.6)',   border: 'rgba(48, 209, 88, 0.8)',   glowBright: 'rgba(48, 209, 88, 0.5)',   rgb: '48, 209, 88' },
  purple: { glow: 'rgba(191, 90, 242, 0.35)',   fill: 'rgba(191, 90, 242, 0.6)',  border: 'rgba(191, 90, 242, 0.8)',  glowBright: 'rgba(191, 90, 242, 0.5)',  rgb: '191, 90, 242' },
  orange: { glow: 'rgba(255, 159, 10, 0.35)',   fill: 'rgba(255, 159, 10, 0.6)',  border: 'rgba(255, 159, 10, 0.8)',  glowBright: 'rgba(255, 159, 10, 0.5)',  rgb: '255, 159, 10' },
  cyan:   { glow: 'rgba(100, 210, 255, 0.35)',  fill: 'rgba(100, 210, 255, 0.6)', border: 'rgba(100, 210, 255, 0.8)', glowBright: 'rgba(100, 210, 255, 0.5)', rgb: '100, 210, 255' },
  pink:   { glow: 'rgba(255, 55, 95, 0.35)',    fill: 'rgba(255, 55, 95, 0.6)',   border: 'rgba(255, 55, 95, 0.8)',   glowBright: 'rgba(255, 55, 95, 0.5)',   rgb: '255, 55, 95' },
  white:  { glow: 'rgba(224, 224, 224, 0.3)',   fill: 'rgba(224, 224, 224, 0.5)', border: 'rgba(224, 224, 224, 0.7)', glowBright: 'rgba(224, 224, 224, 0.45)', rgb: '224, 224, 224' },
};

function applyChannelColor(channel, colorName) {
  const strip = document.querySelector(`.channel-strip[data-channel="${channel}"]`);
  if (!strip || !COLOR_MAP[colorName]) return;

  const c = COLOR_MAP[colorName];
  strip.style.setProperty('--glow-color', c.glow);
  strip.style.setProperty('--glow-bright', c.glowBright);
  strip.style.setProperty('--fill-color', c.fill);
  strip.style.setProperty('--fill-border', c.border);
  strip.style.setProperty('--channel-rgb', c.rgb);
  updateLevelBarColor(channel, c.rgb);
}

function bindColorPickers() {
  // Tap channel label to toggle color picker
  document.querySelectorAll('.channel-label').forEach(label => {
    const strip = label.closest('.channel-strip');
    if (!strip) return;
    const picker = strip.querySelector('.color-picker');
    if (!picker) return;

    label.addEventListener('pointerup', e => {
      e.preventDefault();
      // Close any other open pickers
      document.querySelectorAll('.color-picker.open').forEach(p => {
        if (p !== picker) p.classList.remove('open');
      });
      picker.classList.toggle('open');
    });
  });

  // Color dot selection
  document.querySelectorAll('.color-picker').forEach(picker => {
    const channel = picker.dataset.channel;

    picker.querySelectorAll('.color-dot').forEach(dot => {
      dot.addEventListener('pointerup', e => {
        e.preventDefault();
        e.stopPropagation();
        const colorName = dot.dataset.color;

        // Update active state
        picker.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');

        // Apply color
        applyChannelColor(channel, colorName);

        // Persist
        try {
          const saved = JSON.parse(localStorage.getItem('channelColors') || '{}');
          saved[channel] = colorName;
          localStorage.setItem('channelColors', JSON.stringify(saved));
        } catch (_) {}

        // Auto-close after selection
        setTimeout(() => picker.classList.remove('open'), 300);
      });
    });
  });
}

function restoreChannelColors() {
  try {
  const saved = JSON.parse(localStorage.getItem('channelColors') || '{}');
  for (const [channel, colorName] of Object.entries(saved)) {
    applyChannelColor(channel, colorName);

    // Update the active dot
    const picker = document.querySelector(`.color-picker[data-channel="${channel}"]`);
    if (picker) {
      picker.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
      const activeDot = picker.querySelector(`.color-dot[data-color="${colorName}"]`);
      if (activeDot) activeDot.classList.add('active');
    }
  }
  } catch (_) {}
}

/* ==========================================================================
   Channel Reorder — long-press to select, tap target to swap
   Hold a channel label → it lights up. Tap another label → they swap.
   ========================================================================== */

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_THRESHOLD = 15;
let reorderSourceStrip = null;  // the strip selected for swapping

function bindChannelReorder() {
  document.querySelectorAll('.channel-strip').forEach(strip => {
    let pressTimer = null;
    let pressStartX = 0;
    let pressStartY = 0;

    strip.addEventListener('pointerdown', e => {
      // Only trigger from label area (top 60px)
      const rect = strip.getBoundingClientRect();
      if (e.clientY - rect.top > 60) return;

      pressStartX = e.clientX;
      pressStartY = e.clientY;

      pressTimer = setTimeout(() => {
        pressTimer = null;

        if (reorderSourceStrip && reorderSourceStrip !== strip) {
          // Second selection — swap them
          swapStrips(reorderSourceStrip, strip);
        } else {
          // First selection — mark as source
          selectReorderSource(strip);
        }
      }, LONG_PRESS_MS);
    });

    strip.addEventListener('pointermove', e => {
      if (pressTimer) {
        const dx = Math.abs(e.clientX - pressStartX);
        const dy = Math.abs(e.clientY - pressStartY);
        if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      }
    });

    strip.addEventListener('pointerup', e => {
      if (pressTimer) {
        clearTimeout(pressTimer);
        pressTimer = null;

        // Short tap while a source is selected → swap
        if (reorderSourceStrip && reorderSourceStrip !== strip) {
          const rect = strip.getBoundingClientRect();
          if (e.clientY - rect.top <= 60) {
            swapStrips(reorderSourceStrip, strip);
          }
        }
      }
    });

    strip.addEventListener('pointercancel', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    });
  });
}

function selectReorderSource(strip) {
  // Clear previous selection
  clearReorderSelection();

  reorderSourceStrip = strip;
  strip.classList.add('reorder-selected');

  // All other strips become targets (highlight labels)
  document.querySelectorAll('.channel-strip').forEach(s => {
    if (s !== strip) s.classList.add('reorder-target');
  });
}

function swapStrips(sourceStrip, targetStrip) {
  const parent = sourceStrip.parentNode;
  const sourceNext = sourceStrip.nextSibling;
  const targetNext = targetStrip.nextSibling;

  // True DOM swap: put each where the other was
  if (sourceNext === targetStrip) {
    parent.insertBefore(targetStrip, sourceStrip);
  } else if (targetNext === sourceStrip) {
    parent.insertBefore(sourceStrip, targetStrip);
  } else {
    parent.insertBefore(sourceStrip, targetNext);
    parent.insertBefore(targetStrip, sourceNext);
  }

  clearReorderSelection();
  saveChannelOrder();
}

function clearReorderSelection() {
  document.querySelectorAll('.reorder-selected').forEach(s => s.classList.remove('reorder-selected'));
  document.querySelectorAll('.reorder-target').forEach(s => s.classList.remove('reorder-target'));
  reorderSourceStrip = null;
}

function saveChannelOrder() {
  const order = [...document.querySelectorAll('.channel-strip')]
    .map(s => s.dataset.channel);
  try { localStorage.setItem('channelOrder', JSON.stringify(order)); } catch (_) {}
}

function restoreChannelOrder() {
  try {
  const saved = JSON.parse(localStorage.getItem('channelOrder') || '[]');
  if (!saved.length) return;

  const app = document.getElementById('app');
  const presetPanel = document.getElementById('preset-panel');

  // Reorder strips before the preset panel
  saved.forEach(ch => {
    const strip = document.querySelector(`.channel-strip[data-channel="${ch}"]`);
    if (strip) app.insertBefore(strip, presetPanel);
  });
  } catch (_) {}
}

/* ==========================================================================
   Volume System
   ========================================================================== */

/* --- Volume Curve ---------------------------------------------------------
   Power curve so the slider is usable. Linear sliders feel way too loud in
   the first 10%. With exponent 2.5:
     slider 10% → volume  3%    (quiet, usable)
     slider 50% → volume 18%    (moderate)
     slider 80% → volume 57%    (loud)
     slider 100% → volume 100%  (max)
   -------------------------------------------------------------------------- */
const VOL_EXPONENT = 2.5;

function sliderToVolume(sliderPos) {
  // slider 0-1 → actual volume 0-1 (power curve)
  return Math.pow(sliderPos, VOL_EXPONENT);
}

function volumeToSlider(volume) {
  // actual volume 0-1 → slider position 0-1 (inverse)
  return Math.pow(volume, 1 / VOL_EXPONENT);
}

async function fetchVolumes() {
  try {
    const data = await api().get_volumes();
    if (data.error) throw new Error(data.error);

    CHANNELS.forEach(ch => {
      if (dragging && draggingChannel === ch) return;

      const sonarKey = CHANNEL_MAP[ch];
      const info = data[sonarKey];
      if (!info) return;

      // Convert actual volume → slider position for display
      const sliderPos = volumeToSlider(info.volume);
      channelVolume[ch] = sliderPos;
      updateSliderUI(ch, sliderPos);
      updateMuteUI(ch, info.muted);
    });
  } catch (_) {
    showToast('Sonar disconnected');
  }
}

function updateSliderUI(channel, sliderPos) {
  const strip = document.querySelector(`.channel-strip[data-channel="${channel}"]`);
  if (!strip) return;

  const track = strip.querySelector('.slider-track');
  const thumb = strip.querySelector('.slider-thumb');
  const fill = strip.querySelector('.slider-fill');
  const display = strip.querySelector('.volume-display');

  const trackH = track.clientHeight;
  const thumbH = thumb.clientHeight;
  const usable = trackH - thumbH;

  const topPx = usable - (sliderPos * usable);
  thumb.style.top = `${topPx}px`;
  fill.style.height = `${sliderPos * 100}%`;
  // Show the actual volume percentage (after curve)
  display.textContent = `${Math.round(sliderToVolume(sliderPos) * 100)}%`;
}

function updateMuteUI(channel, muted) {
  const btn = document.querySelector(`.mute-btn[data-channel="${channel}"]`);
  if (!btn) return;
  btn.dataset.muted = String(muted);
  btn.classList.toggle('muted', !!muted);
}

/* ==========================================================================
   Slider Pointer Events
   ========================================================================== */

function bindSliders() {
  document.querySelectorAll('.slider-thumb').forEach(thumb => {
    const channel = thumb.dataset.channel;
    let startY = 0;
    let startValue = 0;

    thumb.addEventListener('pointerdown', e => {
      e.preventDefault();
      thumb.setPointerCapture(e.pointerId);
      thumb.classList.add('active');
      dragging = true;
      draggingChannel = channel;
      startY = e.clientY;

      const track = thumb.closest('.slider-track');
      const trackH = track.clientHeight;
      const thumbH = thumb.clientHeight;
      const usable = trackH - thumbH;
      const topPx = parseFloat(thumb.style.top) || 0;
      startValue = usable > 0 ? 1 - (topPx / usable) : 0;
    });

    thumb.addEventListener('pointermove', e => {
      if (!dragging || draggingChannel !== channel) return;
      e.preventDefault();

      const track = thumb.closest('.slider-track');
      const trackH = track.clientHeight;
      const thumbH = thumb.clientHeight;
      const usable = trackH - thumbH;

      const deltaY = startY - e.clientY;
      const deltaValue = usable > 0 ? deltaY / usable : 0;
      const value = Math.max(0, Math.min(1, startValue + deltaValue));

      channelVolume[channel] = value;
      updateSliderUI(channel, value);
      debounceVolumePut(channel, value);
    });

    thumb.addEventListener('pointerup', e => {
      thumb.releasePointerCapture(e.pointerId);
      thumb.classList.remove('active');

      if (dragging && draggingChannel === channel) {
        const track = thumb.closest('.slider-track');
        const trackH = track.clientHeight;
        const thumbH = thumb.clientHeight;
        const usable = trackH - thumbH;
        const topPx = parseFloat(thumb.style.top) || 0;
        const finalValue = usable > 0 ? 1 - (topPx / usable) : 0;
        putVolume(channel, finalValue);
      }

      dragging = false;
      draggingChannel = null;
    });

    thumb.addEventListener('pointercancel', () => {
      thumb.classList.remove('active');
      dragging = false;
      draggingChannel = null;
    });
  });
}

function debounceVolumePut(channel, value) {
  clearTimeout(volumeDebounceTimers[channel]);
  volumeDebounceTimers[channel] = setTimeout(() => putVolume(channel, value), 50);
}

async function putVolume(channel, sliderPos) {
  try {
    // Convert slider position → actual volume via power curve
    const actualVolume = sliderToVolume(sliderPos);
    await api().set_volume(channel, actualVolume);
  } catch (_) {
    showToast('Sonar disconnected');
  }
}

/* ==========================================================================
   Mute System
   ========================================================================== */

function bindMuteButtons() {
  document.querySelectorAll('.mute-btn').forEach(btn => {
    btn.addEventListener('pointerup', async e => {
      e.preventDefault();
      const channel = btn.dataset.channel;
      const wasMuted = btn.dataset.muted === 'true';
      const newMuted = !wasMuted;

      updateMuteUI(channel, newMuted);

      try {
        const result = await api().set_mute(channel, newMuted);
        if (result.error) throw new Error(result.error);
      } catch (_) {
        updateMuteUI(channel, wasMuted);
        showToast('Sonar disconnected');
      }
    });
  });
}

/* ==========================================================================
   Preset System
   ========================================================================== */

function bindPresetTabs() {
  document.querySelectorAll('.panel-tab').forEach(tab => {
    tab.addEventListener('pointerup', () => {
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activePresetChannel = tab.dataset.channel;
      document.querySelector('.preset-search').value = '';
      fetchPresets(activePresetChannel);
    });
  });
}

async function fetchPresets(channel) {
  const list = document.querySelector('.preset-list');
  if (!list) return;

  try {
    const presets = await api().get_presets(channel);
    if (presets.error) throw new Error(presets.error);

    list.innerHTML = '';

    const hasTracked = presets.some(p => p.isActive);

    presets.forEach((preset, idx) => {
      const card = document.createElement('div');
      card.className = 'preset-card';
      card.dataset.id = preset.id || '';
      card.dataset.channel = channel;

      if (preset.isActive || (!hasTracked && idx === 0)) {
        card.classList.add('active');
      }

      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = preset.name || 'Unnamed';

      const indicator = document.createElement('span');
      indicator.className = 'preset-active-indicator';

      card.appendChild(name);
      card.appendChild(indicator);
      list.appendChild(card);
    });

    bindPresetClicks();
    restoreFonts();
  } catch (_) {
    showToast('Sonar disconnected');
  }
}

function bindPresetClicks() {
  document.querySelectorAll('.preset-card').forEach(card => {
    const fresh = card.cloneNode(true);
    card.parentNode.replaceChild(fresh, card);

    fresh.addEventListener('pointerup', async () => {
      const configId = fresh.dataset.id;
      const channel = fresh.dataset.channel;
      const presetName = fresh.querySelector('.preset-name')?.textContent || '';

      document.querySelectorAll('.preset-card').forEach(c => c.classList.remove('active'));
      fresh.classList.add('active');

      updateEqDisplay(channel, presetName);

      try {
        const result = await api().set_preset(channel, configId);
        if (result.error) throw new Error(result.error);
        activeConfigIds[channel] = configId;
      } catch (_) {
        fetchPresets(channel);
        showToast('Sonar disconnected');
      }
    });
  });
}

function bindPresetSearch() {
  const input = document.querySelector('.preset-search');
  if (!input) return;

  input.addEventListener('input', () => {
    const query = input.value.toLowerCase();
    document.querySelectorAll('.preset-card').forEach(card => {
      const name = card.querySelector('.preset-name').textContent.toLowerCase();
      card.style.display = name.includes(query) ? '' : 'none';
    });
  });
}

/* ==========================================================================
   EQ Display — show active preset name per channel
   ========================================================================== */

let lastKnownEq = {};

function updateEqDisplay(channel, presetName) {
  const el = document.querySelector(`.eq-display[data-channel="${channel}"]`);
  if (el) el.textContent = presetName || '';
}

async function fetchAllEqNames() {
  for (const ch of CHANNELS) {
    try {
      const data = await api().get_active_config(ch);
      const name = data.presetName || 'Custom';
      const configId = data.configId || null;

      updateEqDisplay(ch, name);

      if (configId && lastKnownEq[ch] !== configId) {
        lastKnownEq[ch] = configId;
        if (ch === activePresetChannel) {
          fetchPresets(ch);
        }
      }
    } catch (_) { /* silent */ }
  }
}

/* ==========================================================================
   Spatial Audio System
   ========================================================================== */

function bindSpatialTabs() {
  document.querySelectorAll('.spatial-channel-tab').forEach(tab => {
    tab.addEventListener('pointerup', () => {
      document.querySelectorAll('.spatial-channel-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeSpatialChannel = tab.dataset.channel;
      document.querySelector('.spatial-toggle').dataset.channel = activeSpatialChannel;
      fetchSpatialState(activeSpatialChannel);
    });
  });
}

async function fetchSpatialState(channel) {
  const toggle = document.querySelector('.spatial-toggle');
  if (!toggle) return;

  try {
    const data = await api().get_spatial(channel);
    if (data.error) throw new Error(data.error);
    const enabled = data.enabled ?? false;
    toggle.dataset.enabled = String(enabled);
    toggle.classList.toggle('on', enabled);
  } catch (_) { /* silent */ }
}

function bindSpatialToggle() {
  const toggle = document.querySelector('.spatial-toggle');
  if (!toggle) return;

  toggle.addEventListener('pointerup', async () => {
    const wasEnabled = toggle.dataset.enabled === 'true';
    const newEnabled = !wasEnabled;

    toggle.dataset.enabled = String(newEnabled);
    toggle.classList.toggle('on', newEnabled);

    try {
      const result = await api().set_spatial(activeSpatialChannel, newEnabled);
      if (result.error) throw new Error(result.error);
    } catch (_) {
      toggle.dataset.enabled = String(wasEnabled);
      toggle.classList.toggle('on', wasEnabled);
      showToast('Sonar disconnected');
    }
  });
}

/* ==========================================================================
   Audio Sessions — show what's playing per channel
   ========================================================================== */

async function fetchSessions() {
  try {
    const sessions = await api().get_sessions();

    const channelApps = { game: [], chat: [], mic: [], media: [] };

    sessions.forEach(s => {
      const serverCh = s.channel;
      const procLower = (s.name || '').toLowerCase();
      const ch = (serverCh && channelApps[serverCh]) ? serverCh : (PROCESS_CHANNEL_MAP[procLower] || 'game');
      const displayName = (s.name || '').replace(/\.exe$/i, '');
      if (!displayName || displayName.toLowerCase() === 'audiodg' ||
          displayName.toLowerCase().includes('steelseries')) return;
      if (!channelApps[ch].includes(displayName)) {
        channelApps[ch].push(displayName);
      }
    });

    CHANNELS.forEach(ch => {
      const el = document.querySelector(`.session-display[data-channel="${ch}"]`);
      if (!el) return;
      const apps = channelApps[ch];
      el.textContent = apps.length > 0 ? apps.slice(0, 2).join(', ') : '';
    });
  } catch (_) { /* silent */ }
}

/* ==========================================================================
   Real-Time Audio Levels — vertical bouncing bars
   ========================================================================== */

const LEVEL_BAR_COUNT = 14;
const BAR_GAP = 2;

const channelPeaks = { game: 0, chat: 0, mic: 0, media: 0 };
const smoothPeaks  = { game: 0, chat: 0, mic: 0, media: 0 };
const levelCanvases = {};  // channel → { ctx, w, h, waves, grad, barW }
let _lastFrameTime = 0;

function initLevelBars() {
  CHANNELS.forEach(ch => {
    const strip = document.querySelector(`.channel-strip[data-channel="${ch}"]`);
    if (!strip) return;
    const container = strip.querySelector('.level-bars');
    if (!container) return;

    const canvas = document.createElement('canvas');
    container.appendChild(canvas);

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const totalGap = (LEVEL_BAR_COUNT - 1) * BAR_GAP;
    const barW = (w - totalGap) / LEVEL_BAR_COUNT;

    // 3 layered sine waves per bar — pre-computed, never changes
    const waves = [];
    for (let i = 0; i < LEVEL_BAR_COUNT; i++) {
      waves.push([
        { phase: (i / LEVEL_BAR_COUNT) * Math.PI * 2,       speed: 2.2 + i * 0.15 },
        { phase: (i / LEVEL_BAR_COUNT) * Math.PI * 3 + 1.0, speed: 3.7 + i * 0.1  },
        { phase: (i / LEVEL_BAR_COUNT) * Math.PI * 5 + 2.5, speed: 5.3 - i * 0.08 },
      ]);
    }

    // Pre-build the gradient (full canvas height, cached — rebuilt on color change)
    const rgb = '10, 132, 255';
    const grad = buildBarGradient(ctx, h, rgb);

    levelCanvases[ch] = { ctx, w, h, waves, grad, barW, rgb };
  });

  requestAnimationFrame(renderLevelBars);
}

function buildBarGradient(ctx, h, rgb) {
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0,   `rgba(${rgb}, 0.20)`);
  grad.addColorStop(0.2, `rgba(${rgb}, 0.50)`);
  grad.addColorStop(0.5, `rgba(${rgb}, 0.80)`);
  grad.addColorStop(0.8, `rgba(${rgb}, 1)`);
  grad.addColorStop(1,   `rgba(${rgb}, 1)`);
  return grad;
}

function updateLevelBarColor(channel, rgb) {
  const c = levelCanvases[channel];
  if (!c || c.rgb === rgb) return;
  c.rgb = rgb;
  c.grad = buildBarGradient(c.ctx, c.h, rgb);
}

async function fetchLevels() {
  try {
    const sessions = await api().get_levels();
    channelPeaks.game = 0; channelPeaks.chat = 0;
    channelPeaks.mic = 0;  channelPeaks.media = 0;

    sessions.forEach(s => {
      const serverCh = s.channel;
      const procLower = (s.name || '').toLowerCase();
      const ch = (serverCh && channelPeaks[serverCh] !== undefined) ? serverCh : (PROCESS_CHANNEL_MAP[procLower] || 'game');
      if (s.peak > channelPeaks[ch]) channelPeaks[ch] = s.peak;
    });
  } catch (_) {}
}

function renderLevelBars(timestamp) {
  const dt = _lastFrameTime ? (timestamp - _lastFrameTime) / 1000 : 0.016;
  _lastFrameTime = timestamp;
  const t = timestamp / 1000;

  const riseRate = 14 * dt;
  const fallRate = 3.5 * dt;

  for (let ci = 0; ci < CHANNELS.length; ci++) {
    const ch = CHANNELS[ci];
    const c = levelCanvases[ch];
    if (!c) continue;

    const target = channelPeaks[ch];
    const current = smoothPeaks[ch];
    smoothPeaks[ch] = target > current
      ? Math.min(target, current + riseRate)
      : Math.max(target, current - fallRate);
    const peak = smoothPeaks[ch];

    const { ctx, w, h, waves, grad, barW } = c;
    ctx.clearRect(0, 0, w, h);

    // Scale bars by slider position so they correlate with volume
    const vol = channelVolume[ch] || 0;
    const scaled = peak * vol;
    if (scaled < 0.003) continue;

    ctx.fillStyle = grad;
    const spread = 0.08 * (1 - scaled);

    for (let i = 0; i < LEVEL_BAR_COUNT; i++) {
      const wv = waves[i];
      const wave = Math.sin(t * wv[0].speed + wv[0].phase) * 0.5
                 + Math.sin(t * wv[1].speed + wv[1].phase) * 0.3
                 + Math.sin(t * wv[2].speed + wv[2].phase) * 0.2;

      const barH = Math.max(2, Math.min(1, scaled + spread * wave) * h);
      const x = i * (barW + BAR_GAP);
      ctx.fillRect(x, h - barH, barW, barH);
    }
  }

  requestAnimationFrame(renderLevelBars);
}

/* ==========================================================================
   Toast Notification
   ========================================================================== */

let toastTimer = null;

function showToast(message) {
  $toast.textContent = message;
  $toast.classList.add('visible');

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $toast.classList.remove('visible');
  }, 3000);
}

/* ==========================================================================
   Close Button
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('pointerup', e => {
      e.preventDefault();
      try { window.pywebview.api.close_app(); } catch (_) {}
    });
  }
});

/* ==========================================================================
   Font Picker — 12 fonts × 3 zones (headers, mute, panel)
   ========================================================================== */

const FONT_LIST = [
  { name: 'Orbitron',          css: "'Orbitron', monospace",              label: 'ORBITRON' },
  { name: 'Rajdhani',          css: "'Rajdhani', sans-serif",             label: 'RAJDHANI' },
  { name: 'Audiowide',         css: "'Audiowide', sans-serif",            label: 'AUDIOWIDE' },
  { name: 'Chakra Petch',      css: "'Chakra Petch', sans-serif",         label: 'CHAKRA PETCH' },
  { name: 'Exo 2',             css: "'Exo 2', sans-serif",               label: 'EXO 2' },
  { name: 'Teko',              css: "'Teko', sans-serif",                 label: 'TEKO' },
  { name: 'Russo One',         css: "'Russo One', sans-serif",            label: 'RUSSO ONE' },
  { name: 'Bungee',            css: "'Bungee', sans-serif",               label: 'BUNGEE' },
  { name: 'Black Ops One',     css: "'Black Ops One', sans-serif",        label: 'BLACK OPS' },
  { name: 'Press Start 2P',    css: "'Press Start 2P', monospace",        label: 'PRESS START' },
  { name: 'Permanent Marker',  css: "'Permanent Marker', cursive",        label: 'MARKER' },
  { name: 'Silkscreen',        css: "'Silkscreen', monospace",            label: 'SILKSCREEN' },
];

// Zone → CSS selectors to update
const FONT_ZONES = {
  headers: '.channel-label',
  mute:    '.mute-btn',
  panel:   '.panel-tab, .preset-search, .preset-name, .spatial-label, .spatial-channel-tab, .font-zone-tab',
};

let activeFontZone = 'headers';

function initFontPicker() {
  const modal = document.getElementById('font-modal');
  const fontBtn = document.getElementById('font-btn');
  const grid = document.getElementById('font-grid');
  if (!modal || !fontBtn || !grid) return;

  // Toggle modal
  fontBtn.addEventListener('pointerup', e => {
    e.preventDefault();
    modal.classList.toggle('open');
    if (modal.classList.contains('open')) renderFontGrid();
  });

  // Close on overlay click
  modal.addEventListener('pointerup', e => {
    if (e.target === modal) modal.classList.remove('open');
  });

  // Zone tabs
  document.querySelectorAll('.font-zone-tab').forEach(tab => {
    tab.addEventListener('pointerup', e => {
      e.preventDefault();
      document.querySelectorAll('.font-zone-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFontZone = tab.dataset.zone;
      renderFontGrid();
    });
  });

  renderFontGrid();
}

function renderFontGrid() {
  const grid = document.getElementById('font-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const saved = getSavedFonts();
  const currentFont = saved[activeFontZone] || 'Orbitron';

  FONT_LIST.forEach(font => {
    const btn = document.createElement('button');
    btn.className = 'font-option';
    btn.style.fontFamily = font.css;
    btn.textContent = font.label;
    if (font.name === currentFont) btn.classList.add('active');

    btn.addEventListener('pointerup', e => {
      e.preventDefault();
      e.stopPropagation();
      applyFont(activeFontZone, font.name, font.css);

      // Update active state
      grid.querySelectorAll('.font-option').forEach(o => o.classList.remove('active'));
      btn.classList.add('active');

      // Save
      const s = getSavedFonts();
      s[activeFontZone] = font.name;
      try { localStorage.setItem('channelFonts', JSON.stringify(s)); } catch (_) {}
    });

    grid.appendChild(btn);
  });
}

function applyFont(zone, fontName, fontCss) {
  const selectors = FONT_ZONES[zone];
  if (!selectors) return;
  document.querySelectorAll(selectors).forEach(el => {
    el.style.fontFamily = fontCss;
  });
}

function getSavedFonts() {
  try { return JSON.parse(localStorage.getItem('channelFonts') || '{}'); }
  catch (_) { return {}; }
}

function restoreFonts() {
  const saved = getSavedFonts();
  for (const [zone, fontName] of Object.entries(saved)) {
    const font = FONT_LIST.find(f => f.name === fontName);
    if (font) applyFont(zone, font.name, font.css);
  }
}

// Wire up on init (called after DOM ready from boot)
document.addEventListener('DOMContentLoaded', () => {
  const wait = setInterval(() => {
    if (document.getElementById('font-grid')) {
      clearInterval(wait);
      initFontPicker();
      restoreFonts();
    }
  }, 200);
});

/* ==========================================================================
   Background Image — tap BG button to pick an image via native file dialog,
   long-press BG button to clear the background.
   Uses pywebview Python API for the file picker (no HTML file input).
   Stored as base64 data URL in localStorage.
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  const bgBtn = document.getElementById('bg-btn');
  if (!bgBtn) return;

  let bgLongPress = null;
  let bgLongFired = false;

  // Short tap → open native file picker via Python
  bgBtn.addEventListener('pointerup', async e => {
    e.preventDefault();
    if (bgLongFired) { bgLongFired = false; return; }
    if (bgLongPress) { clearTimeout(bgLongPress); bgLongPress = null; }

    try {
      const result = await api().pick_bg_image();
      if (result.error) { showToast(result.error); return; }
      if (result.cancelled) return;
      applyBgImage(result.dataUrl);
      try { localStorage.setItem('bgImage', result.dataUrl); } catch (_) {}
    } catch (_) {
      showToast('Could not open file picker');
    }
  });

  // Long press → clear background
  bgBtn.addEventListener('pointerdown', e => {
    bgLongFired = false;
    bgLongPress = setTimeout(() => {
      bgLongPress = null;
      bgLongFired = true;
      clearBgImage();
    }, 800);
  });

  bgBtn.addEventListener('pointermove', () => {
    if (bgLongPress) { clearTimeout(bgLongPress); bgLongPress = null; }
  });

  bgBtn.addEventListener('pointercancel', () => {
    if (bgLongPress) { clearTimeout(bgLongPress); bgLongPress = null; }
  });

  // Restore on load
  restoreBgImage();
});

function applyBgImage(dataUrl) {
  document.body.style.backgroundImage = `url("${dataUrl}")`;
  document.body.classList.add('has-bg-image');
  const bgBtn = document.getElementById('bg-btn');
  if (bgBtn) bgBtn.classList.add('active');
}

function clearBgImage() {
  document.body.style.backgroundImage = '';
  document.body.classList.remove('has-bg-image');
  const bgBtn = document.getElementById('bg-btn');
  if (bgBtn) bgBtn.classList.remove('active');
  try { localStorage.removeItem('bgImage'); } catch (_) {}
}

function restoreBgImage() {
  try {
    const saved = localStorage.getItem('bgImage');
    if (saved) applyBgImage(saved);
  } catch (_) {}
}
