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

  // FIX BUG NYATA ("Unexpected token '<', <!DOCTYPE ... is not valid JSON" muncul tepat
  // setelah logout lalu login lagi): JavaScript.html SUDAH mengasumsikan bridge ini punya
  // window.__apiBridgeResetQueue__() yang dipanggil oleh handleLogout() (lihat komentarnya
  // di sana) untuk membuang antrian request yang masih tertunda dari SESI SEBELUM logout —
  // tapi fungsi itu sebelumnya tidak pernah dibuat sama sekali di sini, jadi panggilan itu
  // diam-diam tidak melakukan apa-apa (typeof check di JavaScript.html gagal, aman tidak
  // crash, TAPI antrian lama tidak pernah dibersihkan). Akibatnya: request yang terkirim
  // SEBELUM logout (mis. dari preloadAllPages_/polling) tetap pulang setelah login baru
  // selesai — kadang dengan token/kondisi yang sudah tidak sinkron lagi di sisi GAS, yang
  // bisa membuat GAS membalas halaman redirect/login Google (HTML, diawali "<!DOCTYPE")
  // padahal bridge mengharapkan JSON murni -> res.json() gagal parse -> error mentah itu
  // muncul sebagai toast ke user, walau app sebenarnya baik-baik saja.
  // FIX: setiap job direkam SESSION_GEN_ saat ia dibuat (bukan saat dieksekusi). Kalau
  // window.__apiBridgeResetQueue__() dipanggil (dari handleLogout()), generasi dinaikkan
  // dan seluruh isi antrian yang BELUM sempat jalan langsung dibuang total (request-nya
  // malah tidak pernah dikirim ke server sama sekali, bukan cuma diabaikan hasilnya — lebih
  // hemat & lebih bersih). Untuk job yang SUDAH terkirim (sedang menunggu response saat
  // reset terjadi), request itu dibiarkan selesai apa adanya di background (fetch tidak
  // bisa "dibatalkan" separuh jalan dengan aman), TAPI onSuccess/onFailure-nya di-skip kalau
  // generasi job itu sudah tidak sama dengan generasi sekarang — jadi callback lama itu
  // tidak akan pernah menyentuh state APAPUN di JavaScript.html yang mungkin sudah berubah
  // (STATE.user sudah beda, dst), persis prinsip SESSION_GEN_ yang sudah dipakai di sisi
  // JavaScript.html sendiri untuk kasus serupa (lihat komentarnya).
  var bridgeGen_ = 0;
  window.__apiBridgeResetQueue__ = function () {
    bridgeGen_++;
    hiQueue.length = 0;
    loQueue.length = 0;
    // hiActive/loActive SENGAJA tidak direset ke 0 di sini — itu menghitung request yang
    // SEDANG di-fetch (sudah terkirim ke server), bukan yang masih di antrian. Membiarkan
    // pump_() jalan otomatis begitu masing-masing selesai (lewat callback done() di
    // runJob_) tetap aman: generasi job-job aktif itu sudah "usang" duluan, jadi hasilnya
    // otomatis diabaikan lewat pengecekan job.gen !== bridgeGen_ di bawah.
  };

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
      .then(function (res) {
        // Lihat catatan lengkap FIX di dekat deklarasi bridgeGen_/__apiBridgeResetQueue__
        // di atas: kalau tidak OK (mis. redirect ke halaman login Google karena sesi lama
        // sudah tidak valid saat request ini akhirnya pulang), response-nya HTML — bukan
        // JSON — dan res.json() akan gagal parse dengan pesan mentah yang membingungkan
        // user ("Unexpected token '<'..."). Deteksi lewat res.ok/content-type SEBELUM
        // mencoba parse, supaya kasus ini dilempar sebagai error yang jelas maksudnya,
        // bukan pesan parsing JSON yang teknis.
        var ct = res.headers.get('content-type') || '';
        if (!res.ok || ct.indexOf('json') === -1) {
          throw new Error('Sesi kedaluwarsa atau server tidak merespons dengan benar. Coba login ulang.');
        }
        return res.json();
      })
      .then(function (payload) {
        done();
        // Job ini mulai dieksekusi SEBELUM __apiBridgeResetQueue__() dipanggil (kalau
        // sesudahnya, job ini malah tidak akan pernah ada di sini — sudah dibuang total
        // dari antrian, lihat catatan di reset). Kalau generasinya sudah usang, response
        // yang baru pulang ini kemungkinan besar dari SESI LAMA (sebelum logout) — jangan
        // sentuh callback onSuccess/onFailure APAPUN, supaya tidak menyentuh STATE.user dkk
        // yang sudah berubah sejak job ini dijadwalkan (prinsip sama dengan SESSION_GEN_ di
        // JavaScript.html).
        if (job.gen !== bridgeGen_) return;
        if (payload && payload.ok) {
          job.onSuccess(payload.result);
        } else {
          job.onFailure(new Error((payload && payload.error) || 'Unknown error dari server.'));
        }
      })
      .catch(function (err) {
        done();
        if (job.gen !== bridgeGen_) return;
        job.onFailure(err);
      });
  }

  function enqueue_(job) {
    job.gen = bridgeGen_; // rekam generasi SAAT job dibuat — lihat catatan lengkap di atas
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
