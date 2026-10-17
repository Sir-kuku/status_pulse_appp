/* Applied before the stylesheet so the first paint respects your preference. */
(() => {
  const key = 'status-pulse-theme';
  const choices = ['light', 'dark', 'system'];
  const media = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (choices.includes(saved)) preference = saved; } catch { /* Settings still work for this visit. */ }
  const shapes = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    dark: '<path d="M20.4 13.2A8.5 8.5 0 0 1 10.8 3.6 8.5 8.5 0 1 0 20.4 13.2Z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  };
  function apply() {
    const theme = preference === 'system' ? media.matches ? 'dark' : 'light' : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101526' : '#f6f7fb');
    document.querySelectorAll('[data-theme-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === preference)));
  }
  apply();
  media.addEventListener('change', apply);
  addEventListener('storage', event => { if (event.key === key) { preference = choices.includes(event.newValue) ? event.newValue : 'system'; apply(); } });
  document.addEventListener('click', event => {
    const theme = event.target.closest('[data-theme-choice]');
    if (theme) {
      preference = theme.dataset.themeChoice;
      try { localStorage.setItem(key, preference); } catch { /* Retain the in-memory preference. */ }
      apply();
    }
    const reveal = event.target.closest('[data-password-toggle]');
    if (reveal) {
      const input = document.getElementById(reveal.dataset.passwordToggle);
      if (!input) return;
      const visible = input.type === 'password';
      input.type = visible ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', String(visible));
      reveal.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
      reveal.title = visible ? 'Hide password' : 'Show password';
    }
  });
  const options = fetch('/api/auth/options', { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    .then(response => { if (!response.ok) throw new Error('Account options unavailable'); return response.json(); })
    .catch(() => null);
  window.StatusPulsePreferences = { options };
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-control]').forEach(control => {
      control.setAttribute('role', 'group');
      control.setAttribute('aria-label', 'Color theme');
      control.innerHTML = choices.map(choice => `<button type="button" data-theme-choice="${choice}" aria-label="${choice[0].toUpperCase() + choice.slice(1)} theme" title="${choice[0].toUpperCase() + choice.slice(1)} theme" aria-pressed="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[choice]}</svg></button>`).join('');
    });
    apply();
    void options.then(config => {
      const name = config?.branding?.creatorName || 'Sir. Kuku';
      let href;
      try { const url = new URL(config?.branding?.creatorUrl || 'https://github.com/Sir-kuku'); if (['https:', 'http:'].includes(url.protocol)) href = url.href; } catch { /* A plain-text credit is always safe. */ }
      document.querySelectorAll('[data-creator-credit]').forEach(credit => {
        credit.replaceChildren(document.createTextNode('Designed & built by '));
        const author = document.createElement(href ? 'a' : 'span');
        author.textContent = name;
        if (href) { author.href = href; author.target = '_blank'; author.rel = 'noopener noreferrer'; }
        credit.append(author);
      });
    });
  });
})();
