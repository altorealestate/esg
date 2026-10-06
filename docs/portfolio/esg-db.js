/* ESG Portfolio Monitor — lokálna dátová vrstva (dočasná náhrada Azure SQL).
   Zdroj pravdy: esg-db.json (lokálny súbor). Živá DB počas behu: localStorage
   (zdieľaná medzi Zberovým portálom a ESG Monitorom v tom istom prehliadači).
   Poradie načítania: localStorage -> esg-db.json -> prázdno.
   Zápis (schválenie v zberovom portáli) ide do localStorage a hneď sa prejaví
   v Monitore. Trvalý súbor na disku sa aktualizuje cez Export JSON. */
(function () {
  var KEY = 'esg_db_v1';

  var EsgDB = {
    _db: null,
    _ready: false,
    _cbs: [],

    // Načíta seed zo súboru (synchrónne, aby boli dáta pred prvým vykreslením).
    loadSeed() {
      // Standalone build: seed je vložený priamo v dokumente.
      try {
        var inline = document.getElementById('esg-seed-json');
        if (inline && inline.textContent.trim()) return JSON.parse(inline.textContent);
      } catch (e) { console.warn('[EsgDB] vložený seed sa nepodarilo načítať:', e.message); }
      try {
        var x = new XMLHttpRequest();
        // ?v= obchádza cache prehliadača/CDN — po nahratí nového esg-db.json
        // na server vidia používatelia aktuálne dáta ihneď po refreshi.
        x.open('GET', 'esg-db.json?v=' + Date.now(), false);
        x.send();
        if (x.status >= 200 && x.status < 300) return JSON.parse(x.responseText);
      } catch (e) { console.warn('[EsgDB] esg-db.json sa nepodarilo načítať:', e.message); }
      return null;
    },

    // Prenesie z živej DB do nového seedu všetky dáta otvorených (editovateľných)
    // rokov — t.j. používateľom zadané hodnoty sa migráciou nestratia.
    migrate(seed, live) {
      var openFrom = (seed.meta && seed.meta.openYearFrom) || 2026;
      function walk(s, l) {
        if (!s || !l || typeof s !== 'object' || typeof l !== 'object') return;
        Object.keys(l).forEach(function (k) {
          if (/^20\d\d$/.test(k) && Number(k) >= openFrom) { s[k] = l[k]; return; }
          if (l[k] && typeof l[k] === 'object' && !Array.isArray(l[k])) {
            if (!s[k] || typeof s[k] !== 'object') s[k] = Array.isArray(l[k]) ? [] : {};
            walk(s[k], l[k]);
          }
        });
      }
      walk(seed, live);
      return seed;
    },

    boot() {
      var db = null, live = null;
      // 1) živá DB z localStorage (zápisy zo zberového portálu)
      try { var ls = localStorage.getItem(KEY); if (ls) live = JSON.parse(ls); } catch (e) {}
      var seed = this.loadSeed();
      var sv = (seed && seed.meta && seed.meta.seedVersion) || 0;
      var lv = (live && live.meta && live.meta.seedVersion) || 0;
      if (live && seed && sv > lv) {
        // novší seed na disku — prepíše historické dáta, zadané otvorené roky ostávajú
        db = this.migrate(seed, live);
        db.meta = db.meta || {}; db.meta.seedVersion = sv;
        try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) {}
        console.info('[EsgDB] migrácia na seed v' + sv + ' (z v' + lv + ')');
      } else {
        db = live || seed;
      }
      if (!db) { console.error('[EsgDB] žiadne dáta — DB je prázdna.'); db = { buildings: [] }; }
      this._db = db;
      this.applyGlobals(db);
      this._ready = true;
      var cbs = this._cbs; this._cbs = [];
      cbs.forEach(function (f) { try { f(); } catch (e) {} });
      return db;
    },

    ready(cb) { if (this._ready) cb(); else this._cbs.push(cb); },
    get() { return this._db; },
    buildings() { return (this._db && this._db.buildings) || []; },

    // Znovu načíta živú DB z localStorage (napr. po zápise v inej záložke).
    reloadFromStorage() {
      try { var ls = localStorage.getItem(KEY); if (ls) { this._db = JSON.parse(ls); this.applyGlobals(this._db); return true; } } catch (e) {}
      return false;
    },

    // Publikuje aktuálnu DB do window globálov, ktoré Monitor prepočítava pred zobrazením.
    applyGlobals(db) {
      var em = db.energyMonthly || { series: {}, areas: {}, names: {} };
      window.__ENERGY = Object.assign({}, em, { degreeDays: db.meteo || { region: '', hdd: {}, cdd: {} } });
      window.__ENERGY_ANNUAL = db.energyAnnual || { carriers: [], areas: {}, data: {} };
      window.__EMISSIONS = db.emissions || { years: [], factorMeta: [], factors: {}, groups: [], names: {}, shortNames: {}, consumption: {} };
      window.__CRREM = db.crrem || null;
      window.__WASTE = db.waste || { years: [], routes: [], buildings: [], data: {} };
      window.__WATER = db.water || { unit: 'm³', years: [], names: {}, shortNames: {}, areas: {}, series: {} };
      window.__BUILDINGS = db.buildings || [];
      window.__DB = db;
    },

    // Uloží živú DB do localStorage a znovu publikuje globály + upozorní ostatné pohľady.
    save() {
      this._db.meta = this._db.meta || {};
      this._db.meta.updatedAt = new Date().toISOString();
      try { localStorage.setItem(KEY, JSON.stringify(this._db)); } catch (e) { console.error('[EsgDB] uloženie zlyhalo:', e.message); }
      this.applyGlobals(this._db);
      try { document.dispatchEvent(new CustomEvent('esg-db-changed', { detail: { at: Date.now() } })); } catch (e) {}
    },

    /* Zápis schválených mesačných dát zo zberového portálu.
       rec = { year:'2026', month:0..11, buildingId, carriers:{el,gas,heat,cool}, meteo:{hdd,cdd} }
       Zapíše mesačnú spotrebu + dennostupne a prepočíta ročný súčet danej budovy/roka. */
    commitMonthly(rec) {
      var db = this._db, bid = rec.buildingId, y = String(rec.year), mi = rec.month | 0;
      var em = db.energyMonthly = db.energyMonthly || { series: {}, areas: {}, names: {} };
      var s = em.series[bid] = em.series[bid] || {};
      var carriers = ['el', 'gas', 'heat', 'cool'];
      var yd = s[y] = s[y] || { el: Array(12).fill(null), gas: Array(12).fill(null), heat: Array(12).fill(null), cool: Array(12).fill(null) };
      carriers.forEach(function (c) {
        if (!Array.isArray(yd[c])) yd[c] = Array(12).fill(null);
        if (rec.carriers && rec.carriers[c] != null) yd[c][mi] = rec.carriers[c];
      });
      // voda (m³) — mesačný odpočet vodomeru
      if (rec.water != null) {
        var wd = db.water = db.water || { unit: 'm³', years: [], names: {}, shortNames: {}, areas: {}, series: {} };
        var ws = wd.series[bid] = wd.series[bid] || {};
        if (!Array.isArray(ws[y])) ws[y] = Array(12).fill(null);
        ws[y][mi] = rec.water;
        if (wd.years.indexOf(y) === -1) { wd.years.push(y); wd.years.sort().reverse(); }
      }
      // meteo (dennostupne)
      if (rec.meteo) {
        var md = db.meteo = db.meteo || { region: '', hdd: {}, cdd: {} };
        ['hdd', 'cdd'].forEach(function (k) {
          if (rec.meteo[k] == null) return;
          md[k] = md[k] || {}; if (!Array.isArray(md[k][y])) md[k][y] = Array(12).fill(null);
          md[k][y][mi] = rec.meteo[k];
        });
      }
      // ročný súčet z dostupných mesiacov (autoritatívny annual pre daný rok)
      var ea = db.energyAnnual = db.energyAnnual || { carriers: carriers, areas: {}, data: {} };
      ea.data[bid] = ea.data[bid] || {};
      var sums = {}; carriers.forEach(function (c) {
        var arr = yd[c] || []; var has = false, sum = 0;
        for (var i = 0; i < 12; i++) { var v = arr[i]; if (typeof v === 'number') { sum += v; has = true; } }
        sums[c] = has ? sum : (ea.data[bid][y] ? ea.data[bid][y][c] : 0);
      });
      ea.data[bid][y] = sums;
      try { this.deriveEmissionsConsumption(bid, y); } catch (e) { console.error('[EsgDB] derivácia emisií zlyhala pre', bid, y, e); }
      this.save();
    },

    // Odvodí Scope1/2 vstupy pre emisie z ročných spotrieb nosičov (po zápise mesačných dát).
    // Elektrina: rozdelenie na zelenú/nezelenú podľa posledného dostupného roka pre danú budovu
    // (zmluvný podiel OZE sa medzi rokmi nemení výrazne) — najlepší dostupný odhad bez priameho merania podielu.
    deriveEmissionsConsumption(bid, y) {
      var db = this._db, em = db.emissions = db.emissions || { years: [], factorMeta: [], factors: {}, groups: [], names: {}, shortNames: {}, consumption: {} };
      var ea = db.energyAnnual, sums = ea.data[bid] && ea.data[bid][y]; if (!sums) return;
      var cons = em.consumption[bid] = em.consumption[bid] || {};
      var elTotal = sums.el || 0, ratio = 0;
      var histYears = Object.keys(cons).filter(function (k) { return k !== y; }).sort().reverse();
      for (var i = 0; i < histYears.length; i++) {
        var h = cons[histYears[i]], het = (h.elGreen || 0) + (h.elNon || 0);
        if (het > 0) { ratio = (h.elGreen || 0) / het; break; }
      }
      cons[y] = {
        elGreen: Math.round(elTotal * ratio), elNon: Math.round(elTotal * (1 - ratio)),
        heat: sums.heat || 0, cool: sums.cool || 0, gas: sums.gas || 0,
        diesel: (cons[y] && cons[y].diesel) || 0, refrT: (cons[y] && cons[y].refrT) || 0,
      };
      if (em.years.indexOf(y) === -1) { em.years.push(y); em.years.sort().reverse(); }
    },

    // Stiahne aktuálnu živú DB ako esg-db.json (na aktualizáciu trvalého súboru).
    export() {
      var blob = new Blob([JSON.stringify(this._db, null, 1)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a'); a.href = url; a.download = 'esg-db.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    },

    // Nahrá JSON súbor ako novú DB (File objekt).
    async importFile(file) {
      var txt = await file.text();
      this._db = JSON.parse(txt);
      this.save();
    },

    // Zahodí lokálne zmeny a znovu načíta zo súboru esg-db.json.
    reset() { try { localStorage.removeItem(KEY); } catch (e) {} location.reload(); }
  };

  window.EsgDB = EsgDB;
  EsgDB.boot();
})();
