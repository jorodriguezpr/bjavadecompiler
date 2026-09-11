/**
 * BJavaDecompiler
 * Copyright 2026 Jose Rodriguez <jrpcone@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Developer: Jose Rodriguez <jrpcone@gmail.com>
 */

(function () {
  'use strict';

  const API = 'api'; // relative — must work when this page is mounted under any reverse-proxy subpath
  let currentJobId = null;
  let pollTimer = null;
  // Dependency-search UI state, kept outside the job object since job detail re-renders on
  // every 1.5s poll (see refreshJobDetail) — without this, an open search panel or in-progress
  // search would get wiped out mid-interaction by the next poll tick.
  let depSearch = { openJar: null, classOptions: [], query: '', results: [], loading: false, error: null, searched: false };
  function resetDepSearch() { depSearch = { openJar: null, classOptions: [], query: '', results: [], loading: false, error: null, searched: false }; }

  // ─── View switching ────────────────────────────────────────────────
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + name).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'jobs') loadJobsList();
    if (name === 'tools') { loadToolStatus(); loadEnvSettings(); }
    if (name === 'about') loadAboutInfo();
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  });

  async function api(path, opts) {
    const res = await fetch(API + path, opts);
    const json = await res.json();
    if (!json.success) throw new Error(json.error?.message || json.error || 'Request failed');
    return json.data;
  }

  // ─── Upload ─────────────────────────────────────────────────────────
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const uploadProgress = document.getElementById('uploadProgress');
  const uploadProgressBar = document.getElementById('uploadProgressBar');
  const toolStatusBanner = document.getElementById('toolStatusBanner');
  const targetJavaVersionSelect = document.getElementById('targetJavaVersion');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFile(fileInput.files[0]);
  });

  function uploadFile(file) {
    const form = new FormData();
    form.append('file', file);
    if (targetJavaVersionSelect && targetJavaVersionSelect.value !== 'auto') {
      form.append('targetJavaVersion', targetJavaVersionSelect.value);
    }

    uploadProgress.classList.remove('hidden');
    uploadProgressBar.style.width = '0%';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', API + '/jobs');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) uploadProgressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
    };
    xhr.onload = () => {
      uploadProgress.classList.add('hidden');
      try {
        const json = JSON.parse(xhr.responseText);
        if (!json.success) { alert(json.error?.message || json.error || 'Upload failed'); return; }
        openJob(json.data.id);
      } catch (err) {
        alert('Upload failed: ' + err.message);
      }
    };
    xhr.onerror = () => { uploadProgress.classList.add('hidden'); alert('Upload failed.'); };
    xhr.send(form);
  }

  async function checkUploadGate() {
    try {
      const status = await api('/system/status');
      if (!status.uploadReady) {
        toolStatusBanner.classList.remove('hidden');
        toolStatusBanner.className = 'banner warn';
        toolStatusBanner.textContent = 'Toolchain/engines not fully ready — check the Tool Setup tab before uploading.';
        dropzone.style.opacity = '0.5';
        dropzone.style.pointerEvents = 'none';
      } else {
        toolStatusBanner.classList.add('hidden');
        dropzone.style.opacity = '1';
        dropzone.style.pointerEvents = 'auto';
      }
    } catch (err) { /* non-fatal — leave upload enabled if the status check itself fails */ }
  }
  checkUploadGate();

  // ─── Jobs list ──────────────────────────────────────────────────────
  async function loadJobsList() {
    const jobs = await api('/jobs');
    const tbody = document.querySelector('#jobsTable tbody');
    tbody.innerHTML = '';
    for (const job of jobs) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(job.originalFilename) + '</td>' +
        '<td>' + statusBadge(job.status) + '</td>' +
        '<td>' + new Date(job.createdAt).toLocaleString() + '</td>' +
        '<td><button class="btn">Open</button></td>';
      tr.addEventListener('click', () => openJob(job.id));
      tbody.appendChild(tr);
    }
  }

  // Only ever deletes jobs in a genuinely terminal state (completed/completed_with_errors/
  // failed/cancelled) — the backend leaves paused/active jobs untouched regardless of this
  // button, but the confirmation text says so up front rather than surprising anyone after the
  // fact.
  document.getElementById('btnClearAllJobs').addEventListener('click', async () => {
    if (!confirm('Delete every finished job (completed/failed/cancelled) and its generated project? Paused or in-progress jobs are kept. This cannot be undone.')) return;
    const btn = document.getElementById('btnClearAllJobs');
    btn.disabled = true;
    btn.textContent = 'Clearing...';
    try {
      const result = await api('/jobs/clear-all', { method: 'POST' });
      await loadJobsList();
      alert('Cleared ' + result.cleared + ' job(s).' + (result.skipped ? ' ' + result.skipped + ' paused/in-progress job(s) kept.' : ''));
    } catch (err) {
      alert('Failed to clear jobs: ' + err.message);
    }
    btn.disabled = false;
    btn.textContent = 'Clear All Jobs';
  });

  function statusBadge(status) {
    const activeStatuses = ['extracting', 'resolving_dependencies', 'decompiling', 'scoring_candidates', 'ai_reconstructing', 'generating_project', 'verifying_build'];
    const cls = activeStatuses.includes(status) ? 'active' : status;
    return '<span class="badge badge-' + cls + '">' + status.replace(/_/g, ' ') + '</span>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ─── Job detail ─────────────────────────────────────────────────────
  const PIPELINE_STEPS = [
    'queued', 'extracting', 'resolving_dependencies', 'decompiling',
    'scoring_candidates', 'ai_reconstructing', 'generating_project', 'verifying_build',
  ];

  function openJob(id) {
    currentJobId = id;
    resetDepSearch();
    showView('job-detail');
    refreshJobDetail();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.getElementById('view-job-detail').classList.contains('active')) refreshJobDetail();
      else clearInterval(pollTimer);
    }, 1500);
  }

  async function refreshJobDetail() {
    let job;
    try { job = await api('/jobs/' + currentJobId); } catch (err) { return; }

    document.getElementById('jobDetailTitle').textContent = job.originalFilename + ' — ' + job.status.replace(/_/g, ' ');

    renderStepper(job);
    renderCurrentActivity(job);
    renderClassList(job);
    renderDependencyPanel(job);
    renderFrameworkPanel(job);
    renderBuildPanel(job);
    renderMissingPackagePanel(job);
    renderExcludedFilePanel(job);
    renderLog(job);

    const activeStatuses = ['extracting', 'resolving_dependencies', 'decompiling', 'scoring_candidates', 'ai_reconstructing', 'generating_project', 'verifying_build'];
    document.getElementById('btnPause').disabled = !activeStatuses.includes(job.status);
    document.getElementById('btnResume').disabled = job.status !== 'paused';
    document.getElementById('btnCancel').disabled = !activeStatuses.includes(job.status) && job.status !== 'paused';
    document.getElementById('btnDownload').disabled = !job.generatedProjectDir;
    document.getElementById('btnBrowse').disabled = !job.generatedProjectDir;
  }

  function renderStepper(job) {
    const el = document.getElementById('stepper');
    el.innerHTML = '';
    const failedTerminal = ['failed', 'cancelled'].includes(job.status);
    const currentIndex = PIPELINE_STEPS.indexOf(job.status);
    for (let i = 0; i < PIPELINE_STEPS.length; i++) {
      const step = document.createElement('span');
      step.className = 'step';
      if (job.status === 'completed' || job.status === 'completed_with_errors' || (currentIndex >= 0 && i < currentIndex)) step.classList.add('done');
      else if (i === currentIndex) step.classList.add(failedTerminal ? 'failed' : 'current');
      step.textContent = PIPELINE_STEPS[i].replace(/_/g, ' ');
      el.appendChild(step);
    }
    if (job.status === 'completed' || job.status === 'completed_with_errors' || failedTerminal || job.status === 'paused') {
      const step = document.createElement('span');
      step.className = 'step ' + (job.status === 'completed' ? 'done' : job.status === 'completed_with_errors' ? 'current' : job.status === 'paused' ? '' : 'failed');
      step.textContent = job.status.replace(/_/g, ' ');
      el.appendChild(step);
    }
  }

  function renderClassList(job) {
    document.getElementById('classCount').textContent = '(' + job.classes.length + ')';
    const list = document.getElementById('classList');
    const filter = (document.getElementById('classSearch').value || '').toLowerCase();
    list.innerHTML = '';
    for (const c of job.classes) {
      if (filter && !c.fqcn.toLowerCase().includes(filter)) continue;
      const row = document.createElement('div');
      row.className = 'class-row';
      const badge = c.aiStatus === 'reconstructed' ? '<span class="badge badge-completed">AI fixed</span>'
        : c.aiStatus === 'failed_fallback' ? '<span class="badge badge-completed_with_errors">fallback</span>'
        : c.aiStatus === 'sent' ? '<span class="badge badge-active">AI...</span>'
        : '<span class="badge badge-queued">clean</span>';
      row.innerHTML = '<span>' + escapeHtml(c.fqcn) + ' <span class="muted">(' + (c.winningEngine || 'none') + ')</span></span>' + badge;
      list.appendChild(row);
    }
  }
  document.getElementById('classSearch').addEventListener('input', () => { if (currentJobId) refreshJobDetail(); });

  /** Dependencies panel — every bundled jar's resolved (or still-unresolved) Maven coordinate.
   * For an 'unresolved' one, "Search Maven" expands an inline panel: pick one of the jar's own
   * class names (or type free text) to search Maven Central, then apply whichever result is
   * actually the right library — same workflow as NetBeans' "Search in Repositories" fix for a
   * red unresolved import. Results are NOT auto-ranked as "the" answer: Central's class index
   * includes shaded/relocated copies of common classes in unrelated jars, so a human has to
   * recognize the right one from the list, same as in NetBeans itself. */
  function renderDependencyPanel(job) {
    const el = document.getElementById('dependencyPanel');
    if (!el) return; // panel not present in the DOM (older theme html)
    const deps = job.dependencies || [];
    if (!deps.length) {
      el.innerHTML = '<span class="muted">No bundled dependency jars.</span>';
      return;
    }
    el.innerHTML = deps.map(d => {
      const isUnresolved = d.confidence === 'unresolved';
      // A shared-dependencies match still carries confidence 'unresolved' (these coordinates are
      // never Central-downloadable, see dependencyResolutionService.ts's matchSharedLibrary()) —
      // but it WAS identified from a jar the user already had, not left as a bare guess, so it
      // gets its own badge state rather than reading identically to "no lead at all".
      const isSharedMatch = isUnresolved && !!d.sharedLibrarySource;
      const badgeClass = isSharedMatch ? 'badge-paused'
        : d.confidence === 'unresolved' ? 'badge-failed'
        : d.confidence === 'manual' ? 'badge-active'
        : d.confidence === 'auto-class-match' ? 'badge-active'
        : d.confidence === 'guess' ? 'badge-paused'
        : 'badge-completed';
      const badgeLabel = isSharedMatch ? 'unresolved (shared-lib match)' : d.confidence;
      const canSearch = isUnresolved || d.confidence === 'auto-class-match' || d.confidence === 'guess';
      const open = depSearch.openJar === d.jarName;
      let html = '<div class="dep-row">' +
        '<div class="dep-row-main">' +
        '<span class="dep-name">' + escapeHtml(d.jarName) + '</span>' +
        '<span class="dep-coord muted">' + escapeHtml(d.groupId + ':' + d.artifactId + ':' + d.version) + '</span>' +
        '<span class="badge ' + badgeClass + '">' + escapeHtml(badgeLabel) + '</span>' +
        (isSharedMatch ? '<span class="muted dep-shared-note">matched local jar: ' + escapeHtml(d.sharedLibrarySource) + '</span>' : '') +
        (canSearch ? '<button class="btn dep-search-toggle" data-jar="' + escapeHtml(d.jarName) + '">' + (open ? 'Close' : 'Search Maven') + '</button>' : '') +
        '</div>';
      if (open) html += renderDepSearchPanel(d);
      html += '</div>';
      return html;
    }).join('');

    wireDependencyPanelEvents(job.id);
  }

  function renderDepSearchPanel(dep) {
    let html = '<div class="dep-search-panel">';
    if (depSearch.classOptions.length) {
      html += '<div class="dep-search-row"><select class="dep-class-select">' +
        depSearch.classOptions.map(c => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('') +
        '</select><button class="btn dep-search-class-btn">Search by class</button></div>';
    } else {
      html += '<div class="muted">No class names found in this jar — try a text search instead.</div>';
    }
    html += '<div class="dep-search-row"><input type="text" class="text-input dep-text-input" placeholder="or search by library name..." value="' + escapeHtml(depSearch.query) + '">' +
      '<button class="btn dep-search-text-btn">Search</button></div>';
    if (depSearch.loading) html += '<div class="muted">Searching Maven Central...</div>';
    if (depSearch.error) html += '<div class="log-error">' + escapeHtml(depSearch.error) + '</div>';
    if (depSearch.results.length) {
      html += '<ul class="dep-results">' + depSearch.results.map(r =>
        '<li><code>' + escapeHtml(r.groupId + ':' + r.artifactId + ':' + r.version) + '</code> ' +
        '<button class="btn btn-primary dep-use-btn" data-jar="' + escapeHtml(dep.jarName) +
        '" data-g="' + escapeHtml(r.groupId) + '" data-a="' + escapeHtml(r.artifactId) + '" data-v="' + escapeHtml(r.version) + '">Use this</button></li>'
      ).join('') + '</ul>';
    } else if (!depSearch.loading && (depSearch.query || depSearch.searched)) {
      html += '<div class="muted">No results.</div>';
    }
    html += '</div>';
    return html;
  }

  async function runDepSearch(params) {
    depSearch.loading = true; depSearch.error = null; depSearch.results = []; depSearch.searched = true;
    await refreshJobDetail();
    try {
      const qs = params.class ? ('class=' + encodeURIComponent(params.class)) : ('q=' + encodeURIComponent(params.q));
      depSearch.results = await api('/maven/search?' + qs);
    } catch (err) {
      depSearch.error = 'Search failed: ' + err.message;
    }
    depSearch.loading = false;
    await refreshJobDetail();
  }

  function wireDependencyPanelEvents(jobId) {
    document.querySelectorAll('.dep-search-toggle').forEach(btn => {
      btn.addEventListener('click', async () => {
        const jar = btn.dataset.jar;
        if (depSearch.openJar === jar) {
          resetDepSearch();
        } else {
          resetDepSearch();
          depSearch.openJar = jar;
          try {
            depSearch.classOptions = await api('/jobs/' + jobId + '/dependencies/' + encodeURIComponent(jar) + '/classes');
          } catch (err) { /* best-effort — a free-text search still works without it */ }
        }
        refreshJobDetail();
      });
    });

    document.querySelectorAll('.dep-search-class-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const select = btn.closest('.dep-search-panel').querySelector('.dep-class-select');
        if (select) runDepSearch({ class: select.value });
      });
    });

    document.querySelectorAll('.dep-search-text-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = btn.closest('.dep-search-panel').querySelector('.dep-text-input');
        const q = (input?.value || '').trim();
        if (q) { depSearch.query = q; runDepSearch({ q }); }
      });
    });

    document.querySelectorAll('.dep-use-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { jar, g, a, v } = btn.dataset;
        btn.disabled = true;
        btn.textContent = 'Applying...';
        try {
          await api('/jobs/' + jobId + '/dependencies/' + encodeURIComponent(jar) + '/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupId: g, artifactId: a, version: v }),
          });
          resetDepSearch();
          refreshJobDetail();
        } catch (err) {
          alert('Failed to apply dependency: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Use this';
        }
      });
    });
  }

  /** Live "what's running right now" box — distinct from the scrolling job log below it, so a
   * developer can tell at a glance whether the app is stuck or just mid-command, and see the
   * exact `java`/`mvn` invocation without hunting through the log history. */
  function renderCurrentActivity(job) {
    const box = document.getElementById('currentActivity');
    const text = document.getElementById('currentActivityText');
    if (!box || !text) return;
    if (job.currentOperation) {
      text.textContent = job.currentOperation;
      box.hidden = false;
    } else {
      box.hidden = true;
    }
  }

  function renderFrameworkPanel(job) {
    const el = document.getElementById('frameworkPanel');
    if (!el) return; // panel not present in the DOM (older theme html)
    const fws = job.detectedFrameworks || [];
    const countEl = document.getElementById('frameworkCount');
    if (countEl) countEl.textContent = fws.length ? '(' + fws.length + ')' : '';
    if (!fws.length) {
      el.innerHTML = '<span class="muted">No framework-specific dependencies detected — plain Java project.</span>';
      return;
    }
    const primary = job.detectedPrimaryFramework;
    let html = '<ul class="framework-list">';
    for (const f of fws) {
      const isPrimary = primary && f.id === primary;
      html += '<li><strong>' + escapeHtml(f.label) + '</strong>' + (isPrimary ? ' <span class="badge badge-completed">primary</span>' : '') +
        ' <span class="muted">(' + escapeHtml(f.confidence) + ')</span><br><span class="muted framework-evidence">' + escapeHtml(f.evidence) + '</span></li>';
    }
    html += '</ul>';
    el.innerHTML = html;
  }

  function renderBuildPanel(job) {
    const el = document.getElementById('buildPanel');
    if (!job.buildAttempts.length) { el.textContent = 'No build attempt yet.'; return; }
    const last = job.buildAttempts[job.buildAttempts.length - 1];
    let html = 'Attempt ' + last.attempt + '/' + (job.buildAttempts.maxAttempts || last.attempt) + ' — ' +
      (last.success ? '<span class="status-ok">SUCCESS</span>' : '<span class="status-bad">' + last.errorCount + ' error(s)</span>');
    if (!last.success) {
      html += '<ul>';
      for (const [file, errors] of Object.entries(last.errorsByFile)) {
        html += '<li>' + escapeHtml(file) + '<ul>' + errors.map(e => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul></li>';
      }
      html += '</ul>';
    }
    el.innerHTML = html;
  }

  // Packages javac reported as entirely missing (`package X does not exist` — a class the
  // decompiled code references that was never bundled in this WAR's own WEB-INF/lib at all) and
  // what, if anything, the shared-dependencies folder search found for each. Distinct from the
  // Dependencies panel above: an entry here that got 'resolved' already shows up there too (as a
  // new dependency), so this panel's real value is the ones still 'ambiguous'/'not_found'/
  // 'not_configured' — the ones that still need a human to do something.
  function renderMissingPackagePanel(job) {
    const el = document.getElementById('missingPackagePanel');
    const countEl = document.getElementById('missingPackageCount');
    const pkgs = job.missingPackages || [];
    if (countEl) countEl.textContent = pkgs.length ? '(' + pkgs.length + ')' : '';
    if (!pkgs.length) {
      el.innerHTML = '<div class="empty-note muted">No packages missing entirely from this WAR — every referenced class was found somewhere.</div>';
      return;
    }
    const badgeClass = { resolved: 'badge-completed', ambiguous: 'badge-active', not_found: 'badge-failed', not_configured: 'badge-paused' };
    const label = { resolved: 'resolved', ambiguous: 'ambiguous match', not_found: 'not found', not_configured: 'no shared folder configured' };
    el.innerHTML = pkgs.map(p => {
      let detail = '';
      if (p.status === 'resolved' && p.resolvedVia && p.resolvedVia.startsWith('workspace:')) detail = 'reused already-decompiled source from another job\'s ' + escapeHtml(p.resolvedVia.slice('workspace:'.length));
      else if (p.status === 'resolved') detail = 'added from ' + escapeHtml(p.resolvedVia);
      else if (p.status === 'ambiguous') detail = p.candidateJars.length + ' sources supply it: ' + escapeHtml(p.candidateJars.join(', '));
      else if (p.status === 'not_found') detail = 'no jar or previously-decompiled job supplies it';
      else if (p.status === 'not_configured') detail = 'set SHARED_DEPENDENCIES_DIRS in Tool Setup to search for it';
      return '<div class="mp-row">' +
        '<span class="mp-name">' + escapeHtml(p.package) + '</span>' +
        '<span class="badge ' + (badgeClass[p.status] || 'badge-paused') + '">' + escapeHtml(label[p.status] || p.status) + '</span>' +
        '<span class="mp-detail muted">' + detail + '</span>' +
        '</div>';
    }).join('');
  }

  // Decompiled dependency source files deadCodePruningService.ts moved out of the compiled path
  // (Config.pruneUnfixableDecompiledClasses, off by default) — always the result of a genuinely
  // unobtainable dependency (e.g. com.sun.jdmk.comm) combined with nothing else in the project
  // referencing that class. Files are relocated, not deleted, so this list is what makes the
  // decision inspectable rather than a silent edit.
  function renderExcludedFilePanel(job) {
    const el = document.getElementById('excludedFilePanel');
    const countEl = document.getElementById('excludedFileCount');
    const files = job.excludedUnfixableFiles || [];
    if (countEl) countEl.textContent = files.length ? '(' + files.length + ')' : '';
    if (!files.length) {
      el.innerHTML = '<div class="empty-note muted">No decompiled classes have been pruned.</div>';
      return;
    }
    el.innerHTML = files.map(f =>
      '<div class="mp-row">' +
      '<span class="mp-name">' + escapeHtml(f.relativePath) + '</span>' +
      '<span class="badge badge-paused">pruned</span>' +
      '<span class="mp-detail muted">' + escapeHtml(f.reason) + '</span>' +
      '</div>'
    ).join('');
  }

  function renderLog(job) {
    const el = document.getElementById('jobLog');
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 10;
    el.innerHTML = job.log.map(l =>
      '<div class="log-' + l.level + '">' + new Date(l.timestamp).toLocaleTimeString() + ' ' + escapeHtml(l.message) + '</div>'
    ).join('');
    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  document.getElementById('btnPause').addEventListener('click', () => api('/jobs/' + currentJobId + '/pause', { method: 'POST' }).then(refreshJobDetail));
  document.getElementById('btnResume').addEventListener('click', () => api('/jobs/' + currentJobId + '/resume', { method: 'POST' }).then(refreshJobDetail));
  document.getElementById('btnCancel').addEventListener('click', () => {
    if (confirm('Cancel this job?')) api('/jobs/' + currentJobId + '/cancel', { method: 'POST' }).then(refreshJobDetail);
  });
  document.getElementById('btnDownload').addEventListener('click', () => {
    window.location.href = API + '/jobs/' + currentJobId + '/download';
  });
  document.getElementById('btnBrowse').addEventListener('click', () => { showView('browse'); loadFileTree(); });
  document.getElementById('btnDownloadOriginal').addEventListener('click', () => {
    window.location.href = API + '/jobs/' + currentJobId + '/original';
  });

  // ─── File browser ───────────────────────────────────────────────────
  async function loadFileTree() {
    const tree = await api('/jobs/' + currentJobId + '/tree');
    const el = document.getElementById('fileTree');
    el.innerHTML = '';
    el.appendChild(renderTreeNode(tree, ''));
  }

  function renderTreeNode(node, parentPath) {
    const fullPath = parentPath ? parentPath + '/' + node.name : node.name;
    const wrapper = document.createElement('div');
    if (node.type === 'dir') {
      const label = document.createElement('div');
      label.className = 'dir';
      label.textContent = '\u{1F4C1} ' + node.name;
      wrapper.appendChild(label);
      const childWrap = document.createElement('div');
      childWrap.style.paddingLeft = '14px';
      for (const child of node.children || []) childWrap.appendChild(renderTreeNode(child, fullPath));
      wrapper.appendChild(childWrap);
    } else {
      const label = document.createElement('div');
      label.className = 'file';
      label.textContent = node.name;
      label.addEventListener('click', () => loadFileContent(fullPath));
      wrapper.appendChild(label);
    }
    return wrapper;
  }

  async function loadFileContent(relPath) {
    const res = await fetch(API + '/jobs/' + currentJobId + '/file?path=' + encodeURIComponent(relPath));
    document.getElementById('fileContent').textContent = await res.text();
  }

  // ─── Tool Setup ─────────────────────────────────────────────────────
  async function loadToolStatus() {
    const status = await api('/system/status');

    document.getElementById('toolchainStatus').innerHTML = [
      toolCard('Java', status.toolchain.java.available, status.toolchain.java.version || status.toolchain.java.error),
      toolCard('Maven', status.toolchain.maven.available, status.toolchain.maven.version || status.toolchain.maven.error),
    ].join('');

    document.getElementById('engineStatus').innerHTML = status.engines.map(e =>
      toolCard(e.name, e.installed, e.installed ? ('v' + e.version + ' (' + Math.round((e.sizeBytes || 0) / 1024) + ' KB)' + (e.checksumVerified ? ', checksum verified' : ', checksum NOT verified')) : 'not installed', e.name)
    ).join('');

    renderAiAndSpeedStatus(status);

    document.querySelectorAll('[data-install-engine]').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Installing...';
        try {
          await api('/system/engines/' + btn.dataset.installEngine + '/install', { method: 'POST' });
          loadToolStatus();
        } catch (err) {
          alert('Install failed: ' + err.message);
          btn.disabled = false;
          btn.textContent = 'Retry install';
        }
      });
    });
  }

  /** Renders the AI provider card + speed-toggle summary from a /system/status-shaped object —
   * shared by loadToolStatus() and the Reload .env handler below, since both need to show the
   * exact same fields after fetching them from two different endpoints. */
  function renderAiAndSpeedStatus(status) {
    const AI_LABELS = { 'ollama-cloud': 'Ollama Cloud', 'ollama-local': 'Ollama (local)', 'lm-studio': 'LM Studio (local)', 'openai': 'OpenAI', 'anthropic': 'Anthropic (Claude API)', 'ai-delegation': 'AI Delegation (Claude Code)' };
    const aiLabel = AI_LABELS[status.aiProvider] || status.aiProvider;
    let aiReady = status.aiConfigured;
    let aiDetail;
    if (!status.aiEnabled) {
      aiDetail = 'disabled via AI_ENABLED=false — pipeline runs with zero AI dependency';
    } else if (status.aiProvider === 'ollama-local') {
      const local = status.aiLocal || { reachable: false, modelPulled: false };
      aiReady = local.reachable && local.modelPulled;
      aiDetail = !local.reachable
        ? 'not reachable at the configured OLLAMA_LOCAL_HOST — run `ollama serve`'
        : !local.modelPulled
          ? 'server reachable, but ' + status.aiModel + ' is not pulled — run `ollama pull ' + status.aiModel + '`'
          : 'model ' + status.aiModel + ' pulled and ready';
    } else if (status.aiProvider === 'lm-studio') {
      const lms = status.aiLmStudio || { reachable: false, modelPulled: false };
      // Unlike ollama-local, a reachable-but-"wrong model name" LM Studio server still works
      // (its default single-model server mode ignores the request's model field), so only
      // reachability gates the ready badge — the model line below is informational, not a block.
      aiReady = lms.reachable;
      aiDetail = !lms.reachable
        ? 'not reachable at the configured LM_STUDIO_HOST — start the server from LM Studio\'s Developer tab'
        : lms.modelPulled
          ? 'model ' + status.aiModel + ' loaded and ready'
          : 'server reachable — load a model in LM Studio (AI_MODEL is informational for its single-model server mode)';
    } else if (status.aiProvider === 'openai') {
      aiDetail = status.aiConfigured ? 'API key configured, model ' + status.aiModel : 'OPENAI_API_KEY not set';
    } else if (status.aiProvider === 'anthropic') {
      aiDetail = status.aiConfigured ? 'API key configured, model ' + status.aiModel : 'ANTHROPIC_API_KEY not set';
    } else if (status.aiProvider === 'ai-delegation') {
      const worker = status.aiDelegationWorker || { lastSeenAt: null, online: false };
      aiReady = worker.online;
      aiDetail = worker.online
        ? 'AiWindowsAssistant worker online (last seen ' + new Date(worker.lastSeenAt).toLocaleTimeString() + ')'
        : worker.lastSeenAt
          ? 'AiWindowsAssistant worker not seen recently (last seen ' + new Date(worker.lastSeenAt).toLocaleString() + ') — is it running?'
          : 'no AiWindowsAssistant worker has ever polled — copy the key below into its .env';
    } else {
      aiDetail = status.aiConfigured ? 'API key configured, model ' + status.aiModel : 'OLLAMA_CLOUD_API_KEY not set';
    }
    document.getElementById('aiStatus').innerHTML = toolCard(aiLabel, aiReady, aiDetail);

    const delegationEl = document.getElementById('aiDelegationPanel');
    if (delegationEl) delegationEl.hidden = status.aiProvider !== 'ai-delegation';

    const speedNotes = [];
    if (status.enabledEngines && status.enabledEngines.length < 5) speedNotes.push('Engines restricted to: ' + status.enabledEngines.join(', ') + ' (DECOMPILE_ENGINES).');
    if (!status.decompileUnresolvedLibs) speedNotes.push('Unresolved dependency jars are NOT decompiled (DECOMPILE_UNRESOLVED_LIBS=false) — left as binary placeholders.');
    if (status.decompileParallel) speedNotes.push('Engines run in parallel (DECOMPILE_PARALLEL=true).');
    const speedEl = document.getElementById('speedNotes');
    if (speedEl) speedEl.innerHTML = speedNotes.length ? speedNotes.map(s => '<div>' + escapeHtml(s) + '</div>').join('') : '<span class="muted">Default settings — all 5 engines, unresolved libs decompiled, sequential execution.</span>';
  }

  /** Shared by "Reload .env" and "Save Settings" — both endpoints return the same
   * {changed, restartRequiredFor, status} shape, so both render identically. */
  function showReloadResult(result) {
    renderAiAndSpeedStatus(result.status);
    const resultEl = document.getElementById('reloadEnvResult');
    let html;
    if (!result.changed.length) {
      html = '<span class="muted">No changes detected.</span>';
    } else {
      html = '<div>Applied: ' + result.changed.map(escapeHtml).join(', ') + '</div>';
      if (result.restartRequiredFor.length) {
        html += '<div class="log-warn">' + result.restartRequiredFor.map(escapeHtml).join(', ') + ' need a full app restart, not just this reload.</div>';
      }
    }
    resultEl.innerHTML = html;
    resultEl.hidden = false;
  }

  function showReloadError(prefix, err) {
    const resultEl = document.getElementById('reloadEnvResult');
    resultEl.innerHTML = '<span class="log-error">' + escapeHtml(prefix + ': ' + err.message) + '</span>';
    resultEl.hidden = false;
  }

  // Applies .env changes live, no process restart — Config's getters all read process.env on
  // every call rather than caching values at startup, so AI_ENABLED/AI_PROVIDER/AI_MODEL/
  // DECOMPILE_* etc. take effect on the very next job or dependency-fix action. PORT/NODE_ENV
  // are the one real exception (the HTTP server is already bound to the old port) — the backend
  // calls those out explicitly rather than pretending they applied. Use this after editing .env
  // externally (a text editor, deploy script); use "Save Settings" below to edit from the browser.
  document.getElementById('btnClearCache').addEventListener('click', async () => {
    if (!confirm('Clear the dependency-resolution cache and the decompiled-library cache? Future jobs will re-derive everything from scratch (slower for unresolved libraries until the cache rebuilds). This cannot be undone.')) return;
    const btn = document.getElementById('btnClearCache');
    btn.disabled = true;
    btn.textContent = 'Clearing...';
    try {
      const result = await api('/system/clear-cache', { method: 'POST' });
      alert('Cleared ' + result.depEntriesCleared + ' dependency-resolution entr' + (result.depEntriesCleared === 1 ? 'y' : 'ies') + ' and ' + result.libCacheEntriesCleared + ' decompiled-library cache entr' + (result.libCacheEntriesCleared === 1 ? 'y' : 'ies') + '.');
    } catch (err) {
      alert('Failed to clear cache: ' + err.message);
    }
    btn.disabled = false;
    btn.textContent = 'Clear Cache';
  });

  document.getElementById('btnTestAi').addEventListener('click', async () => {
    const btn = document.getElementById('btnTestAi');
    const resultEl = document.getElementById('aiTestResult');
    btn.disabled = true;
    btn.textContent = 'Testing...';
    resultEl.hidden = true;
    try {
      const result = await api('/system/test-ai', { method: 'POST' });
      resultEl.innerHTML = '<span class="' + (result.success ? '' : 'log-error') + '">' +
        (result.success ? '✓ ' : '✗ ') + escapeHtml(result.message || 'No response') + '</span>';
      resultEl.hidden = false;
    } catch (err) {
      resultEl.innerHTML = '<span class="log-error">Test failed: ' + escapeHtml(err.message) + '</span>';
      resultEl.hidden = false;
    }
    btn.disabled = false;
    btn.textContent = 'Test Connection';
  });

  document.getElementById('btnReloadEnv').addEventListener('click', async () => {
    const btn = document.getElementById('btnReloadEnv');
    btn.disabled = true;
    btn.textContent = 'Reloading...';
    try {
      showReloadResult(await api('/system/reload-env', { method: 'POST' }));
      loadEnvSettings(); // refresh the form too — an external edit may have changed values it shows
    } catch (err) {
      showReloadError('Reload failed', err);
    }
    btn.disabled = false;
    btn.textContent = 'Reload .env';
  });

  // ─── AI Delegation worker key (shown only when AI_PROVIDER=ai-delegation) ──
  document.getElementById('aiDelegationSelfUrl').textContent = window.location.origin;

  let delegationKeyRevealed = null;
  document.getElementById('btnRevealDelegationKey').addEventListener('click', async () => {
    const btn = document.getElementById('btnRevealDelegationKey');
    const el = document.getElementById('aiDelegationKeyValue');
    if (delegationKeyRevealed) {
      el.textContent = '••••••••••••••••';
      delegationKeyRevealed = null;
      btn.textContent = 'Reveal';
      return;
    }
    try {
      const data = await api('/system/ai-delegation-key');
      delegationKeyRevealed = data.key;
      el.textContent = data.key;
      btn.textContent = 'Hide';
    } catch (err) {
      alert('Failed to load key: ' + err.message);
    }
  });

  document.getElementById('btnCopyDelegationKey').addEventListener('click', async () => {
    const btn = document.getElementById('btnCopyDelegationKey');
    try {
      const data = await api('/system/ai-delegation-key');
      await navigator.clipboard.writeText(data.key);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch (err) {
      alert('Failed to copy key: ' + err.message);
    }
  });

  document.getElementById('btnRegenerateDelegationKey').addEventListener('click', async () => {
    if (!confirm('Regenerate the AI delegation worker key? AiWindowsAssistant will need its .env updated with the new key, or its polling will start failing with 401s.')) return;
    try {
      const data = await api('/system/ai-delegation-key/regenerate', { method: 'POST' });
      delegationKeyRevealed = data.key;
      document.getElementById('aiDelegationKeyValue').textContent = data.key;
      document.getElementById('btnRevealDelegationKey').textContent = 'Hide';
    } catch (err) {
      alert('Failed to regenerate key: ' + err.message);
    }
  });

  // ─── Settings form (every .env option, editable in the browser) ────────
  const ALL_ENGINE_NAMES = ['cfr', 'vineflower', 'jdcli', 'jadx', 'procyon'];
  let envSchema = [];
  let envSecretIsSet = {};

  async function loadEnvSettings() {
    try {
      const data = await api('/system/env');
      envSchema = data.schema;
      envSecretIsSet = data.secretIsSet;
      renderEnvSettingsForm(data.values);
    } catch (err) {
      const form = document.getElementById('envSettingsForm');
      if (form) form.innerHTML = '<span class="log-error">Could not load settings: ' + escapeHtml(err.message) + '</span>';
    }
  }

  function renderEnvField(f, values) {
    const val = values[f.key] || '';
    const restartNote = f.restartRequired ? ' <span class="muted">(restart required)</span>' : '';
    let input;
    if (f.type === 'boolean') {
      const checked = val.trim().toLowerCase() === 'true' ? 'checked' : '';
      return '<div class="env-field"><label class="env-checkbox"><input type="checkbox" data-env-key="' + f.key + '" ' + checked + '> ' +
        escapeHtml(f.label) + restartNote + '</label>' +
        (f.help ? '<div class="muted env-help">' + escapeHtml(f.help) + '</div>' : '') + '</div>';
    }
    if (f.type === 'select') {
      input = '<select data-env-key="' + f.key + '">' + f.options.map(o =>
        '<option value="' + escapeHtml(o) + '"' + (val === o ? ' selected' : '') + '>' + escapeHtml(o) + '</option>'
      ).join('') + '</select>';
    } else if (f.type === 'secret') {
      const placeholder = envSecretIsSet[f.key] ? 'already set — leave blank to keep' : 'not set';
      input = '<input type="password" data-env-key="' + f.key + '" placeholder="' + escapeHtml(placeholder) + '" autocomplete="new-password">';
    } else if (f.type === 'engines') {
      const selected = val ? val.split(',').map(s => s.trim()).filter(Boolean) : [];
      input = '<div class="env-engines">' + ALL_ENGINE_NAMES.map(e =>
        '<label><input type="checkbox" data-env-engine="' + e + '" ' + (selected.length === 0 || selected.includes(e) ? 'checked' : '') + '> ' + e + '</label>'
      ).join('') + '</div>';
    } else {
      input = '<input type="' + (f.type === 'number' ? 'number' : 'text') + '" data-env-key="' + f.key + '" value="' + escapeHtml(val) + '" placeholder="' + escapeHtml(f.help || '') + '">';
    }
    return '<div class="env-field"><label>' + escapeHtml(f.label) + restartNote + '</label>' + input +
      (f.help && f.type !== 'engines' ? '<div class="muted env-help">' + escapeHtml(f.help) + '</div>' : '') + '</div>';
  }

  function renderEnvSettingsForm(values) {
    const el = document.getElementById('envSettingsForm');
    if (!el) return;
    const groups = [];
    const byGroup = {};
    for (const f of envSchema) {
      if (!byGroup[f.group]) { byGroup[f.group] = []; groups.push(f.group); }
      byGroup[f.group].push(f);
    }
    el.innerHTML = groups.map(g =>
      '<fieldset class="env-group"><legend>' + escapeHtml(g) + '</legend>' + byGroup[g].map(f => renderEnvField(f, values)).join('') + '</fieldset>'
    ).join('');
  }

  function collectEnvFormValues() {
    const values = {};
    document.querySelectorAll('#envSettingsForm [data-env-key]').forEach(input => {
      values[input.dataset.envKey] = input.type === 'checkbox' ? String(input.checked) : input.value;
    });
    const engineBoxes = document.querySelectorAll('#envSettingsForm [data-env-engine]');
    if (engineBoxes.length) {
      const checked = Array.from(engineBoxes).filter(b => b.checked).map(b => b.dataset.envEngine);
      values.DECOMPILE_ENGINES = checked.length === ALL_ENGINE_NAMES.length ? '' : checked.join(',');
    }
    return values;
  }

  document.getElementById('btnSaveEnv').addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('btnSaveEnv');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const values = collectEnvFormValues();
      const result = await api('/system/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values }),
      });
      showReloadResult(result);
      loadEnvSettings(); // re-fetch so the secret field's "already set" placeholder reflects reality
    } catch (err) {
      showReloadError('Save failed', err);
    }
    btn.disabled = false;
    btn.textContent = 'Save Settings';
  });

  // ─── About ──────────────────────────────────────────────────────────
  async function loadAboutInfo() {
    const el = document.getElementById('aboutPanel');
    try {
      const about = await api('/system/about');
      el.innerHTML =
        '<h3>' + escapeHtml(about.appName) + ' v' + escapeHtml(about.version) + '</h3>' +
        '<p>' + escapeHtml(about.description) + '</p>' +
        '<p><strong>Developer:</strong> ' + escapeHtml(about.author) + '</p>' +
        '<p><strong>License:</strong> ' + escapeHtml(about.license) + '</p>' +
        (about.repositoryUrl ? '<p><strong>Repository:</strong> <a href="' + escapeHtml(about.repositoryUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(about.repositoryUrl) + '</a></p>' : '') +
        (about.licenseText ? '<h3>License text</h3><pre>' + escapeHtml(about.licenseText) + '</pre>' : '');
    } catch (err) {
      el.innerHTML = '<span class="log-error">Could not load About info: ' + escapeHtml(err.message) + '</span>';
    }
  }

  async function loadFooterCredit() {
    try {
      const about = await api('/system/about');
      const repoLink = about.repositoryUrl
        ? ' — <a href="' + escapeHtml(about.repositoryUrl) + '" target="_blank" rel="noopener noreferrer">GitHub</a>'
        : '';
      document.getElementById('footerCredit').innerHTML =
        escapeHtml(about.appName + ' v' + about.version + ' — Developed by ' + about.author + ' — ' + about.license + ' License') + repoLink;
    } catch (err) { /* footer credit is cosmetic — a failed fetch just leaves the static fallback text */ }
  }
  loadFooterCredit();

  function toolCard(name, ok, detail, installEngineName) {
    const installBtn = !ok && installEngineName ? '<div><button class="btn" data-install-engine="' + installEngineName + '">Install</button></div>' : '';
    return '<div class="tool-card"><strong>' + name + '</strong><br>' +
      '<span class="' + (ok ? 'status-ok' : 'status-bad') + '">' + (ok ? 'OK' : 'NOT READY') + '</span> — ' + escapeHtml(String(detail || '')) +
      installBtn + '</div>';
  }

  // ─── Init ───────────────────────────────────────────────────────────
  showView('upload');
})();
