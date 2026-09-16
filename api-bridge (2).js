/*************************************************************
 * AGRINESIA B2B — api-bridge.js
 * ---------------------------------------------------------
 * Dipakai HANYA saat frontend (index.html/Stylesheet/JavaScript)
 * di-hosting di luar domain script.google.com, mis. GitHub Pages.
 * Tugasnya: bikin `google.script.run.namaFungsi(...)` yang dipakai
 * di seluruh JavaScript.html TETAP BERFUNGSI PERSIS SAMA — tanpa
 * perlu ubah satu baris pun kode SPA — dengan cara meniru API
 * google.script.run (withSuccessHandler/withFailureHandler lalu
 * nama fungsi) dan menerjemahkannya jadi POST fetch() ke endpoint
 * /exec Apps Script (lihat handleRpc_/doPost di Code.gs).
 *
 * WAJIB dimuat SEBELUM JavaScript.html di halaman ini, supaya
 * `google.script.run` sudah ada saat kode SPA jalan.
 *
 * Kecepatan: request GAS /exec itu sendiri sudah maksimal seperti
 * saat native (sama-sama HTTP call ke backend yang sama) — yang
 * bikin lambat kalau naif adalah nembak PULUHAN request bersamaan
 * begitu user login/pindah halaman (tiap render() bisa berisi 1-3
 * call). Makanya bridge ini pakai antrian dengan concurrency-limit
 * terpisah utk request prioritas tinggi (interaksi user langsung)
 * vs prioritas rendah (preload/polling background) — persis pola
 * yang disebut di komentar JavaScript.html sebelum bridge lama
 * dihapus.
 *************************************************************/
(function () {
  'use strict';

  // =========== KONFIGURASI — GANTI SESUAI DEPLOYMENT GAS ANDA ===========
  // Ambil dari: Apps Script Editor -> Deploy -> Manage deployments -> Web app URL
  // Formatnya: https://script.google.com/macros/s/XXXXXXXXXXXXXXXXXXXX/exec
  var GAS_EXEC_URL = window.GAS_EXEC_URL || 'PASTE_URL_EXEC_GAS_DI_SINI';
  // ========================================================================

  if (!GAS_EXEC_URL || GAS_EXEC_URL.indexOf('PASTE_URL_EXEC_GAS_DI_SINI') !== -1) {
    console.error(
      '[api-bridge] GAS_EXEC_URL belum diisi. Set window.GAS_EXEC_URL di index.html ' +
      'SEBELUM tag <script src="api-bridge.js">, atau edit langsung nilainya di api-bridge.js.'
    );
  }

  // Panggilan low-priority ditandai dari JavaScript.html lewat properti ini di
  // withSuccessHandler callback function, mis: cb.__lowPriority = true; — kalau
  // kode SPA belum menandainya, semua request dianggap high-priority (aman,
  // cuma antriannya jadi kurang optimal, bukan jadi gagal).
  var MAX_CONCURRENT_HI = 4;
  var MAX_CONCURRENT_LO = 2;

  var hiQueue = [];
  var loQueue = [];
  var hiActive = 0;
  var loActive = 0;

  function pump_() {
    while (hiActive < MAX_CONCURRENT_HI && hiQueue.length) {
      hiActive++;
      var job = hiQueue.shift();
      runJob_(job, function () { hiActive--; pump_(); });
    }
    while (loActive < MAX_CONCURRENT_LO && loQueue.length) {
      loActive++;
      var job2 = loQueue.shift();
      runJob_(job2, function () { loActive--; pump_(); });
    }
  }

  function runJob_(job, done) {
    fetch(GAS_EXEC_URL, {
      method: 'POST',
      // text/plain menghindari CORS preflight OPTIONS (GAS /exec tidak
      // melayani preflight dengan baik) — Code.gs tetap JSON.parse() body-nya.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: job.fnName, args: job.args })
    })
      .then(function (res) { return res.json(); })
      .then(function (payload) {
        done();
        if (payload && payload.ok) {
          job.onSuccess(payload.result);
        } else {
          job.onFailure(new Error((payload && payload.error) || 'Unknown error dari server.'));
        }
      })
      .catch(function (err) {
        done();
        job.onFailure(err);
      });
  }

  function enqueue_(job) {
    if (job.lowPriority) loQueue.push(job); else hiQueue.push(job);
    pump_();
  }

  // ---- Proxy builder: tiap .fnName(...) di rantai ini didaftarkan lewat Proxy,
  // supaya TIDAK perlu daftar manual nama semua fungsi backend (ratusan) di sini.
  function makeRunner_(onSuccess, onFailure, lowPriority) {
    return new Proxy({}, {
      get: function (_target, fnName) {
        if (fnName === 'withSuccessHandler') {
          return function (cb) { return makeRunner_(cb || function () {}, onFailure, lowPriority); };
        }
        if (fnName === 'withFailureHandler') {
          return function (cb) { return makeRunner_(onSuccess, cb || defaultFailureHandler_, lowPriority); };
        }
        if (fnName === 'withUserObject') {
          // Tidak dipakai di kode ini, tapi disediakan biar tidak crash kalau ada.
          return function () { return makeRunner_(onSuccess, onFailure, lowPriority); };
        }
        // fnName lainnya = nama fungsi backend yang sesungguhnya mau dipanggil.
        return function () {
          var args = Array.prototype.slice.call(arguments);
          enqueue_({
            fnName: String(fnName),
            args: args,
            onSuccess: onSuccess,
            onFailure: onFailure,
            lowPriority: !!lowPriority
          });
        };
      }
    });
  }

  function defaultFailureHandler_(err) {
    console.error('[api-bridge] Backend error (tanpa withFailureHandler):', err);
  }

  // google.script.run dasar (belum ada success/failure handler terpasang).
  var scriptRun = makeRunner_(function () {}, defaultFailureHandler_, false);

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = scriptRun;

  // Bonus kecil: google.script.host.close() juga dipakai di beberapa app GAS
  // (tidak wajib dipakai di kode ini, tapi disediakan biar tidak error kalau ada).
  window.google.script.host = window.google.script.host || {
    close: function () { /* no-op di luar iframe GAS */ }
  };
})();
