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
  // FIX (bagian dari perbaikan "login 2-3 device berdekatan bikin yang belakangan kena
  // error sesi palsu"): MAX_CONCURRENT_HI diturunkan 4 -> 3. Kuota eksekusi paralel GAS
  // dibagi ke SEMUA device yang memanggil /exec bersamaan (lihat catatan panjang di
  // JavaScript.html/preloadAllPages_), jadi makin kecil concurrency per-device, makin
  // kecil juga kemungkinan device itu sendirian menghabiskan kuota bersama saat beberapa
  // device kebetulan login di waktu yang sama.
  var MAX_CONCURRENT_HI = 3;
  var MAX_CONCURRENT_LO = 2;

  // FIX PERFORMA ("lemot pas beberapa device buka/login bareng"): SEBELUMNYA tiap
  // google.script.run.fn() = 1 fetch /exec sendiri-sendiri, jadi begitu satu render()
  // butuh 1-3 call (atau beberapa device login bersamaan), jumlah request /exec PARALEL
  // ke GAS meledak — padahal kuota eksekusi paralel GAS dibagi ke SEMUA pemanggil dari
  // device manapun (lihat handleRpc_ di Code.gs). FIX: job-job yang nembak nyaris
  // bersamaan digabung jadi SATU fetch berisi { batch: [{fn,args}, ...] } — GAS
  // mengeksekusi semuanya berurutan dalam SATU slot kuota, bukan N slot terpisah. Jendela
  // BATCH_WINDOW_MS kecil ini yang nunggu job lain "nyusul" sebelum benar-benar dikirim;
  // begitu ada MAX_BATCH_SIZE job menumpuk, batch langsung ditembak duluan (tidak nunggu
  // timer) supaya antrian panjang tidak malah nambah delay.
  var BATCH_WINDOW_MS = 15;
  var MAX_BATCH_SIZE = 8;

  var hiQueue = [];
  var loQueue = [];
  var hiActive = 0;
  var loActive = 0;
  var hiTimer = null;
  var loTimer = null;

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
    if (hiTimer) { clearTimeout(hiTimer); hiTimer = null; }
    if (loTimer) { clearTimeout(loTimer); loTimer = null; }
    // hiActive/loActive SENGAJA tidak direset ke 0 di sini — itu menghitung request yang
    // SEDANG di-fetch (sudah terkirim ke server), bukan yang masih di antrian. Membiarkan
    // pump_() jalan otomatis begitu masing-masing selesai (lewat callback done() di
    // runJob_) tetap aman: generasi job-job aktif itu sudah "usang" duluan, jadi hasilnya
    // otomatis diabaikan lewat pengecekan job.gen !== bridgeGen_ di bawah.
  };

  function scheduleFlush_(isLow) {
    if (isLow) {
      if (loTimer) return; // sudah ada flush terjadwal, job ini otomatis ikut kebawa
      loTimer = setTimeout(function () { loTimer = null; pump_(); }, BATCH_WINDOW_MS);
    } else {
      if (hiTimer) return;
      hiTimer = setTimeout(function () { hiTimer = null; pump_(); }, BATCH_WINDOW_MS);
    }
  }

  function pump_() {
    while (hiActive < MAX_CONCURRENT_HI && hiQueue.length) {
      hiActive++;
      var batch = hiQueue.splice(0, MAX_BATCH_SIZE);
      runBatch_(batch, function () { hiActive--; pump_(); });
    }
    while (loActive < MAX_CONCURRENT_LO && loQueue.length) {
      loActive++;
      var batch2 = loQueue.splice(0, MAX_BATCH_SIZE);
      runBatch_(batch2, function () { loActive--; pump_(); });
    }
  }

  // jobs = array job (hasil gabungan beberapa google.script.run.fn() yang nembak
  // berdekatan) — dikirim sebagai SATU request { batch: [...] }, dieksekusi berurutan
  // di server dalam SATU slot kuota GAS, lalu hasilnya di-map balik ke job masing-masing
  // lewat index array (urutan batch di request == urutan result di response, karena
  // runSingleRpc_ di Code.gs dipanggil sinkron berurutan via Array.map).
  function runBatch_(jobs, done, isRetry) {
    fetch(GAS_EXEC_URL, {
      method: 'POST',
      // text/plain menghindari CORS preflight OPTIONS (GAS /exec tidak

      // melayani preflight dengan baik) — Code.gs tetap JSON.parse() body-nya.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ batch: jobs.map(function (j) { return { fn: j.fnName, args: j.args }; }) })
    })
      .then(function (res) {
        // FIX BUG NYATA ("login 2-3 akun/device berdekatan, yang belakangan selalu kena
        // 'Sesi kedaluwarsa'" — padahal sesinya baru saja dibuat, belum expired sama sekali):
        // GAS Web App (/exec) membagi kuota EKSEKUSI PARALEL ke SEMUA pemanggil dari device
        // manapun (lihat catatan panjang soal ini di JavaScript.html, preloadAllPages_). Saat
        // kuota itu penuh sesaat (mis. 3 device baru login nyaris bersamaan, tiap device
        // langsung menembak beberapa request preload), GAS bisa membalas dengan status
        // non-200 atau (lebih sering) HALAMAN HTML GENERIK (bukan JSON) — respons SEMENTARA
        // ini SEBELUMNYA langsung divonis "Sesi kedaluwarsa" tanpa dicoba ulang dulu, padahal
        // sesi di CacheService backend masih valid & tidak tersentuh sama sekali; besar
        // kemungkinan request yang SAMA akan berhasil kalau dicoba lagi sesaat kemudian
        // setelah kuota longgar. FIX: retry otomatis (dgn jeda + sedikit acak/jitter supaya
        // beberapa device yang retry bersamaan tidak kembali bertabrakan di waktu yang persis
        // sama) sebelum benar-benar melaporkan gagal — pola sama dgn retry TypeError di bawah,
        // cuma sumber kegagalannya beda (di sini GAS SEMPAT membalas, cuma bukan JSON/tidak OK).
        var ct = res.headers.get('content-type') || '';
        if (!res.ok || ct.indexOf('json') === -1) {
          if (!isRetry) {
            var err = new Error('__RETRY_BAD_RESPONSE__');
            err.__badResponse = true;
            throw err;
          }
          // Sudah pernah dicoba ulang sekali dan tetap gagal — kemungkinan besar problem
          // sungguhan (server benar-benar down, atau memang sesinya sudah tidak valid di sisi
          // lain). Pesan diperjelas: ini BUKAN kepastian sesi habis, cuma dugaan terbaik.
          throw new Error('Gagal terhubung ke server (server sibuk atau sesi tidak valid). Coba beberapa saat lagi atau login ulang.');
        }
        return res.json();
      })
      .then(function (payload) {
        done();
        if (!payload || payload.ok !== true || !Array.isArray(payload.batch)) {
          // Balasan sukses tapi bentuknya bukan kontrak batch yang diharapkan — perlakukan
          // semua job di batch ini sebagai gagal daripada crash di .forEach bawah.
          var genericErr = new Error((payload && payload.error) || 'Balasan server tidak valid.');
          jobs.forEach(function (j) {
            if (j.gen !== bridgeGen_) return;
            j.onFailure(genericErr);
          });
          return;
        }
        // Tiap job dalam batch ini mulai dieksekusi SEBELUM __apiBridgeResetQueue__()
        // dipanggil (kalau sesudahnya, job itu malah tidak akan pernah sampai sini — sudah
        // dibuang total dari antrian, lihat catatan di reset). Kalau generasinya sudah usang,
        // response yang baru pulang ini kemungkinan besar dari SESI LAMA (sebelum logout) —
        // jangan sentuh callback onSuccess/onFailure job itu, supaya tidak menyentuh
        // STATE.user dkk yang sudah berubah sejak job dijadwalkan (prinsip sama dengan
        // SESSION_GEN_ di JavaScript.html). Job lain dalam batch yang SAMA bisa saja generasinya
        // masih valid (mis. batch dikirim tepat saat logout terjadi di tengah-tengah) — makanya
        // dicek per-job, bukan per-batch.
        jobs.forEach(function (j, i) {
          if (j.gen !== bridgeGen_) return;
          var r = payload.batch[i];
          if (r && r.ok) {
            j.onSuccess(r.result);
          } else {
            j.onFailure(new Error((r && r.error) || 'Unknown error dari server.'));
          }
        });
      })
      .catch(function (err) {
        // Retry utk respons non-JSON/non-OK dari GAS (kuota paralel penuh sesaat) — lihat
        // catatan lengkap di blok res.ok/content-type di atas. Jeda diberi jitter acak supaya
        // beberapa device yang sama-sama retry tidak kembali menembak GAS di detik yang
        // persis sama (yang justru bisa memperpanjang kepenuhan kuota, bukan meredakannya).
        if (!isRetry && err && err.__badResponse) {
          var backoff = 900 + Math.floor(Math.random() * 700); // ~0.9–1.6 detik
          setTimeout(function () { runBatch_(jobs, done, true); }, backoff);
          return;
        }
        // FIX BUG NYATA ("Failed to fetch" sesaat di HP, terutama tepat setelah PWA baru
        // dibuka/koneksi baru pulih dari idle): error jaringan MURNI (bukan balasan dari
        // GAS — GAS bahkan belum sempat dihubungi sama sekali) muncul sebagai TypeError
        // "Failed to fetch" dari fetch() itu sendiri, BUKAN dari .then() di atas (yang
        // menangani kasus GAS SUDAH membalas tapi isinya bukan JSON). Penyebab paling umum:
        // koneksi radio HP belum "bangun" sepenuhnya sesaat setelah layar/app baru aktif
        // (meski indikator sinyal sudah penuh), atau DNS lookup pertama ke domain GAS belum
        // selesai. Request KEDUA yang dicoba tak lama sesudahnya biasanya langsung berhasil
        // begitu koneksi benar-benar siap — makanya klik ulang manual oleh user "tiba-tiba
        // bisa". FIX: retry OTOMATIS sekali (tidak berulang-ulang supaya tidak menutupi
        // kegagalan asli), hanya untuk TypeError murni ini (err.message mengandung "fetch"),
        // dengan delay singkat, sebelum benar-benar melaporkan gagal ke user.
        if (!isRetry && err instanceof TypeError) {
          setTimeout(function () { runBatch_(jobs, done, true); }, 800);
          return;
        }
        done();
        jobs.forEach(function (j) {
          if (j.gen !== bridgeGen_) return;
          j.onFailure(err);
        });
      });
  }

  function enqueue_(job) {
    job.gen = bridgeGen_; // rekam generasi SAAT job dibuat — lihat catatan lengkap di atas
    if (job.lowPriority) {
      loQueue.push(job);
      // Kalau antrian sudah cukup penuh, langsung flush (batal timer) — jangan nambah
      // delay lagi buat job yang sudah menumpuk menunggu.
      if (loQueue.length >= MAX_BATCH_SIZE) {
        if (loTimer) { clearTimeout(loTimer); loTimer = null; }
        pump_();
      } else {
        scheduleFlush_(true);
      }
    } else {
      hiQueue.push(job);
      if (hiQueue.length >= MAX_BATCH_SIZE) {
        if (hiTimer) { clearTimeout(hiTimer); hiTimer = null; }
        pump_();
      } else {
        scheduleFlush_(false);
      }
    }
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
          // BUG NYATA (dropdown "Area Pendaftaran"/"Perusahaan" lama muncul): JavaScript.html/
          // index.html menandai panggilan background (mis. ping() warm-up saat boot) sebagai
          // low-priority dengan menyalakan window.__BG_LOW_PRIORITY__ tepat sebelum memanggil
          // google.script.run lalu mematikannya lagi sesudahnya (lihat _agBootInit_) — TAPI
          // `lowPriority` di sini cuma nilai closure dari makeRunner_(..., false) yang dipatok
          // false SEKALI di awal dan tidak pernah dibaca ulang dari window.__BG_LOW_PRIORITY__.
          // Akibatnya ping() SELALU dianggap high-priority, ikut masuk hiQueue dan malah
          // digabung dalam SATU batch/exec call bersama prefetch dropdown area & perusahaan
          // yang sungguhan ditunggu user (lihat runBatch_: satu batch dieksekusi berurutan di
          // SATU slot kuota GAS) — jadi kalau ping() kena cold-start lambat, dropdown ikut
          // ketahan menunggu di belakangnya. FIX: baca window.__BG_LOW_PRIORITY__ di sini,
          // persis saat job ini dibuat (sinkron dengan pemanggilnya menyalakan flag itu),
          // supaya ping() betul-betul lewat loQueue terpisah dan tidak lagi menghalangi
          // request yang sungguhan ditunggu di layar.
          enqueue_({
            fnName: String(fnName),
            args: args,
            onSuccess: onSuccess,
            onFailure: onFailure,
            lowPriority: !!lowPriority || !!window.__BG_LOW_PRIORITY__
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
