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

// Apps that should NEVER show in the Game channel display (even if Sonar routes them there)
const GAME_CHANNEL_EXCLUDE = [
  'discord', 'teamspeak3', 'ts3client_win64', 'slack', 'teams', 'ms-teams',
  'zoom', 'skype', 'mumble',
  'spotify', 'musicbee', 'foobar2000', 'vlc', 'itunes', 'windowsmediaplayer',
  'groove music', 'amazon music', 'tidal',
  'chrome', 'msedge', 'firefox', 'opera', 'brave',
  'audiodg', 'steelseriessonar', 'steelseriesgg', 'steelseries',
  'auralink', 'explorer', 'shellexperiencehost', 'runtimebroker',
  'searchhost', 'startmenuexperiencehost', 'textinputhost',
  'applicationframehost', 'systemsettings', 'windowsterminal',
];

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
let eqPanelVisible = false;
let deckButtons = [];       // array of 20 slots (null = empty)
let deckDeleteMode = false;
let utilityButtons = [];    // array of 5 slots (null = empty) for the utility row
let pickerTarget = 'deck';  // 'deck' | 'utility' — which array openTypePicker writes to
const DECK_SLOTS = 20;
const UTILITY_SLOTS = 5;
const DECK_LONG_PRESS_MS = 600;

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
  initSpotify();
  initMediaBar();
  initSpotifySearch();
  bindEqToggle();
  bindChannelReorder();
  restoreChannelOrder();
  initUtilityPanel();
  initUtilityBar();
  pollTimer = setInterval(fetchVolumes, POLL_INTERVAL);
  levelTimer = setInterval(fetchLevels, LEVEL_POLL_INTERVAL);
  sessionTimer = setInterval(fetchSessions, SESSION_POLL_INTERVAL);
  setInterval(fetchAllEqNames, SESSION_POLL_INTERVAL);
  setInterval(updateDeckStates, 3000);
  setTimeout(updateDeckStates, 2000); // initial check after boot
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
  const utilityPanel = document.getElementById('utility-panel');
  const insertTarget = utilityPanel || document.getElementById('dynamic-zone');

  // Reorder strips before the launch pad (or preset panel as fallback)
  saved.forEach(ch => {
    const strip = document.querySelector(`.channel-strip[data-channel="${ch}"]`);
    if (strip) app.insertBefore(strip, insertTarget);
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
    restoreFontColors();
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

      // Filter non-game apps from the game channel
      if (ch === 'game') {
        const nameLower = displayName.toLowerCase();
        if (GAME_CHANNEL_EXCLUDE.some(ex => nameLower.includes(ex))) return;
      }

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

// Game-channel detection → pause bg-video while gaming.
// Rising edge fires pauseForGame() immediately; falling edge starts a 5s
// debounce so quick alt-tabs / menu transitions don't flap the video.
let _auraGameActive = false;
let _auraResumeTimer = null;
const AURA_RESUME_DEBOUNCE_MS = 5000;

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

    // Check only the *server-assigned* channel — never the post-fallback ch,
    // since the fallback would treat any unrecognized session as 'game'.
    // Require peak > 0: Sonar's Game endpoint is the *default* output for any
    // process that hasn't been explicitly routed elsewhere, so silent system
    // processes (TextInputHost.exe, Claude desktop, etc.) permanently sit on
    // game channel with peak=0. The 5s resume debounce below covers the gaps
    // between sound peaks within a game.
    const gameActive = sessions.some(s => s.channel === 'game' && s.peak > 0);
    if (gameActive !== _auraGameActive) {
      _auraGameActive = gameActive;
      if (gameActive) {
        if (_auraResumeTimer) { clearTimeout(_auraResumeTimer); _auraResumeTimer = null; }
        pauseForGame();
      } else {
        if (_auraResumeTimer) clearTimeout(_auraResumeTimer);
        _auraResumeTimer = setTimeout(() => {
          _auraResumeTimer = null;
          if (!_auraGameActive) resumeFromGame();
        }, AURA_RESUME_DEBOUNCE_MS);
      }
    }
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
   EQ Panel Toggle
   ========================================================================== */

function bindEqToggle() {
  const btn = document.getElementById('eq-toggle-btn');
  const overlay = document.getElementById('eq-overlay');
  if (!btn || !overlay) return;

  btn.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    eqPanelVisible = !eqPanelVisible;
    overlay.classList.toggle('eq-visible', eqPanelVisible);
    btn.classList.toggle('eq-active', eqPanelVisible);
  });

  // Tap the overlay backdrop (not preset panel children) to dismiss
  overlay.addEventListener('pointerup', (e) => {
    if (e.target === overlay) {
      eqPanelVisible = false;
      overlay.classList.remove('eq-visible');
      btn.classList.remove('eq-active');
    }
  });
}

/* ==========================================================================
   Stream Deck — customizable button grid
   ========================================================================== */

// Lucide-style SVG icons (stroke-based, clean line art)
const _S = 'stroke="currentColor" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const MEDIA_ICONS = {
  play_pause: `<svg viewBox="0 0 24 24" ${_S}><polygon points="5 3 19 12 5 21 5 3"/></svg>`,
  next: `<svg viewBox="0 0 24 24" ${_S}><polygon points="5 4 15 12 5 20 5 4"/><line x1="19" y1="5" x2="19" y2="19"/></svg>`,
  prev: `<svg viewBox="0 0 24 24" ${_S}><polygon points="19 20 9 12 19 4 19 20"/><line x1="5" y1="19" x2="5" y2="5"/></svg>`,
  stop: `<svg viewBox="0 0 24 24" ${_S}><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
};

const HOTKEY_ICON = `<svg viewBox="0 0 24 24" ${_S}><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6.01" y2="8"/><line x1="10" y1="8" x2="10.01" y2="8"/><line x1="14" y1="8" x2="14.01" y2="8"/><line x1="18" y1="8" x2="18.01" y2="8"/><line x1="6" y1="12" x2="6.01" y2="12"/><line x1="18" y1="12" x2="18.01" y2="12"/><line x1="8" y1="16" x2="16" y2="16"/></svg>`;

