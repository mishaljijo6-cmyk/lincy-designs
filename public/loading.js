(() => {
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function' || window.__lincyLoadingInstalled) return;
  window.__lincyLoadingInstalled = true;

  const indicator = document.createElement('div');
  indicator.className = 'network-loading';
  indicator.hidden = true;
  indicator.setAttribute('role', 'status');
  indicator.setAttribute('aria-live', 'polite');
  indicator.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M29.5 7.1A16 16 0 1 0 35.7 20"/><path d="m28.2 20.4 7.8.6.6-7.8"/></svg><span>Loading…</span>';
  document.body.append(indicator);

  let pending = 0;
  let showTimer = 0;
  const finish = () => {
    pending = Math.max(0, pending - 1);
    if (pending === 0) {
      clearTimeout(showTimer);
      indicator.hidden = true;
    }
  };

  window.fetch = function (...args) {
    pending += 1;
    if (pending === 1) {
      showTimer = window.setTimeout(() => {
        if (pending > 0) indicator.hidden = false;
      }, 180);
    }
    try {
      return Promise.resolve(nativeFetch.apply(this, args)).finally(finish);
    } catch (error) {
      finish();
      throw error;
    }
  };
})();
