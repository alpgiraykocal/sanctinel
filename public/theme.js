'use strict';

// Light/dark theme: honor a saved choice, else the OS preference. Runs from
// <head> so the attribute is set before first paint (minimal flash).
(function () {
  const KEY = 'sanctinel-theme';
  const saved = localStorage.getItem(KEY);
  const dark = saved ? saved === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');

  function wire() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) { document.documentElement.removeAttribute('data-theme'); localStorage.setItem(KEY, 'light'); }
      else { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem(KEY, 'dark'); }
      if (window.OFACGraph && window.OFACGraph.redraw) window.OFACGraph.redraw();
    });
  }
  if (document.readyState !== 'loading') wire();
  else document.addEventListener('DOMContentLoaded', wire);
})();
