(function(){
  const assets = window.RIGHT4_DASHBOARD_ASSETS || {};
  const sessionKey = 'right4-dashboard-auth-v1';
  const gate = document.getElementById('accessGate');
  const securedApp = document.getElementById('securedApp');
  const form = document.getElementById('accessForm');
  const passwordInput = document.getElementById('accessPassword');
  const submitButton = document.getElementById('accessSubmit');
  const messageEl = document.getElementById('accessMessage');
  const toggleButton = document.getElementById('togglePassword');
  const logoutButton = document.getElementById('logoutButton');
  const statusPill = document.getElementById('accessStatus');

  if(!gate || !securedApp || !form || !passwordInput || !submitButton || !messageEl){
    return;
  }

  function setMessage(text, type){
    messageEl.textContent = text || '';
    messageEl.classList.remove('is-error', 'is-success');
    if(type === 'error') messageEl.classList.add('is-error');
    if(type === 'success') messageEl.classList.add('is-success');
  }

  function setBusy(isBusy){
    submitButton.disabled = isBusy;
    submitButton.textContent = isBusy ? 'Opening…' : 'Open dashboard';
  }

  function isConfigured(){
    return Boolean(assets.passwordSalt && assets.passwordHash && !String(assets.passwordSalt).includes('CHANGE_ME') && !String(assets.passwordHash).includes('CHANGE_ME'));
  }

  async function sha256Hex(value){
    const encoded = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function scriptAlreadyLoaded(src){
    return Array.from(document.scripts).some(script => script.src && script.src.includes(src));
  }

  function loadScript(src){
    return new Promise((resolve, reject) => {
      if(!src){
        reject(new Error('Missing script URL.'));
        return;
      }
      if(scriptAlreadyLoaded(src)){
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.body.appendChild(script);
    });
  }

  async function unlock(){
    gate.hidden = true;
    securedApp.hidden = false;
    securedApp.setAttribute('aria-hidden', 'false');
    logoutButton.hidden = false;
    statusPill.textContent = 'Access granted';
    statusPill.classList.add('is-open');

    if(window.__RIGHT4_ACCESS_LOADED__){
      return;
    }

    await loadScript(assets.plotlyUrl);
    await loadScript(assets.dataScript);
    await loadScript(assets.appScript);
    window.__RIGHT4_ACCESS_LOADED__ = true;
  }

  async function authenticate(password){
    const candidate = await sha256Hex(`${assets.passwordSalt}|${password}`);
    return candidate === assets.passwordHash;
  }

  if(!isConfigured()){
    setMessage('Configure passwordSalt and passwordHash in right4-access.js before deploying.', 'error');
    submitButton.disabled = true;
    passwordInput.disabled = true;
    if(toggleButton) toggleButton.disabled = true;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if(!isConfigured()) return;
    const password = passwordInput.value || '';
    if(!password.trim()){
      setMessage('Enter the shared password first.', 'error');
      passwordInput.focus();
      return;
    }

    setBusy(true);
    setMessage('Checking password…');
    try{
      const ok = await authenticate(password);
      if(!ok){
        setMessage('Incorrect password. Please try again.', 'error');
        passwordInput.select();
        return;
      }
      sessionStorage.setItem(sessionKey, assets.passwordHash);
      setMessage('Access granted. Loading dashboard…', 'success');
      await unlock();
    }catch(error){
      setMessage('The login gate could not be initialized. Please check the browser console.', 'error');
      console.error(error);
    }finally{
      setBusy(false);
    }
  });

  if(toggleButton){
    toggleButton.addEventListener('click', () => {
      const reveal = passwordInput.type === 'password';
      passwordInput.type = reveal ? 'text' : 'password';
      toggleButton.textContent = reveal ? 'Hide' : 'Show';
      toggleButton.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      passwordInput.focus();
    });
  }

  if(logoutButton){
    logoutButton.addEventListener('click', () => {
      sessionStorage.removeItem(sessionKey);
      window.location.reload();
    });
  }

  if(isConfigured() && sessionStorage.getItem(sessionKey) === assets.passwordHash){
    unlock().catch(error => {
      console.error(error);
      setMessage('Saved session found, but the dashboard assets could not be loaded.', 'error');
    });
  }
})();
