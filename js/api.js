/* SARITA dashboard - client for the FastAPI backend (sarita/api.py).
 * The page also works as a plain static site (python -m http.server); then the API is "offline"
 * and every feature that needs it shows a friendly note instead of failing. */
(function () {
  'use strict';
  const S = window.SARITA;

  const START_CMD = '.venv/bin/uvicorn sarita.api:app --port 8000';

  const api = {
    state: 'checking',          // checking | online | offline
    health: null,
    startCommand: START_CMD,
    get online() { return this.state === 'online'; },

    async check() {
      const r = await S.fetchJSON('api/health', { timeout: 4000 });
      if (r.ok && r.data && r.data.status === 'ok') {
        this.state = 'online';
        this.health = r.data;
      } else {
        this.state = 'offline';
        this.health = null;
      }
      S.emit('api', this.state);
      return this.state;
    },

    summary() { return S.fetchJSON('api/summary', { timeout: 10000 }); },

    bulletin(district, date, lang) {
      return S.fetchJSON('api/bulletin', {
        method: 'POST', timeout: 20000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ district: district, date: date, lang: lang }),
      });
    },

    predictChip(name, tta) {
      const q = 'name=' + encodeURIComponent(name) + '&tta=' + (tta ? 'true' : 'false');
      return S.fetchJSON('api/predict_chip?' + q, { timeout: 180000 });
    },

    predictUpload(file, tta) {
      const fd = new FormData();
      fd.append('file', file, file.name);
      return S.fetchJSON('api/predict?tta=' + (tta === false ? 'false' : 'true'), { method: 'POST', body: fd, timeout: 300000 });
    },

    /** Friendly "start the API" note used wherever a feature needs the backend. */
    offlineNotice(what) {
      return S.notice({
        kind: 'offline',
        title: (what || 'This feature') + ' needs the SARITA API',
        text: 'The page is running as a static site, so nothing here can call the model. Start the API from the project folder and open http://localhost:8000:',
        code: START_CMD,
      });
    },

    /** True when a failed call means "no SARITA API here" (connection refused, or a plain static server). */
    isOffline(r) {
      if (!r || r.ok) return false;
      if (r.status === 0) return true;
      const fromApi = r.data && typeof r.data === 'object' && ('error' in r.data || 'detail' in r.data);
      return this.state === 'offline' && !fromApi;
    },

    /** Readable sentence for an API error result. */
    describeError(r) {
      if (!r) return 'Unknown error.';
      if (r.status === 0) return r.error || 'Could not reach the API.';
      if (r.status === 404 && /^HTTP 404/.test(r.error || '')) return 'The API does not offer this endpoint (HTTP 404). Is the latest sarita/api.py running?';
      if (r.status === 413) return 'The file is too large for the API.';
      if (r.status >= 500) return 'The API hit an internal error (HTTP ' + r.status + '): ' + (r.error || '') + ' - see the terminal running uvicorn.';
      return r.error || ('HTTP ' + r.status);
    },
  };
  S.api = api;
})();