const SPEAKER_ICON = `<svg viewBox="0 0 24 24" ${_S}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;

const KEYLIGHT_ICON = `<svg viewBox="0 0 24 24" ${_S}><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/></svg>`;

const MELD_ICON = `<svg viewBox="0 0 24 24" ${_S}><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`;
const MELD_RECORD_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="currentColor"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
const MELD_STREAM_ICON = `<svg viewBox="0 0 24 24" ${_S}><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>`;

// Discord logo (filled, not stroke-based — it's a brand mark)
const DISCORD_ICON = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>';

const SPOTIFY_ICON = `<svg viewBox="0 0 24 24" ${_S}><circle cx="12" cy="12" r="10"/><path d="M8 11.5c2.5-.7 5.5-.7 8 .5"/><path d="M8 14c2-.5 4.5-.5 6.5.5"/><path d="M9 16c1.5-.4 3.5-.3 5 .4"/></svg>`;

function initStreamDeck() {
  loadDeckButtons();
  renderStreamDeck();
  // Toolbar button toggles between + (normal) and − (delete mode)
  const addBtn = document.getElementById('stream-deck-add');
  if (addBtn) {
    addBtn.addEventListener('pointerup', () => {
      if (deckDeleteMode) {
        exitDeckDeleteMode();
      } else {
        enterDeckDeleteMode();
      }
    });
  }
}

function loadDeckButtons() {
  try {
    const raw = localStorage.getItem('streamDeckButtons');
    if (raw) {
      deckButtons = JSON.parse(raw);
    }
  } catch (_) {}
  // Ensure exactly DECK_SLOTS entries
  while (deckButtons.length < DECK_SLOTS) deckButtons.push(null);
  deckButtons.length = DECK_SLOTS;
}

function saveDeckButtons() {
  localStorage.setItem('streamDeckButtons', JSON.stringify(deckButtons));
}

function renderStreamDeck() {
  const grid = document.getElementById('stream-deck-grid');
  if (!grid) return;
  grid.innerHTML = '';

  for (let i = 0; i < DECK_SLOTS; i++) {
    const config = deckButtons[i];
    const btn = document.createElement('button');
    btn.className = 'deck-btn';
    btn.dataset.index = i;

    if (config) {
      btn.dataset.type = config.type;

      const iconDiv = document.createElement('div');
      iconDiv.className = 'deck-btn-icon';

      if (config.type === 'app' && config.icon) {
        iconDiv.innerHTML = `<img src="${config.icon}" alt="">`;
      } else if (config.type === 'media') {
        iconDiv.innerHTML = MEDIA_ICONS[config.action] || '';
      } else if (config.type === 'hotkey') {
        iconDiv.innerHTML = HOTKEY_ICON;
      } else if (config.type === 'audio_output') {
        iconDiv.innerHTML = SPEAKER_ICON;
      } else if (config.type === 'discord') {
        iconDiv.innerHTML = DISCORD_ICON;
      } else if (config.type === 'keylight') {
        iconDiv.innerHTML = KEYLIGHT_ICON;
      } else if (config.type === 'meld') {
        if (config.action === 'toggle_record') iconDiv.innerHTML = MELD_RECORD_ICON;
        else if (config.action === 'toggle_stream') iconDiv.innerHTML = MELD_STREAM_ICON;
        else iconDiv.innerHTML = MELD_ICON;
      } else {
        iconDiv.textContent = config.name ? config.name[0].toUpperCase() : '?';
      }

      const label = document.createElement('div');
      label.className = 'deck-btn-label';
      label.textContent = config.label || config.name || '';

      const badge = document.createElement('div');
      badge.className = 'delete-badge';
      badge.textContent = '\u00d7';

      btn.appendChild(iconDiv);
      btn.appendChild(label);
      btn.appendChild(badge);
    } else {
      btn.classList.add('empty');
    }

    bindDeckSlot(btn, i);
    grid.appendChild(btn);
  }
}

function bindDeckSlot(btn, index) {
  let pressTimer = null;
  let startX = 0, startY = 0;
  let longFired = false;

  btn.addEventListener('pointerdown', (e) => {
    startX = e.clientX; startY = e.clientY;
    longFired = false;
    const config = deckButtons[index];
    // Long-press on app buttons → kill the app
    if (!deckDeleteMode && config && config.type === 'app') {
      pressTimer = setTimeout(async () => {
        pressTimer = null;
        longFired = true;
        const name = config.name || config.label;
        try {
          const result = await api().kill_app(name, config.path || null);
          if (result.ok) {
            showToast(`Closed ${name}`);
          } else {
            showToast(result.error);
          }
        } catch (_) {
          showToast('Failed to close');
        }
      }, DECK_LONG_PRESS_MS);
    }
  });

  btn.addEventListener('pointermove', (e) => {
    if (pressTimer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  });

  btn.addEventListener('pointerup', () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (longFired) { longFired = false; return; }

    if (deckDeleteMode) {
      if (deckButtons[index]) {
        deckButtons[index] = null;
        saveDeckButtons();
        exitDeckDeleteMode();
        renderStreamDeck();
      }
      return;
    }

    // Tap empty slot → open type picker for this slot
    if (!deckButtons[index]) {
      openTypePicker(index);
      return;
    }

    // Tap filled slot → execute
    executeDeckButton(deckButtons[index]);
  });

  btn.addEventListener('pointercancel', () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  });
}

function enterDeckDeleteMode() {
  deckDeleteMode = true;
  document.querySelectorAll('.deck-btn:not(.empty)').forEach(b => b.classList.add('deleting'));
  const addBtn = document.getElementById('stream-deck-add');
  if (addBtn) {
    addBtn.textContent = '−';
    addBtn.classList.add('delete-active');
  }
}

function exitDeckDeleteMode() {
  deckDeleteMode = false;
  document.querySelectorAll('.deck-btn.deleting').forEach(b => b.classList.remove('deleting'));
  const addBtn = document.getElementById('stream-deck-add');
  if (addBtn) {
    addBtn.textContent = '+';
    addBtn.classList.remove('delete-active');
  }
}

async function executeDeckButton(config) {
  if (!config) return;
  try {
    if (config.type === 'app') {
      await api().launch_app(config.path);
    } else if (config.type === 'spotify_app') {
      await api().launch_app('spotify:');
    } else if (config.type === 'media') {
      await api().send_media_key(config.action);
    } else if (config.type === 'hotkey') {
      // Special case: Win+D → use show_desktop to keep AuraLink visible
      const keysLower = config.keys.map(k => k.toLowerCase());
      if (keysLower.length === 2 && keysLower.includes('win') && keysLower.includes('d')) {
        await api().show_desktop();
      } else {
        await api().send_hotkey(config.keys);
      }
    } else if (config.type === 'audio_output') {
      const result = await api().switch_audio_output(config.deviceId);
      if (result.ok) {
        showToast('Switched to ' + config.label);
      } else {
        showToast(result.error || 'Switch failed');
      }
      updateDeckStates();
    } else if (config.type === 'discord') {
      let result;
      if (config.action === 'toggle_mute') {
        result = await api().discord_toggle_mute();
      } else if (config.action === 'toggle_deafen') {
        result = await api().discord_toggle_deafen();
      }
      if (result && result.ok) {
        const state = result.muted !== undefined ? (result.muted ? 'Muted' : 'Unmuted') : (result.deafened ? 'Deafened' : 'Undeafened');
        showToast(state);
      } else if (result && result.error) {
        showToast(result.error);
      }
      // Immediate visual update
      updateDeckStates();
    } else if (config.type === 'keylight') {
      const result = await api().elgato_toggle(config.ip);
      if (result.ok) {
        showToast(result.on ? 'Light On' : 'Light Off');
      } else {
        showToast(result.error || 'Light not reachable');
      }
      updateDeckStates();
    } else if (config.type === 'meld') {
      let result;
      if (config.action === 'launch') {
        result = await api().meld_launch();
        if (result.ok) showToast('Launching Meld Studio');
      } else if (config.action === 'toggle_record') {
        result = await api().meld_toggle_record();
        if (result.ok) showToast('Recording toggled');
        else showToast(result.error || 'Meld not running');
      } else if (config.action === 'toggle_stream') {
        result = await api().meld_toggle_stream();
        if (result.ok) showToast('Streaming toggled');
        else showToast(result.error || 'Meld not running');
      }
      if (result && !result.ok && result.error) showToast(result.error);
      setTimeout(updateDeckStates, 500);
    }
  } catch (e) {
    showToast('Action failed');
  }
  if (config && config.type === 'media') {
    setTimeout(updateDeckStates, 500);
  }
}

/* --- Live Button State Updates -------------------------------------------- */

async function updateDeckStates() {
  // Discord mute/deafen state
  const discordBtns = document.querySelectorAll('.deck-btn[data-type="discord"]');
  if (discordBtns.length > 0) {
    try {
      const state = await api().discord_get_voice_state();
      if (state && state.ok) {
        discordBtns.forEach(btn => {
          const idx = parseInt(btn.dataset.index);
          const config = (btn.dataset.bar === 'utility' ? utilityButtons : deckButtons)[idx];
          if (!config) return;
          if (config.action === 'toggle_mute') {
            btn.classList.toggle('deck-state-red', state.muted);
          } else if (config.action === 'toggle_deafen') {
            btn.classList.toggle('deck-state-red', state.deafened);
          }
        });
      }
    } catch (_) {}
  }

  // Media play state — check if any audio sessions are active
  const mediaBtns = document.querySelectorAll('.deck-btn[data-type="media"]');
  if (mediaBtns.length > 0) {
    const hasAudio = Object.values(channelPeaks).some(p => p > 0.01);
    mediaBtns.forEach(btn => {
      const idx = parseInt(btn.dataset.index);
      const config = (btn.dataset.bar === 'utility' ? utilityButtons : deckButtons)[idx];
      if (config && config.action === 'play_pause') {
        btn.classList.toggle('deck-state-green', hasAudio);
      }
    });
  }

  // Key Light state
  const keylightBtns = document.querySelectorAll('.deck-btn[data-type="keylight"]');
  for (const btn of keylightBtns) {
    const idx = parseInt(btn.dataset.index);
    const config = (btn.dataset.bar === 'utility' ? utilityButtons : deckButtons)[idx];
    if (!config || !config.ip) continue;
    try {
      const state = await api().elgato_get_state(config.ip);
      if (state && state.ok) {
        btn.classList.toggle('deck-state-yellow', state.on);
      }
    } catch (_) {}
  }

  // Meld Studio state
  const meldBtns = document.querySelectorAll('.deck-btn[data-type="meld"]');
  if (meldBtns.length > 0) {
    try {
      const state = await api().meld_get_state();
      if (state && state.ok) {
        meldBtns.forEach(btn => {
          const idx = parseInt(btn.dataset.index);
          const config = (btn.dataset.bar === 'utility' ? utilityButtons : deckButtons)[idx];
          if (!config) return;
          if (config.action === 'toggle_record') {
            btn.classList.toggle('deck-state-red', state.recording);
          } else if (config.action === 'toggle_stream') {
            btn.classList.toggle('deck-state-red', state.streaming);
          }
        });
      }
    } catch (_) {}
  }

  // Audio output — highlight which device is currently active
  const audioBtns = document.querySelectorAll('.deck-btn[data-type="audio_output"]');
  if (audioBtns.length > 0) {
    try {
      const currentId = await api().get_current_output();
      audioBtns.forEach(btn => {
        const idx = parseInt(btn.dataset.index);
        const config = (btn.dataset.bar === 'utility' ? utilityButtons : deckButtons)[idx];
        if (!config) return;
        btn.classList.toggle('deck-state-green', config.deviceId === currentId);
      });
    } catch (_) {}
  }
}

/* --- Type Picker ---------------------------------------------------------- */

let capturedKeys = [];

let pickerSlotIndex = -1;

function openTypePicker(slotIndex, target = 'deck') {
  pickerSlotIndex = slotIndex;
  pickerTarget = target;
  const modal = document.getElementById('btn-type-picker');
  const typesStep = document.getElementById('picker-types');
  const mediaStep = document.getElementById('picker-media');
  const hotkeyStep = document.getElementById('picker-hotkey');
  const audioStep = document.getElementById('picker-audio-output');
  const discordStep = document.getElementById('picker-discord');
  const keylightStep = document.getElementById('picker-keylight');
  const meldStep = document.getElementById('picker-meld');

  typesStep.classList.remove('hidden');
  mediaStep.classList.add('hidden');
  hotkeyStep.classList.add('hidden');
  audioStep.classList.add('hidden');
  discordStep.classList.add('hidden');
  keylightStep.classList.add('hidden');
  meldStep.classList.add('hidden');
  modal.classList.add('visible');

  // Bind type buttons
  typesStep.querySelectorAll('.picker-option').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('pointerup', () => {
      const type = clone.dataset.type;
      if (type === 'app') {
        const idx = pickerSlotIndex;
        closeTypePicker();
        pickAppForDeck(idx);
      } else if (type === 'media') {
        typesStep.classList.add('hidden');
        mediaStep.classList.remove('hidden');
      } else if (type === 'hotkey') {
        typesStep.classList.add('hidden');
        hotkeyStep.classList.remove('hidden');
        bindHotkeyCapture();
      } else if (type === 'discord') {
        typesStep.classList.add('hidden');
        discordStep.classList.remove('hidden');
      } else if (type === 'keylight') {
        typesStep.classList.add('hidden');
        keylightStep.classList.remove('hidden');
        loadKeylightList();
      } else if (type === 'meld') {
        typesStep.classList.add('hidden');
        meldStep.classList.remove('hidden');
      } else if (type === 'audio_output') {
        typesStep.classList.add('hidden');
        audioStep.classList.remove('hidden');
        loadAudioOutputList();
      }
    });
  });

  // Bind media buttons
  mediaStep.querySelectorAll('.picker-option[data-action]').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('pointerup', () => {
      addDeckButton(pickerSlotIndex, {
        type: 'media',
        action: clone.dataset.action,
        label: clone.textContent.trim(),
      });
      closeTypePicker();
    });
  });

  // Bind discord buttons
  discordStep.querySelectorAll('.picker-option[data-action]').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('pointerup', () => {
      addDeckButton(pickerSlotIndex, {
        type: 'discord',
        action: clone.dataset.action,
        label: clone.textContent.trim(),
      });
      closeTypePicker();
    });
  });

  // Bind meld buttons
  meldStep.querySelectorAll('.picker-option[data-action]').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('pointerup', () => {
      addDeckButton(pickerSlotIndex, {
        type: 'meld',
        action: clone.dataset.action,
        label: clone.textContent.trim(),
      });
      closeTypePicker();
    });
  });

  // Bind hotkey preset buttons
  hotkeyStep.querySelectorAll('.picker-option[data-keys]').forEach(btn => {
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('pointerup', () => {
      addDeckButton(pickerSlotIndex, {
        type: 'hotkey',
        keys: clone.dataset.keys.split(','),
        label: clone.textContent.trim(),
      });
      closeTypePicker();
    });
  });

  // Bind custom hotkey save
  const saveBtn = document.getElementById('hotkey-save');
  const saveClone = saveBtn.cloneNode(true);
  saveBtn.parentNode.replaceChild(saveClone, saveBtn);
  saveClone.id = 'hotkey-save';
  saveClone.addEventListener('pointerup', () => {
    if (capturedKeys.length > 0) {
      addDeckButton(pickerSlotIndex, {
        type: 'hotkey',
        keys: capturedKeys.slice(),
        label: capturedKeys.join(' + ').toUpperCase(),
      });
      closeTypePicker();
    }
  });

  // Bind cancel
  const cancelBtn = document.getElementById('picker-cancel');
  const cancelClone = cancelBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(cancelClone, cancelBtn);
  cancelClone.id = 'picker-cancel';
  cancelClone.addEventListener('pointerup', closeTypePicker);
}

function closeTypePicker() {
  document.getElementById('btn-type-picker').classList.remove('visible');
  pickerSlotIndex = -1;
  capturedKeys = [];
  const input = document.getElementById('hotkey-input');
  if (input) input.value = '';
}

async function loadAudioOutputList() {
  const list = document.getElementById('audio-output-list');
  if (!list) return;
  list.innerHTML = '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:12px">Loading devices...</div>';

  try {
    const devices = await api().get_audio_outputs();
    list.innerHTML = '';
    devices.forEach(dev => {
      const btn = document.createElement('button');
      btn.className = 'picker-option';
      btn.textContent = dev.name;
      btn.addEventListener('pointerup', () => {
        addDeckButton(pickerSlotIndex, {
          type: 'audio_output',
          deviceId: dev.id,
          label: dev.name.replace(/\s*\(.*\)\s*$/, ''), // short name
        });
        closeTypePicker();
      });
      list.appendChild(btn);
    });
    if (devices.length === 0) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:12px">No devices found</div>';
    }
  } catch (_) {
    list.innerHTML = '<div style="color:rgba(255,59,48,0.7);text-align:center;padding:12px">Failed to load devices</div>';
  }
}

async function loadKeylightList() {
  const list = document.getElementById('keylight-list');
  const subtitle = list ? list.previousElementSibling : null;
  if (!list) return;
  list.innerHTML = '';
  if (subtitle) subtitle.textContent = 'Scanning for lights...';

  try {
    const lights = await api().elgato_discover();
    if (subtitle) subtitle.textContent = lights.length > 0 ? 'Found lights:' : '';
    list.innerHTML = '';
    lights.forEach(light => {
      const btn = document.createElement('button');
      btn.className = 'picker-option';
      btn.textContent = light.name;
      btn.addEventListener('pointerup', () => {
        addDeckButton(pickerSlotIndex, {
          type: 'keylight',
          ip: light.ip,
          label: light.name.replace('Elgato ', ''),
        });
        closeTypePicker();
      });
      list.appendChild(btn);
    });
    if (lights.length === 0) {
      list.innerHTML = '<div style="color:rgba(255,255,255,0.3);text-align:center;padding:12px">No Key Lights found on network</div>';
    }
  } catch (_) {
    list.innerHTML = '<div style="color:rgba(255,59,48,0.7);text-align:center;padding:12px">Scan failed</div>';
  }
}

async function pickAppForDeck(slotIndex) {
  try {
    const result = await api().pick_app_executable();
    if (result.cancelled) return;
    if (result.error) { showToast(result.error); return; }

    addDeckButton(slotIndex, {
      type: 'app',
      name: result.name,
      path: result.path,
      icon: result.icon || null,
      label: result.name,
    });
  } catch (_) {
    showToast('Failed to pick app');
  }
}

function addDeckButton(index, config) {
  if (pickerTarget === 'utility') {
    utilityButtons[index] = config;
    saveUtilityButtons();
    renderUtilityBar();
    return;
  }
  deckButtons[index] = config;
  saveDeckButtons();
  renderStreamDeck();
}

/* --- Utility Bar (5-slot configurable row above the media bar) ------------ */

function initUtilityBar() {
  loadUtilityButtons();
  seedUtilityDefaults();
  renderUtilityBar();
}

function loadUtilityButtons() {
  try {
    const raw = localStorage.getItem('utilityBarButtons');
    if (raw) utilityButtons = JSON.parse(raw);
  } catch (_) {}
  while (utilityButtons.length < UTILITY_SLOTS) utilityButtons.push(null);
  utilityButtons.length = UTILITY_SLOTS;
}

function saveUtilityButtons() {
  localStorage.setItem('utilityBarButtons', JSON.stringify(utilityButtons));
}

// Slot 0 pre-assigned to Win+H (Windows dictation toggle) on first run.
// Win+H is a native Windows toggle — first press opens dictation, second closes.
// Slot 4 (above HEADPHONES) pre-assigned to Spotify launcher; uses a separate
// flag so existing users who already have utilityBarSeeded still get it.
function seedUtilityDefaults() {
  if (!localStorage.getItem('utilityBarSeeded')) {
    if (!utilityButtons[0]) {
      utilityButtons[0] = {
        type: 'hotkey',
        keys: ['win', 'h'],
        label: 'DICTATE',
      };
      saveUtilityButtons();
    }
    localStorage.setItem('utilityBarSeeded', '1');
  }
  if (!localStorage.getItem('utilityBarSeededSpotify')) {
    if (!utilityButtons[4]) {
      utilityButtons[4] = {
        type: 'spotify_app',
        label: 'SPOTIFY',
      };
      saveUtilityButtons();
    }
    localStorage.setItem('utilityBarSeededSpotify', '1');
  }
}

function renderUtilityBar() {
  const bar = document.getElementById('utility-bar');
  if (!bar) return;
  bar.innerHTML = '';

  for (let i = 0; i < UTILITY_SLOTS; i++) {
    const config = utilityButtons[i];
    const btn = document.createElement('button');
    btn.className = 'deck-btn utility-btn';
    btn.dataset.index = i;
    btn.dataset.bar = 'utility';

    if (config) {
      btn.dataset.type = config.type;

      const iconDiv = document.createElement('div');
      iconDiv.className = 'deck-btn-icon';

      if (config.type === 'app' && config.icon) {
        iconDiv.innerHTML = `<img src="${config.icon}" alt="">`;
      } else if (config.type === 'spotify_app') {
        iconDiv.innerHTML = SPOTIFY_ICON;
      } else if (config.type === 'media') {
        iconDiv.innerHTML = MEDIA_ICONS[config.action] || '';
      } else if (config.type === 'hotkey') {
        iconDiv.innerHTML = HOTKEY_ICON;
      } else if (config.type === 'audio_output') {
        iconDiv.innerHTML = SPEAKER_ICON;
      } else if (config.type === 'discord') {
        iconDiv.innerHTML = DISCORD_ICON;
      } else if (config.type === 'keylight') {
        iconDiv.innerHTML = KEYLIGHT_ICON;
      } else if (config.type === 'meld') {
        if (config.action === 'toggle_record') iconDiv.innerHTML = MELD_RECORD_ICON;
        else if (config.action === 'toggle_stream') iconDiv.innerHTML = MELD_STREAM_ICON;
        else iconDiv.innerHTML = MELD_ICON;
      } else {
        iconDiv.textContent = config.name ? config.name[0].toUpperCase() : '?';
      }

      const label = document.createElement('div');
      label.className = 'deck-btn-label';
      label.textContent = config.label || config.name || '';

      btn.appendChild(iconDiv);
      btn.appendChild(label);
    } else {
      btn.classList.add('empty');
      const iconDiv = document.createElement('div');
      iconDiv.className = 'deck-btn-icon';
      iconDiv.textContent = '+';
      btn.appendChild(iconDiv);
    }

    bindUtilitySlot(btn, i);
    bar.appendChild(btn);
  }
}

// Tap empty -> open picker. Tap filled -> execute. Long-press filled -> clear slot.
function bindUtilitySlot(btn, index) {
  let pressTimer = null;
  let longFired = false;
  let startX = 0, startY = 0;

  btn.addEventListener('pointerdown', (e) => {
    startX = e.clientX; startY = e.clientY;
    longFired = false;
    if (utilityButtons[index]) {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        longFired = true;
        utilityButtons[index] = null;
        saveUtilityButtons();
        renderUtilityBar();
        showToast('Cleared');
      }, DECK_LONG_PRESS_MS);
    }
  });

  btn.addEventListener('pointermove', (e) => {
    if (pressTimer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  });

  btn.addEventListener('pointerup', () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    if (longFired) { longFired = false; return; }

    if (!utilityButtons[index]) {
      openTypePicker(index, 'utility');
      return;
    }
    executeDeckButton(utilityButtons[index]);
  });

  btn.addEventListener('pointercancel', () => {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  });
}

// Hotkey capture: modifiers come from on-screen toggles (so OS-intercepted
// combos like Win+H can still be captured), trigger key comes from keypress.
function bindHotkeyCapture() {
  const input = document.getElementById('hotkey-input');
  if (!input) return;

  const mods = new Set();
  let triggerKey = '';

  const refresh = () => {
    capturedKeys = [];
    if (mods.has('ctrl')) capturedKeys.push('ctrl');
    if (mods.has('shift')) capturedKeys.push('shift');
    if (mods.has('alt')) capturedKeys.push('alt');
    if (mods.has('win')) capturedKeys.push('win');
    if (triggerKey) capturedKeys.push(triggerKey);
    input.value = capturedKeys.join(' + ').toUpperCase();
  };

  // Reset visible state, then re-bind modifier toggles (replace nodes to drop old listeners)
  document.querySelectorAll('.hotkey-mod').forEach(btn => {
    btn.classList.remove('active');
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn);
    clone.addEventListener('pointerup', () => {
      const mod = clone.dataset.mod;
      if (mods.has(mod)) {
        mods.delete(mod);
        clone.classList.remove('active');
      } else {
        mods.add(mod);
        clone.classList.add('active');
      }
      refresh();
      input.focus();
    });
  });

  refresh();

  const handler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Modifiers come from the on-screen toggles, not the physical keys.
    if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return;
    triggerKey = e.key.toLowerCase();
    refresh();
  };

  input.removeEventListener('keydown', input._hotkeyHandler);
  input._hotkeyHandler = handler;
  input.addEventListener('keydown', handler);
  input.focus();
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
    if (modal.classList.contains('open')) {
      renderFontGrid();
      renderColorRow();
      syncTileOpacitySlider();
    }
  });

  // Close on overlay click
  modal.addEventListener('pointerup', e => {
    if (e.target === modal) modal.classList.remove('open');
  });

  // Zone tabs — fonts only, opacity slider is global so no sync here
  document.querySelectorAll('.font-zone-tab').forEach(tab => {
    tab.addEventListener('pointerup', e => {
      e.preventDefault();
      document.querySelectorAll('.font-zone-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeFontZone = tab.dataset.zone;
      renderFontGrid();
      renderColorRow();
    });
  });

  // Tile opacity slider — global, applies to every .glass-card.
  const slider = document.getElementById('tile-opacity-slider');
  const valueLabel = document.getElementById('tile-opacity-value');
  if (slider) {
    slider.addEventListener('input', () => {
      const pct = parseInt(slider.value, 10);
      const value = (isNaN(pct) ? 100 : pct) / 100;
      if (valueLabel) valueLabel.textContent = `${pct}%`;
      applyTileOpacity(value);
      saveTileOpacity(value);
    });
  }

  renderFontGrid();
  renderColorRow();
  syncTileOpacitySlider();
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

// --- Per-zone text color (under F modal, COLOR row) -----------------------
// "default" entry clears any inline color so the stylesheet default takes over.
const FONT_COLOR_PALETTE = [
  { name: 'default', hex: null,      label: 'DEFAULT' },
  { name: 'white',   hex: '#FFFFFF', label: 'WHITE' },
  { name: 'red',     hex: '#FF3B30', label: 'RED' },
  { name: 'orange',  hex: '#FF9F0A', label: 'ORANGE' },
  { name: 'yellow',  hex: '#FFD60A', label: 'YELLOW' },
  { name: 'green',   hex: '#30D158', label: 'GREEN' },
  { name: 'cyan',    hex: '#64D2FF', label: 'CYAN' },
  { name: 'blue',    hex: '#0A84FF', label: 'BLUE' },
  { name: 'purple',  hex: '#BF5AF2', label: 'PURPLE' },
  { name: 'pink',    hex: '#FF375F', label: 'PINK' },
];

function applyFontColor(zone, hex) {
  const selectors = FONT_ZONES[zone];
  if (!selectors) return;
  document.querySelectorAll(selectors).forEach(el => {
    el.style.color = hex || '';  // '' lets the stylesheet rule win again
  });
}

function getSavedFontColors() {
  try { return JSON.parse(localStorage.getItem('channelFontColors') || '{}'); }
  catch (_) { return {}; }
}

function saveFontColor(zone, colorName) {
  const s = getSavedFontColors();
  if (!colorName || colorName === 'default') delete s[zone];
  else s[zone] = colorName;
  try { localStorage.setItem('channelFontColors', JSON.stringify(s)); } catch (_) {}
}

function restoreFontColors() {
  const saved = getSavedFontColors();
  for (const [zone, colorName] of Object.entries(saved)) {
    const c = FONT_COLOR_PALETTE.find(p => p.name === colorName);
    if (c) applyFontColor(zone, c.hex);
  }
}

function renderColorRow() {
  const row = document.getElementById('font-color-swatches');
  if (!row) return;
  row.innerHTML = '';

  const saved = getSavedFontColors();
  const currentName = saved[activeFontZone] || 'default';

  FONT_COLOR_PALETTE.forEach(c => {
    const dot = document.createElement('button');
    dot.className = 'font-color-dot';
    dot.dataset.color = c.name;
    dot.setAttribute('aria-label', c.label);
    if (c.hex) {
      dot.style.background = c.hex;
      dot.style.setProperty('--dot-color', c.hex);
    }
    if (c.name === currentName) dot.classList.add('active');

    dot.addEventListener('pointerup', e => {
      e.preventDefault();
      e.stopPropagation();
      applyFontColor(activeFontZone, c.hex);
      saveFontColor(activeFontZone, c.name);
      row.querySelectorAll('.font-color-dot').forEach(d => d.classList.remove('active'));
      dot.classList.add('active');
    });

    row.appendChild(dot);
  });
}

// --- Global tile opacity ---------------------------------------------------
// Drives the `--tile-alpha` CSS variable, which scales the tile CHROME only
// (background, borders, backdrop blur, drop shadow) via calc() in style_v5.css.
// Content inside the tiles (text, sliders, color swatches, buttons) keeps its
// own opacity at 1. Scoped to #app .glass-card so modal cards aren't affected.
// Persisted under localStorage.tileOpacity.

function applyTileOpacity(value) {
  document.documentElement.style.setProperty('--tile-alpha', String(value));
}

function getSavedTileOpacity() {
  try {
    const raw = localStorage.getItem('tileOpacity');
    if (raw === null) return 1;
    const v = parseFloat(raw);
    return isNaN(v) ? 1 : v;
  } catch (_) { return 1; }
}

function saveTileOpacity(value) {
  try { localStorage.setItem('tileOpacity', String(value)); } catch (_) {}
}

function restoreTileOpacity() {
  applyTileOpacity(getSavedTileOpacity());
}

function syncTileOpacitySlider() {
  const slider = document.getElementById('tile-opacity-slider');
  const valueLabel = document.getElementById('tile-opacity-value');
  if (!slider) return;
  const value = getSavedTileOpacity();
  const pct = Math.round(value * 100);
  slider.value = String(pct);
  if (valueLabel) valueLabel.textContent = `${pct}%`;
}

// Wire up on init (called after DOM ready from boot)
document.addEventListener('DOMContentLoaded', () => {
  const wait = setInterval(() => {
    if (document.getElementById('font-grid')) {
      clearInterval(wait);
      initFontPicker();
      restoreFonts();
      restoreFontColors();
      restoreTileOpacity();
    }
  }, 200);
});

/* ==========================================================================
   Touch cursor parking — after every touch on AuraLink ends, ask Python
   to teleport the OS cursor back to its last position on a non-Edge monitor.
   Keeps the cursor from being stranded on the Xeneon Edge after taps and
   slider releases. Only fires on touch — mouse/stylus untouched.
   ========================================================================== */
function _restoreCursor() {
  try { window.pywebview.api.restore_cursor(); } catch (_) {}
}
document.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'touch') _restoreCursor();
}, true);
document.addEventListener('pointercancel', (e) => {
  if (e.pointerType === 'touch') _restoreCursor();
}, true);

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

      if (result.type === 'video' && result.url) {
        applyBgVideo(result.url);
        try {
          localStorage.removeItem('bgImage');
          localStorage.setItem('bgVideo', JSON.stringify({ url: result.url }));
        } catch (_) {}
      } else if (result.dataUrl) {
        applyBgImage(result.dataUrl);
        try {
          localStorage.removeItem('bgVideo');
          localStorage.setItem('bgImage', result.dataUrl);
        } catch (_) {}
      }
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
  removeBgVideoEl();
  document.body.classList.remove('has-bg-video');
  document.body.style.backgroundImage = `url("${dataUrl}")`;
  document.body.classList.add('has-bg-image');
  const bgBtn = document.getElementById('bg-btn');
  if (bgBtn) bgBtn.classList.add('active');
}

function applyBgVideo(url) {
  // Strip any image bg, then mount a fullscreen <video> as the first child of <body>
  document.body.style.backgroundImage = '';
  let video = document.getElementById('bg-video');
  if (!video) {
    video = document.createElement('video');
    video.id = 'bg-video';
    video.autoplay = true;
    video.loop = true;
    video.muted = true;
    video.playsInline = true;
    document.body.insertBefore(video, document.body.firstChild);
  }
  video.src = url;
  // Some webview policies need a play() kick even with autoplay+muted
  video.play().catch(() => {});
  document.body.classList.add('has-bg-image', 'has-bg-video');
  const bgBtn = document.getElementById('bg-btn');
  if (bgBtn) bgBtn.classList.add('active');
  // If a game is already running when this video is mounted, immediately
  // enter the paused state so it doesn't pop in at full opacity.
  if (_auraGameActive) pauseForGame();
}

function removeBgVideoEl() {
  const video = document.getElementById('bg-video');
  if (video) {
    try { video.pause(); } catch (_) {}
    video.removeAttribute('src');
    try { video.load(); } catch (_) {}
    video.remove();
  }
}

// --- Pause-while-gaming overlay --------------------------------------------
// Layered above #bg-video, below the UI. Fade is driven by body.game-paused.

let _auraPauseFinalizeTimer = null;

function applyPauseImage(url) {
  let el = document.getElementById('bg-pause-image');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bg-pause-image';
    // Mount above #bg-video if present, otherwise as body's first child.
    const video = document.getElementById('bg-video');
    if (video && video.parentNode === document.body) {
      document.body.insertBefore(el, video.nextSibling);
    } else {
      document.body.insertBefore(el, document.body.firstChild);
    }
  }
  el.style.backgroundImage = `url("${url}")`;
}

function clearPauseImageEl() {
  const el = document.getElementById('bg-pause-image');
  if (el) el.remove();
}

function pauseForGame() {
  const video = document.getElementById('bg-video');
  if (!video) return;  // only meaningful when a video bg is mounted
  // Lazy-mount the overlay if we have a URL saved but no element yet.
  try {
    const url = localStorage.getItem('bgPauseImage');
    if (url && !document.getElementById('bg-pause-image')) applyPauseImage(url);
  } catch (_) {}
  document.body.classList.add('game-paused');
  // After the CSS crossfade settles, actually pause the decoder to free GPU.
  if (_auraPauseFinalizeTimer) clearTimeout(_auraPauseFinalizeTimer);
  _auraPauseFinalizeTimer = setTimeout(() => {
    _auraPauseFinalizeTimer = null;
    try { video.pause(); } catch (_) {}
  }, 700);
}

function resumeFromGame() {
  if (_auraPauseFinalizeTimer) { clearTimeout(_auraPauseFinalizeTimer); _auraPauseFinalizeTimer = null; }
  const video = document.getElementById('bg-video');
  if (video) { try { video.play().catch(() => {}); } catch (_) {} }
  document.body.classList.remove('game-paused');
}

function clearBgImage() {
  if (_auraPauseFinalizeTimer) { clearTimeout(_auraPauseFinalizeTimer); _auraPauseFinalizeTimer = null; }
  removeBgVideoEl();
  document.body.style.backgroundImage = '';
  document.body.classList.remove('has-bg-image', 'has-bg-video', 'game-paused');
  const bgBtn = document.getElementById('bg-btn');
  if (bgBtn) bgBtn.classList.remove('active');
  try {
    localStorage.removeItem('bgImage');
    localStorage.removeItem('bgVideo');
  } catch (_) {}
}

function restoreBgImage() {
  try {
    const savedVideo = localStorage.getItem('bgVideo');
    if (savedVideo) {
      const obj = JSON.parse(savedVideo);
      if (obj && obj.url) {
        applyBgVideo(obj.url);
      }
    } else {
      const saved = localStorage.getItem('bgImage');
      if (saved) applyBgImage(saved);
    }
    // Always restore pause-image overlay if configured — it's independent
    // of bg-image vs bg-video, and stays mounted at opacity 0 until needed.
    const pauseUrl = localStorage.getItem('bgPauseImage');
    if (pauseUrl) applyPauseImage(pauseUrl);
  } catch (_) {}
}

// Devtools-callable helpers — set or clear the pause-while-gaming image.
// Use from the browser console: await setPauseImage()  / await clearPauseImage()
window.setPauseImage = async function setPauseImage() {
  try {
    const result = await api().pick_pause_image();
    if (!result || result.cancelled) return result;
    if (result.error) { showToast(result.error); return result; }
    if (result.url) {
      applyPauseImage(result.url);
      try { localStorage.setItem('bgPauseImage', result.url); } catch (_) {}
    }
    return result;
  } catch (e) {
    showToast('Could not open file picker');
    return { error: String(e) };
  }
};

window.clearPauseImage = async function clearPauseImage() {
  try { await api().clear_pause_image(); } catch (_) {}
  try { localStorage.removeItem('bgPauseImage'); } catch (_) {}
  // If we were currently paused, bring the video back — otherwise the user
  // would see a blank screen since the overlay just got pulled out from under.
  if (document.body.classList.contains('game-paused')) resumeFromGame();
  clearPauseImageEl();
  return { ok: true };
};

/* ==========================================================================
   Utility Panel — Hardware Monitor
   ========================================================================== */

const HWMON_POLL_INTERVAL = 2000;
let hwmonTimer = null;

function initUtilityPanel() {
  fetchHardwareSensors();
  hwmonTimer = setInterval(fetchHardwareSensors, HWMON_POLL_INTERVAL);
}

/* ==========================================================================
   Hardware Monitor — live sensor display from Libre Hardware Monitor
   ========================================================================== */

const SENSOR_DEFS = [
  // --- CPU group ---
  { key: 'cpu_temp',  label: 'CPU TEMP',  unit: '\u00b0C', max: 100, type: 'temp',  group: 'CPU' },
  { key: 'cpu_load',  label: 'CPU LOAD',  unit: '%',       max: 100, type: 'load',  group: null },
  { key: 'cpu_power', label: 'CPU POWER', unit: 'W',       max: 200, type: 'power', group: null },
  // --- GPU group ---
  { key: 'gpu_temp',  label: 'GPU TEMP',  unit: '\u00b0C', max: 100, type: 'temp',  group: 'GPU' },
  { key: 'gpu_load',  label: 'GPU LOAD',  unit: '%',       max: 100, type: 'load',  group: null },
  { key: 'gpu_power', label: 'GPU POWER', unit: 'W',       max: 600, type: 'load',  group: null },
  { key: 'gpu_vram',  label: 'VRAM',      unit: '%',       max: 100, type: 'load',  group: null },
  // --- Memory ---
  { key: 'ram_load',  label: 'RAM LOAD',  unit: '%',       max: 100, type: 'load',  group: 'MEMORY' },
  { key: 'ram_temp',  label: 'RAM TEMP',  unit: '\u00b0C', max: 85,  type: 'temp',  group: null },
  // --- Motherboard ---
  { key: 'mobo_temp', label: 'MOBO TEMP', unit: '\u00b0C', max: 80,  type: 'temp',  group: 'MOBO' },
];

async function fetchHardwareSensors() {
  try {
    const data = await api().get_hardware_sensors();
    if (data.error) {
      renderHwmonError(data.error);
      return;
    }
    renderSensorRows(data);
  } catch (_) {
    renderHwmonError('Libre Hardware Monitor not detected');
  }
}

function renderHwmonError(msg) {
  const list = document.getElementById('sensor-list');
  if (!list) return;
  list.innerHTML = '';
  const err = document.createElement('div');
  err.className = 'hwmon-error';
  err.textContent = msg;
  list.appendChild(err);
}

function renderSensorRows(data) {
  const list = document.getElementById('sensor-list');
  if (!list) return;

  // On first render, build the DOM. On updates, just update values.
  const existing = list.querySelectorAll('.sensor-row');
  if (existing.length === 0) {
    list.innerHTML = '';
    buildSensorDOM(list, data);
  } else {
    updateSensorValues(data);
  }
}

function buildSensorDOM(list, data) {
  // Main sensors grouped by component
  SENSOR_DEFS.forEach(def => {
    const val = data[def.key];
    if (val === null || val === undefined) return;
    // Insert group divider if this sensor starts a new group
    if (def.group) {
      const divider = document.createElement('div');
      divider.className = 'sensor-divider';
      divider.textContent = def.group;
      list.appendChild(divider);
    }
    list.appendChild(createSensorRow(def, val));
  });

}

function createSensorRow(def, value) {
  const row = document.createElement('div');
  row.className = 'sensor-row';
  row.dataset.sensor = def.key;

  const top = document.createElement('div');
  top.className = 'sensor-row-top';

  const label = document.createElement('span');
  label.className = 'sensor-label';
  label.textContent = def.label;

  const val = document.createElement('span');
  val.className = 'sensor-value';
  val.textContent = formatSensorValue(value, def.unit);

  top.appendChild(label);
  top.appendChild(val);
  row.appendChild(top);

  // Add bar for temp/load types
  if (def.type === 'temp' || def.type === 'load') {
    const track = document.createElement('div');
    track.className = 'sensor-bar-track';
    const fill = document.createElement('div');
    fill.className = 'sensor-bar-fill';
    const pct = Math.min(100, Math.max(0, (value / def.max) * 100));
    fill.style.width = pct + '%';
    fill.style.background = sensorColor(value, def.type, def.max);
    track.appendChild(fill);
    row.appendChild(track);
  }

  return row;
}

function updateSensorValues(data) {
  // Update main sensors
  SENSOR_DEFS.forEach(def => {
    const val = data[def.key];
    if (val === null || val === undefined) return;
    const row = document.querySelector(`.sensor-row[data-sensor="${def.key}"]`);
    if (!row) return;
    const valEl = row.querySelector('.sensor-value');
    if (valEl) valEl.textContent = formatSensorValue(val, def.unit);
    const fill = row.querySelector('.sensor-bar-fill');
    if (fill) {
      const pct = Math.min(100, Math.max(0, (val / def.max) * 100));
      fill.style.width = pct + '%';
      fill.style.background = sensorColor(val, def.type, def.max);
    }
  });

}

function formatSensorValue(val, unit) {
  if (val === null || val === undefined) return '--';
  const num = Math.round(val * 10) / 10;
  return `${num}${unit}`;
}

function sensorColor(val, type, max) {
  // Smooth gradient: blue → orange → red as value rises
  // Temp: 30-100°C range, Load: 0-max% range, Power: 0-max W range
  let t;
  if (type === 'temp') {
    t = Math.max(0, Math.min(1, (val - 30) / 70));  // 30°C=0, 100°C=1
  } else {
    const denom = max && max > 0 ? max : 100;
    t = Math.max(0, Math.min(1, val / denom));
  }

  // Color stops: blue(0.0) → cyan(0.3) → orange(0.6) → red(1.0)
  let r, g, b;
  if (t < 0.3) {
    const p = t / 0.3;
    r = Math.round(10 + p * 90);       // 10 → 100
    g = Math.round(132 + p * 78);      // 132 → 210
    b = Math.round(255 - p * 55);      // 255 → 200
  } else if (t < 0.6) {
    const p = (t - 0.3) / 0.3;
    r = Math.round(100 + p * 155);     // 100 → 255
    g = Math.round(210 - p * 51);      // 210 → 159
    b = Math.round(200 - p * 190);     // 200 → 10
  } else {
    const p = (t - 0.6) / 0.4;
    r = 255;                            // 255
    g = Math.round(159 - p * 100);     // 159 → 59
    b = Math.round(10 + p * 38);       // 10 → 48
  }
  return `rgba(${r}, ${g}, ${b}, 0.85)`;
}

/* ==========================================================================
   Spotify Now Playing Widget
   ========================================================================== */

// REST polling is just a backup for when audio is on a non-SDK device (e.g. your phone).
// When audio is on AuraLink itself, SDK player_state_changed events push real-time
// updates with zero API cost. So this can be slow.
const SPOTIFY_FETCH_MS = 30000;  // 30s
const SPOTIFY_TICK_MS = 250;

let _spotifyState = null;
let _spotifyFetchedAt = 0;
let _spotifyArtUrl = '';
let _spotifyFetching = false;

// Tracks the last time GSMTC pushed an update — when this is recent, the REST
// poll is redundant (we already have the freshest state) and we can skip it.
let _gsmtcLastPushAt = 0;
const GSMTC_FRESH_WINDOW_MS = 5000;

function initSpotify() {
  fetchSpotify();
  // Also pull initial GSMTC state in case Python pushed before JS was ready.
  try {
    api().get_local_now_playing().then(data => {
      if (data && data.has_track) {
        _spotifyState = data;
        _spotifyFetchedAt = Date.now();
        _gsmtcLastPushAt = Date.now();
        renderSpotify(data);
      }
    }).catch(() => {});
  } catch (_) {}

  setInterval(() => {
    // Skip polling when window is hidden (touchscreen idle / not focused)
    if (document.visibilityState !== 'visible') return;
    // Skip if GSMTC pushed fresh state recently — REST is the slow fallback.
    if (Date.now() - _gsmtcLastPushAt < GSMTC_FRESH_WINDOW_MS) return;
    fetchSpotify();
  }, SPOTIFY_FETCH_MS);
  setInterval(renderSpotifyTick, SPOTIFY_TICK_MS);
  // Re-fetch immediately when window comes back into focus
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') fetchSpotify();
  });
}

// Wire the shuffle/repeat indicator spans as clickable controls.
// They drive Spotify desktop directly via GSMTC's session-control commands —
// no API tokens, no Premium gate, no network round-trip. Updates are
// optimistic for snappy tap feel; the next 500ms poll reconciles state.
document.addEventListener('DOMContentLoaded', () => {
  const wait = setInterval(() => {
    const sh = document.getElementById('spotify-flag-shuffle');
    const rp = document.getElementById('spotify-flag-repeat');
    if (!sh || !rp) return;
    clearInterval(wait);

    sh.style.cursor = 'pointer';
    rp.style.cursor = 'pointer';

    sh.addEventListener('pointerup', async e => {
      e.preventDefault();
      e.stopPropagation();
      // Optimistic flip for snappy feel
      const next = sh.dataset.on !== 'true';
      sh.dataset.on = next ? 'true' : 'false';
      if (_spotifyState) _spotifyState.shuffle = next;
      try {
        const res = await api().gsmtc_toggle_shuffle();
        if (res && res.ok === false) {
          // Roll back optimistic change on failure
          sh.dataset.on = next ? 'false' : 'true';
          if (_spotifyState) _spotifyState.shuffle = !next;
          if (res.error) showToast(`Shuffle: ${res.error}`);
        }
      } catch (_) {
        sh.dataset.on = next ? 'false' : 'true';
        if (_spotifyState) _spotifyState.shuffle = !next;
      }
    });

    rp.addEventListener('pointerup', async e => {
      e.preventDefault();
      e.stopPropagation();
      // Cycle off → context → track → off; mirrors Spotify desktop's button.
      const current = (_spotifyState && _spotifyState.repeat) || 'off';
      const next = current === 'off' ? 'context'
                 : (current === 'context' || current === 'list') ? 'track'
                 : 'off';
      rp.dataset.on = next !== 'off' ? 'true' : 'false';
      if (_spotifyState) _spotifyState.repeat = next;
      try {
        const res = await api().gsmtc_cycle_repeat();
        if (res && res.ok === false) {
          // Roll back on failure
          rp.dataset.on = (current && current !== 'off') ? 'true' : 'false';
          if (_spotifyState) _spotifyState.repeat = current;
          if (res.error) showToast(`Repeat: ${res.error}`);
        }
      } catch (_) {
        rp.dataset.on = (current && current !== 'off') ? 'true' : 'false';
        if (_spotifyState) _spotifyState.repeat = current;
      }
    });
  }, 200);
});

// Push channel from Python's GSMTC poll loop — called via evaluate_js.
// Near-instant updates (~500ms) for play/pause/skip while Spotify desktop
// (or any media app) is on this PC. SDK push events take priority since
// they're literally event-driven.
window._gsmtcUpdate = function _gsmtcUpdate(data) {
  if (!data) return;
  // If audio is on the AuraLink SDK player itself, SDK push events are
  // the source of truth — skip GSMTC to avoid double-render flicker.
  try {
    if (typeof _auralinkActivated !== 'undefined' && _auralinkActivated &&
        _spotifyState && _spotifyState.device === 'AuraLink') return;
  } catch (_) {}
  _spotifyState = data;
  _spotifyFetchedAt = Date.now();
  _gsmtcLastPushAt = Date.now();
  try { renderSpotify(data); } catch (_) {}
};

// Build the same flat shape that _spotify_now_playing() returns, from an SDK
// player state. Lets us update the widget instantly without an API call.
function buildSpotifyDataFromSDKState(state) {
  if (!state || !state.track_window || !state.track_window.current_track) return null;
  const t = state.track_window.current_track;
  const album = t.album || {};
  const images = album.images || [];
  // SDK images are in size-ascending order; pick the largest
  const art = images.length ? images[images.length - 1].url : '';
  return {
    connected: true,
    has_track: true,
    is_playing: !state.paused,
    title: t.name || '',
    artists: (t.artists || []).map(a => a.name).join(', '),
    album: album.name || '',
    album_art: art,
    progress_ms: state.position || 0,
    duration_ms: state.duration || (t.duration_ms || 0),
    shuffle: !!state.shuffle,
    repeat: state.repeat_mode === 0 ? 'off' : (state.repeat_mode === 1 ? 'context' : 'track'),
    device: 'AuraLink',
    track_id: t.id || '',
  };
}

async function fetchSpotify() {
  if (_spotifyFetching) return;
  _spotifyFetching = true;
  try {
    const data = await api().spotify_now_playing();
    _spotifyState = data;
    _spotifyFetchedAt = Date.now();
    renderSpotify(data);
  } catch (_) {
    // transient — next tick retries
  } finally {
    _spotifyFetching = false;
  }
}

function renderSpotify(data) {
  const widget = document.getElementById('spotify-widget');
  if (!widget) return;
  const statusText = document.querySelector('#spotify-status .spotify-status-text');

  if (!data || !data.connected) {
    widget.dataset.state = 'connecting';
    if (statusText) {
      if (data && data.rate_limited) {
        const mins = Math.ceil((data.retry_in_sec || 60) / 60);
        statusText.textContent = `SPOTIFY RATE LIMITED — RETRY IN ${mins}M`;
      } else {
        statusText.textContent = 'CONNECTING TO SPOTIFY…';
      }
    }
    return;
  }
  if (!data.has_track) {
    widget.dataset.state = 'idle';
    if (statusText) statusText.textContent = 'NOTHING PLAYING';
    return;
  }

  widget.dataset.state = data.is_playing ? 'playing' : 'paused';

  const art = document.getElementById('spotify-art');
  if (art) {
    if (data.album_art && data.album_art !== _spotifyArtUrl) {
      _spotifyArtUrl = data.album_art;
      art.classList.remove('loaded');
      art.onload = () => art.classList.add('loaded');
      art.src = data.album_art;
    } else if (!data.album_art) {
      _spotifyArtUrl = '';
      art.classList.remove('loaded');
      art.removeAttribute('src');
    }
  }

  setSpotifyText('spotify-title', data.title || '');
  setSpotifyText('spotify-artists', data.artists || '');
  setSpotifyText('spotify-album', data.album || '');
  setSpotifyText('spotify-device', data.device || '');

  const sep = document.getElementById('spotify-meta-sep');
  if (sep) sep.dataset.hidden = (!data.album || !data.device) ? 'true' : 'false';

  const stateFlag = document.getElementById('spotify-flag-state');
  if (stateFlag) {
    stateFlag.textContent = data.is_playing ? 'PLAYING' : 'PAUSED';
    stateFlag.dataset.on = data.is_playing ? 'true' : 'false';
  }

  const shuffleFlag = document.getElementById('spotify-flag-shuffle');
  if (shuffleFlag) shuffleFlag.dataset.on = data.shuffle ? 'true' : 'false';

  const repeatFlag = document.getElementById('spotify-flag-repeat');
  if (repeatFlag) repeatFlag.dataset.on = (data.repeat && data.repeat !== 'off') ? 'true' : 'false';

  const total = document.getElementById('spotify-time-total');
  if (total) total.textContent = formatSpotifyMs(data.duration_ms);

  renderSpotifyTick();
}

function renderSpotifyTick() {
  if (!_spotifyState || !_spotifyState.has_track) return;
  const fill = document.getElementById('spotify-bar-fill');
  const elapsedDisp = document.getElementById('spotify-time-elapsed');
  if (!fill || !elapsedDisp) return;

  let progress = _spotifyState.progress_ms || 0;
  if (_spotifyState.is_playing) {
    progress += Date.now() - _spotifyFetchedAt;
  }
  const duration = _spotifyState.duration_ms || 0;
  if (duration > 0) {
    if (progress > duration) progress = duration;
    fill.style.width = ((progress / duration) * 100) + '%';
  } else {
    fill.style.width = '0%';
  }
  elapsedDisp.textContent = formatSpotifyMs(progress);
}

function formatSpotifyMs(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m + ':' + (s < 10 ? '0' + s : s);
}

function setSpotifyText(id, text) {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}

/* ==========================================================================
   Media Bar — always-visible row: Prev / Play-Pause / Next / Speakers / Headphones
   ========================================================================== */

const HEADPHONES_ICON = `<svg viewBox="0 0 24 24" ${_S}><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>`;

function initMediaBar() {
  const setIcon = (selector, html) => {
    const el = document.querySelector(selector + ' .media-btn-icon');
    if (el) el.innerHTML = html;
  };
  setIcon('.media-btn[data-action="prev"]', MEDIA_ICONS.prev);
  setIcon('.media-btn[data-action="play_pause"]', MEDIA_ICONS.play_pause);
  setIcon('.media-btn[data-action="next"]', MEDIA_ICONS.next);
  setIcon('.media-btn[data-slot="speakers"]', SPEAKER_ICON);
  setIcon('.media-btn[data-slot="headphones"]', HEADPHONES_ICON);

  migrateMediaBarOutputs();
  // Auto-detect by device name if migration didn't fill both slots
  autoConfigureMediaBarOutputs();

  document.querySelectorAll('.media-btn').forEach(btn => {
    btn.addEventListener('pointerup', () => handleMediaBarClick(btn));
  });

  refreshMediaBarActiveOutput();
  setInterval(refreshMediaBarActiveOutput, 5000);
}

async function autoConfigureMediaBarOutputs() {
  let outputs = {};
  try { outputs = JSON.parse(localStorage.getItem('mediaBarOutputs') || '{}'); } catch (_) {}
  if (outputs.speakers && outputs.headphones) return;

  let devices;
  try {
    devices = await api().get_audio_outputs();
  } catch (_) { return; }
  if (!Array.isArray(devices) || devices.length === 0) return;

  const speakerRe = /kanto|ora4|speaker/i;
  const headphoneRe = /beacn|headphone|headset|head/i;

  if (!outputs.speakers) {
    const sp = devices.find(d => speakerRe.test(d.name || ''));
    if (sp) outputs.speakers = { deviceId: sp.id, label: sp.name };
  }
  if (!outputs.headphones) {
    const hp = devices.find(d => headphoneRe.test(d.name || '') && (!outputs.speakers || d.id !== outputs.speakers.deviceId));
    if (hp) outputs.headphones = { deviceId: hp.id, label: hp.name };
  }

  // Last-resort fallback: if still missing, take first two devices in order
  if (!outputs.speakers && devices[0]) {
    outputs.speakers = { deviceId: devices[0].id, label: devices[0].name };
  }
  if (!outputs.headphones && devices[1] && (!outputs.speakers || devices[1].id !== outputs.speakers.deviceId)) {
    outputs.headphones = { deviceId: devices[1].id, label: devices[1].name };
  }

  if (outputs.speakers || outputs.headphones) {
    localStorage.setItem('mediaBarOutputs', JSON.stringify(outputs));
    refreshMediaBarActiveOutput();
  }
}

function migrateMediaBarOutputs() {
  if (localStorage.getItem('mediaBarOutputs')) return;
  try {
    const raw = localStorage.getItem('streamDeckButtons');
    if (!raw) return;
    const old = JSON.parse(raw);
    const outputs = { speakers: null, headphones: null };
    const audio = old.filter(c => c && c.type === 'audio_output' && c.deviceId);

    for (const cfg of audio) {
      const label = ((cfg.label || cfg.name || '') + '').toLowerCase();
      if (!outputs.speakers && /speaker|kanto|ora4/.test(label)) {
        outputs.speakers = { deviceId: cfg.deviceId, label: cfg.label || cfg.name || 'Speakers' };
      } else if (!outputs.headphones && /head|beacn|hd|phone/.test(label)) {
        outputs.headphones = { deviceId: cfg.deviceId, label: cfg.label || cfg.name || 'Headphones' };
      }
    }
    // Fallback: take first 2 in order
    if (!outputs.speakers && audio[0]) {
      outputs.speakers = { deviceId: audio[0].deviceId, label: audio[0].label || 'Speakers' };
    }
    if (!outputs.headphones && audio[1]) {
      outputs.headphones = { deviceId: audio[1].deviceId, label: audio[1].label || 'Headphones' };
    }

    if (outputs.speakers || outputs.headphones) {
      localStorage.setItem('mediaBarOutputs', JSON.stringify(outputs));
    }
  } catch (_) {}
}

function getMediaBarOutput(slot) {
  try {
    const raw = localStorage.getItem('mediaBarOutputs');
    if (!raw) return null;
    return JSON.parse(raw)[slot] || null;
  } catch (_) {
    return null;
  }
}

async function handleMediaBarClick(btn) {
  const action = btn.dataset.action;
  if (action === 'prev' || action === 'play_pause' || action === 'next') {
    try {
      await api().send_media_key(action);
    } catch (_) {}
    return;
  }

  const slot = btn.dataset.slot;
  if (!slot) return;

  const cfg = getMediaBarOutput(slot);
  if (!cfg || !cfg.deviceId) {
    showToast('No ' + slot + ' configured');
    return;
  }
  try {
    const result = await api().switch_audio_output(cfg.deviceId);
    if (result && result.ok) {
      showToast('Switched to ' + (cfg.label || slot));
      updateMediaBarActiveOutput(cfg.deviceId);
    } else {
      showToast((result && result.error) || 'Switch failed');
    }
  } catch (_) {
    showToast('Switch failed');
  }
}

async function refreshMediaBarActiveOutput() {
  try {
    const current = await api().get_current_output();
    if (typeof current === 'string') updateMediaBarActiveOutput(current);
  } catch (_) {}
}

function updateMediaBarActiveOutput(deviceId) {
  document.querySelectorAll('.media-btn.audio-out').forEach(btn => {
    const cfg = getMediaBarOutput(btn.dataset.slot);
    btn.classList.toggle('active-output', !!(cfg && cfg.deviceId === deviceId));
  });
}

/* ==========================================================================
   Spotify Search — fullscreen overlay + on-screen QWERTY keyboard
   ========================================================================== */

let _searchQuery = '';
let _searchKind = 'track';
let _searchTimer = null;
let _searchSeq = 0;
let _searchNumbersOn = false;

function initSpotifySearch() {
  // Toolbar button opens the search overlay; close button & backdrop close it.
  const openBtn = document.getElementById('search-btn');
  const closeBtn = document.getElementById('search-close');
  if (openBtn) openBtn.addEventListener('pointerup', () => openSpotifySearch());
  if (closeBtn) closeBtn.addEventListener('pointerup', () => closeSpotifySearch());

  // Keyboard keys
  document.querySelectorAll('#search-keyboard .kbd-key').forEach(key => {
    key.addEventListener('pointerup', () => onKbdPress(key));
  });

  // Tabs
  document.querySelectorAll('.search-tab').forEach(tab => {
    tab.addEventListener('pointerup', () => {
      _searchKind = tab.dataset.kind;
      document.querySelectorAll('.search-tab').forEach(t => t.classList.toggle('active', t === tab));
      runSpotifySearch(true);
    });
  });

  // Initial state
  setSearchNumbers(false);
  updateSearchInputDisplay();
  renderSearchResults(null);
}

function openSpotifySearch() {
  const overlay = document.getElementById('search-overlay');
  if (!overlay) return;
  overlay.dataset.open = 'true';
  // Fresh session each open: clear prior query so the user starts at a clean state
  _searchQuery = '';
  _searchKind = 'track';
  document.querySelectorAll('.search-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.kind === 'track');
  });
  setSearchNumbers(false);
  updateSearchInputDisplay();
  renderSearchResults(null);
}

function closeSpotifySearch() {
  const overlay = document.getElementById('search-overlay');
  if (!overlay) return;
  overlay.dataset.open = 'false';
  if (_searchTimer) { clearTimeout(_searchTimer); _searchTimer = null; }
}

// Legacy no-op (kept so older call sites don't throw)
function toggleSearchKeyboard() {}

function onKbdPress(key) {
  const action = key.dataset.action;
  if (action === 'backspace') {
    _searchQuery = _searchQuery.slice(0, -1);
  } else if (action === 'clear') {
    _searchQuery = '';
  } else if (action === 'numbers') {
    setSearchNumbers(!_searchNumbersOn);
    return;
  } else {
    const ch = key.dataset.char;
    if (ch == null) return;
    _searchQuery += ch;
  }
  updateSearchInputDisplay();
  scheduleSpotifySearch();
}

function setSearchNumbers(on) {
  _searchNumbersOn = on;
  const numBtn = document.querySelector('.kbd-num');
  const numRow = document.querySelector('.kbd-row-num');
  if (numBtn) numBtn.classList.toggle('active', on);
  if (numRow) numRow.classList.toggle('hidden', !on);
}

function updateSearchInputDisplay() {
  const el = document.getElementById('search-input');
  if (!el) return;
  if (!_searchQuery) {
    el.dataset.empty = 'true';
    el.textContent = 'SEARCH SPOTIFY…';
  } else {
    el.dataset.empty = 'false';
    el.textContent = _searchQuery;
  }
}

function scheduleSpotifySearch() {
  if (_searchTimer) clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => runSpotifySearch(false), 280);
}

async function runSpotifySearch(immediate) {
  const q = _searchQuery.trim();
  if (!q) {
    renderSearchResults(null);
    return;
  }
  const seq = ++_searchSeq;
  if (!immediate) {
    // small grace period so we don't race the keyboard tap
    await new Promise(r => setTimeout(r, 0));
  }
  try {
    const res = await api().spotify_search(q, _searchKind);
    if (seq !== _searchSeq) return; // stale
    renderSearchResults(res);
  } catch (e) {
    if (seq === _searchSeq) renderSearchResults({ error: 'Search failed' });
  }
}

function renderSearchResults(res) {
  const container = document.getElementById('search-results');
  if (!container) return;
  container.innerHTML = '';

  if (!_searchQuery.trim()) {
    container.innerHTML = '<div class="search-hint">Type to search Spotify</div>';
    return;
  }
  if (!res) {
    container.innerHTML = '<div class="search-hint">Searching…</div>';
    return;
  }
  if (res.error) {
    const div = document.createElement('div');
    div.className = 'search-hint error';
    div.textContent = res.error;
    container.appendChild(div);
    return;
  }
  const items = res.results || [];
  if (items.length === 0) {
    container.innerHTML = '<div class="search-hint">No results</div>';
    return;
  }

  for (const item of items) {
    const row = document.createElement('button');
    row.className = 'search-result';
    row.dataset.uri = item.uri;

    const art = document.createElement(item.art ? 'img' : 'div');
    art.className = 'search-result-art' + (item.kind === 'artist' ? ' artist' : '');
    if (item.art) art.src = item.art;
    row.appendChild(art);

    const text = document.createElement('div');
    text.className = 'search-result-text';
    const title = document.createElement('div');
    title.className = 'search-result-title';
    title.textContent = item.title || '';
    const sub = document.createElement('div');
    sub.className = 'search-result-sub';
    sub.textContent = [item.subtitle, item.extra].filter(Boolean).join(' · ');
    text.appendChild(title);
    text.appendChild(sub);
    row.appendChild(text);

    if (item.kind === 'track' && item.duration_ms) {
      const dur = document.createElement('div');
      dur.className = 'search-result-extra';
      dur.textContent = formatSpotifyMs(item.duration_ms);
      row.appendChild(dur);
    }

    row.addEventListener('pointerup', () => playSearchResult(item));
    container.appendChild(row);
  }
}

async function _ensureSDKActivated() {
  if (_auralinkPlayer && !_auralinkActivated) {
    try {
      if (typeof _auralinkPlayer.activateElement === 'function') {
        await _auralinkPlayer.activateElement();
      }
      _auralinkActivated = true;
      _jslog('activateElement OK');
    } catch (e) {
      _jslog('activateElement failed: ' + e);
    }
  }
}

// Reconnect the SDK player and wait (up to 4s) for a fresh READY device_id.
// Used when a play attempt 404s because the previous device dropped off.
async function _reconnectSDK() {
  if (!_auralinkPlayer) return false;
  _jslog('forcing SDK reconnect');
  _auralinkActivated = false;
  _auralinkDeviceId = null;
  try {
    await _auralinkPlayer.connect();
  } catch (e) {
    _jslog('connect threw: ' + e);
    return false;
  }
  // Wait for the `ready` listener to set _auralinkDeviceId
  return new Promise(resolve => {
    const start = Date.now();
    const tick = () => {
      if (_auralinkDeviceId) { resolve(true); return; }
      if (Date.now() - start > 4000) { resolve(false); return; }
      setTimeout(tick, 80);
    };
    tick();
  });
}

async function playSearchResult(item) {
  if (!item || !item.uri) return;
  try {
    await _ensureSDKActivated();

    let result = await api().spotify_play_uri(item.uri, _auralinkDeviceId || null);

    // If the SDK device dropped, force a reconnect + retry exactly once
    const errMsg = (result && result.error) || '';
    const looksLikeDeviceLoss =
      errMsg.includes('No Spotify device') ||
      errMsg.includes('Device not found') ||
      errMsg.includes('404');
    if (!result.ok && looksLikeDeviceLoss) {
      const reconnected = await _reconnectSDK();
      if (reconnected) {
        await _ensureSDKActivated();
        _jslog('retrying play with new device ' + _auralinkDeviceId);
        result = await api().spotify_play_uri(item.uri, _auralinkDeviceId);
      } else {
        _jslog('reconnect timed out');
      }
    }

    if (result && result.ok) {
      const dev = result.device || 'Spotify';
      showToast(result.fallback ? ('Playing on ' + dev + ' (fallback)') : ('Playing on ' + dev));
      closeSpotifySearch();
      if (typeof fetchSpotify === 'function') fetchSpotify();
    } else {
      showToast((result && result.error) || 'Play failed');
    }
  } catch (_) {
    showToast('Play failed');
  }
}

/* ==========================================================================
   Spotify Web Playback SDK — turn AuraLink itself into a Connect device
   ========================================================================== */

let _auralinkPlayer = null;
let _auralinkDeviceId = null;
let _auralinkActivated = false;

function _jslog(msg) { try { api().js_log(String(msg)); } catch (_) {} }

// Heartbeat so we know JS booted at all
setTimeout(() => {
  _jslog('boot: typeof Spotify = ' + (typeof Spotify) + ', online=' + navigator.onLine);
}, 1500);

window.onSpotifyWebPlaybackSDKReady = () => {
  _jslog('SDK ready callback fired. Spotify.Player=' + (typeof Spotify?.Player));
  if (typeof Spotify === 'undefined' || !Spotify.Player) {
    _jslog('SDK object missing — script failed to load');
    return;
  }

  _auralinkPlayer = new Spotify.Player({
    name: 'AuraLink',
    getOAuthToken: cb => {
      api().spotify_get_access_token()
        .then(token => {
          _jslog('token fetched, length=' + (token ? token.length : 0));
          if (token) cb(token);
        })
        .catch(e => _jslog('token fetch error: ' + e));
    },
    volume: 0.7,
  });

  _auralinkPlayer.addListener('ready', ({ device_id }) => {
    _auralinkDeviceId = device_id;
    _jslog('READY device_id=' + device_id);
  });

  // SDK pushes a state update on every play/pause/seek/track-change — use these
  // directly so we don't have to poll the REST API for live changes.
  _auralinkPlayer.addListener('player_state_changed', (state) => {
    const data = buildSpotifyDataFromSDKState(state);
    if (!data) return;
    // SDK fires player_state_changed even when AuraLink isn't the active
    // playback device. In that case state.position is the SDK's internal
    // clock (which keeps ticking independently) — not the actual playback
    // position on Spotify desktop. If GSMTC pushed in the last 2s it is
    // the authoritative source for local playback, so skip the SDK update.
    if (Date.now() - _gsmtcLastPushAt < 2000) return;
    _spotifyState = data;
    _spotifyFetchedAt = Date.now();
    renderSpotify(data);
  });

  _auralinkPlayer.addListener('not_ready', ({ device_id }) => {
    if (_auralinkDeviceId === device_id) _auralinkDeviceId = null;
    _auralinkActivated = false;  // re-activate after reconnect
    _jslog('not_ready: ' + device_id + ' — reconnecting in 1s');
    setTimeout(() => {
      if (_auralinkPlayer) {
        _auralinkPlayer.connect().then(ok => _jslog('reconnect: ' + ok));
      }
    }, 1000);
  });

  _auralinkPlayer.addListener('initialization_error', ({ message }) => {
    _jslog('init_error: ' + message);
  });
  _auralinkPlayer.addListener('authentication_error', ({ message }) => {
    _jslog('auth_error: ' + message);
  });
  _auralinkPlayer.addListener('account_error', ({ message }) => {
    _jslog('account_error (Premium required?): ' + message);
  });
  _auralinkPlayer.addListener('playback_error', ({ message }) => {
    _jslog('playback_error: ' + message);
  });

  _auralinkPlayer.connect().then(success => {
    _jslog('player.connect() resolved: ' + success);
  }).catch(e => _jslog('player.connect() rejected: ' + e));
};

