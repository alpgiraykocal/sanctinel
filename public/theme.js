'use strict';

// Light/dark theme: honor a saved choice, else the OS preference. Runs from
// <head> so the attribute is set before first paint (minimal flash).
(function () {
  const KEY = 'sanctinel-theme';
  // Storage can be unavailable (blocked cookies, some private modes, sandboxed
  // frames) and then even reading it throws — which used to abort this whole
  // script, so the toggle was never wired. The theme still works, it just is
  // not remembered.
  const load = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
  const save = (v) => { try { localStorage.setItem(KEY, v); } catch { /* not remembered */ } };
  const saved = load();
  const dark = saved ? saved === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');

  function wire() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) { document.documentElement.removeAttribute('data-theme'); save('light'); }
      else { document.documentElement.setAttribute('data-theme', 'dark'); save('dark'); }
      if (window.OFACGraph && window.OFACGraph.redraw) window.OFACGraph.redraw();
    });
  }
  if (document.readyState !== 'loading') wire();
  else document.addEventListener('DOMContentLoaded', wire);
})();
