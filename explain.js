/*
 * Expliquer la facture - moteur d'analyse (sans IA, tout est calculé localement).
 * 1. extractLines(pdf) : reconstruit les lignes du PDF à partir des positions du texte (pdf.js)
 * 2. analyseFacture(lines, ctx) : repère numéro, dates, montants, lignes, paiement et points d'attention
 */
(function (global) {
  'use strict';

  // ---------- Extraction des lignes --------------------------------------------------------
  async function extractLines(pdf) {
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      const items = tc.items
        .filter(it => it.str && it.str.trim())
        .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      let cur = null;
      for (const it of items) {
        if (cur && Math.abs(cur.y - it.y) <= 3) cur.items.push(it);
        else { cur = { page: p, y: it.y, items: [it] }; lines.push(cur); }
      }
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let txt = '', prevEnd = null;
      for (const it of l.items) {
        if (prevEnd !== null) { const gap = it.x - prevEnd; txt += gap > 12 ? '   ' : (gap > 1 ? ' ' : ''); }
        txt += it.str; prevEnd = it.x + it.w;
      }
      l.text = txt.replace(/\s+$/, '');
    }
    return lines;
  }

  // ---------- Outils -------------------------------------------------------------------------
  const AMT = /(?<![\d,.])-?\d{1,3}(?:[   .]\d{3})*,\d{2}(?!\d)|(?<![\d,.])-?\d{1,3}(?:,\d{3})*\.\d{2}(?!\d)|(?<![\d,.])-?\d+[.,]\d{2}(?!\d)/g;
  const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  const DATE = new RegExp('(\\d{1,2})[\\/.\\-](\\d{1,2})[\\/.\\-](\\d{4}|\\d{2})(?!\\d)|(\\d{1,2})(?:er)?\\s+(' +
    MOIS.join('|') + '|fevrier|aout|decembre)\\s+(\\d{4})', 'i');

  function toNumber(s) {
    s = s.replace(/[   ]/g, '');
    if (/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }
  function amountsIn(str) { return (str.match(AMT) || []).map(toNumber).filter(n => n !== null); }
  function lineAmounts(line) {
    const out = [];
    for (const it of line.items) for (const m of it.str.matchAll(AMT)) {
      const v = toNumber(m[0]); if (v !== null) out.push({ v, x: it.x + it.w / 2 });
    }
    return out;
  }
  function parseDate(str) {
    const m = str.match(DATE); if (!m) return null;
    let d, mo, y;
    if (m[1]) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else {
      d = +m[4]; y = +m[6];
      const nm = m[5].toLowerCase().replace('fevrier', 'février').replace('aout', 'août').replace('decembre', 'décembre');
      mo = MOIS.indexOf(nm) + 1;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
    return new Date(y, mo - 1, d);
  }
  const fmtDate = d => d ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
  const fmtEur = n => n === null || n === undefined ? '' :
    n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  const near = (a, b) => Math.abs(a - b) <= 0.05 + Math.abs(b) * 0.0005;

  // Valeur associée à un libellé : sur la même ligne (à droite), sinon dans la colonne en dessous
  // (tableau de totaux). sumColumn : additionne toute la colonne (ex : plusieurs lignes de TVA).
  function valueForLabel(lines, i, labelRe, sumColumn) {
    const line = lines[i];
    const item = line.items.find(it => labelRe.test(it.str)) || line.items[0];
    const right = lineAmounts(line).filter(a => a.x >= item.x);
    if (right.length) return right[right.length - 1].v;
    const lx = item.x + item.w / 2;
    const vals = [];
    for (let k = i + 1; k <= i + 4 && k < lines.length; k++) {
      const am = lineAmounts(lines[k]);
      if (!am.length) { if (vals.length) break; else continue; }
      const best = am.reduce((a, b) => Math.abs(b.x - lx) < Math.abs(a.x - lx) ? b : a);
      if (Math.abs(best.x - lx) >= 60) { if (vals.length) break; else continue; }
      vals.push(best.v);
      if (!sumColumn) break;
    }
    if (!vals.length) return null;
    return Math.round(vals.reduce((s, v) => s + v, 0) * 100) / 100;
  }
  // Texte situé sous un intitulé de colonne (ex : "Numéro" puis "FA018718" à la ligne suivante)
  function textBelow(lines, i, itemRe) {
    const item = lines[i].items.find(it => itemRe.test(it.str));
    if (!item || !lines[i + 1]) return null;
    const lx = item.x;
    const best = lines[i + 1].items.reduce((a, b) => Math.abs(b.x - lx) < Math.abs(a.x - lx) ? b : a);
    return Math.abs(best.x - lx) < 60 ? best.str.trim() : null;
  }
  function dateForLabel(lines, i, labelRe) {
    const after = lines[i].text.split(labelRe).slice(1).join(' ');
    return parseDate(after) || parseDate(lines[i].text) || (lines[i + 1] && parseDate(lines[i + 1].text)) || null;
  }

  // ---------- Analyse -------------------------------------------------------------------------
  const RE = {
    ttc: /net\s*[àa]\s*payer|solde\s*[àa]\s*payer|total\s*t\.?\s*t\.?\s*c|montant\s*t\.?\s*t\.?\s*c|total\s*[àa]\s*payer|reste\s*[àa]\s*payer|montant\s*[àa]\s*payer|total\s*toutes\s*taxes|total\s*due|amount\s*due/i,
    ht: /total\s*(net\s*)?h\.?\s*t\b|total\s*hors\s*tax|montant\s*(total\s*)?h\.?\s*t\b|base\s*h\.?\s*t\b|sous[\s-]*total|total\s*net\s*ht|subtotal/i,
    tva: /total\s*t\.?\s*v\.?\s*a|montant\s*(de\s*la\s*)?t\.?\s*v\.?\s*a|^\s*t\.?\s*v\.?\s*a\b(?!.*intra)|\bt\.?v\.?a\.?\s*\(?\d{1,2}(?:[.,]\d+)?\s*%|\bvat\b/i,
    num: [/(?:facture|invoice|avoir)\s*(?:n[°o.º]?|num[ée]ro|#|no\.?)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\-\/_.]{2,})/i,
          /n[°oº]\s*(?:de\s*)?(?:la\s*)?(?:facture|invoice)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9\-\/_.]{2,})/i],
    dateFact: /date\s*(?:de\s*(?:la\s*)?)?(?:facture|facturation|[ée]mission|invoice)|facture\s*du|invoice\s*date|^\s*date\s*:?/i,
    echeance: /[ée]ch[ée]ance|date\s*limite|payable\s*(?:le|avant|au plus tard)|[àa]\s*r[ée]gler\s*(?:avant|le)|[àa]\s*payer\s*avant|due\s*date|date\s*de\s*(?:paiement|r[èe]glement)|exigible|conditions?\s*de\s*r[èe]glement\s*:.*\d{1,2}\/\d{1,2}\/\d{2}/i,
    refs: /\b(bon[ \t]*de[ \t]*commande|commande|devis|contrat|BC|PO|r[ée]f[ée]rence[ \t]*client|n[°o][ \t]*client|code[ \t]*client)[ \t]*(?:n[°oº]\.?)?[ \t]*[:.\-]?[ \t]*([A-Z0-9][A-Z0-9\-\/_.]{2,})/gi,
    numCol: /^\s*(num[ée]ro|n[°oº]\s*(de\s*)?(facture|pi[èe]ce)?|facture\s*n[°oº])\s*:?\s*$/i,
    modeLigne: /mode\s*de\s*r[èe]glement|mode\s*de\s*paiement|conditions?\s*de\s*(r[èe]glement|paiement)|payable\s*par|r[èe]glement\s*par/i,
    periode: /(?:p[ée]riode\s*(?:du|de)?|du)\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})\s*(?:au|-|à)\s*(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})/i,
    iban: /\bFR\d{2}(?:[ ]?[0-9A-Z]{4}){5}[ ]?[0-9A-Z]{3}\b/,
    entete: /d[ée]signation|description|libell[ée]|article|prestation|produit|r[ée]f[ée]rence\s+d[ée]signation|qt[ée]|quantit[ée]/i,
    exclusLigne: /total|totaux|solde|t\.?v\.?a|net\s*[àa]\s*payer|acompte|capital|siret|siren|iban|bic|rcs|page\s*\d|escompte|p[ée]nalit|indemnit|r[ée]gl[ée]|reste/i
  };

  function analyseFacture(lines, ctx) {
    ctx = ctx || {};
    const text = lines.map(l => l.text).join('\n');
    const r = { scanned: false, numero: null, avoir: false, dateFacture: null, echeance: null, conditions: null,
      ht: null, tva: null, ttc: null, tauxTva: null, coherence: null, lignes: [], refs: [], periode: null,
      paiement: [], iban: null, dejaPaye: false, emetteur: null, alertes: [], infos: [] };

    if (text.replace(/\s/g, '').length < 40) {
      r.scanned = true;
      r.alertes.push('Ce PDF ne contient pas de texte lisible (document scanné / image) : impossible de l\'analyser sans OCR.');
      return r;
    }
    const firstPage = lines.filter(l => l.page === 1);

    // Avoir ?
    r.avoir = /\bavoir\b|credit\s*note|note\s*de\s*cr[ée]dit/i.test(firstPage.slice(0, 25).map(l => l.text).join(' '));

    // Numéro
    for (let i = 0; i < lines.length && !r.numero; i++) {
      for (const re of RE.num) {
        const m = lines[i].text.match(re);
        if (m && /\d/.test(m[1]) && !/^(du|de|date)$/i.test(m[1])) { r.numero = m[1].replace(/[.\-]$/, ''); break; }
      }
      if (!r.numero && lines[i].items.some(it => RE.numCol.test(it.str))) {
        const t = textBelow(lines, i, RE.numCol); if (t && /\d/.test(t) && !parseDate(t)) r.numero = t.split(/\s+/)[0];
      }
    }
    if (!r.numero) {
      for (const l of firstPage.slice(0, 15)) {
        const m = l.text.match(/^\s*r[ée]f[ée]rence\s*:\s*([A-Z0-9][A-Z0-9\-\/_.]{3,})/i);
        if (m && /\d/.test(m[1])) { r.numero = m[1]; break; }
      }
    }
    if (!r.numero && ctx.fileName) { const m = ctx.fileName.match(/([A-Z]{1,4}[\-_]?\d{4,}|\d{6,})/i); if (m) r.numero = m[1] + ' (d\'après le nom du fichier)'; }

    // Dates
    const candEch = [];
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].text;
      if (RE.echeance.test(t) && t.length < 140) { const d = dateForLabel(lines, i, RE.echeance); if (d) candEch.push(d); }
      if (!r.dateFacture && RE.dateFact.test(t) && !RE.echeance.test(t)) r.dateFacture = dateForLabel(lines, i, RE.dateFact);
    }
    if (!r.dateFacture) { for (const l of firstPage.slice(0, 30)) { const d = parseDate(l.text); if (d) { r.dateFacture = d; break; } } }
    r.echeance = candEch.find(d => !r.dateFacture || d >= r.dateFacture) || null;
    const cond = text.match(/(\d{1,3})\s*jours?(\s*fin\s*de\s*mois)?(?:\s*(?:date\s*de\s*)?(?:facture|r[ée]ception|net))?/i);
    if (/[àa]\s*r[ée]ception|comptant/i.test(text)) r.conditions = 'à réception';
    else if (cond && /paiement|r[èe]glement|conditions|payable|[ée]ch[ée]ance/i.test(text)) r.conditions = cond[0].trim();
    if (!r.echeance && r.dateFacture && cond && r.conditions === cond[0].trim()) {
      const d = new Date(r.dateFacture); d.setDate(d.getDate() + (+cond[1]));
      if (cond[2]) d.setMonth(d.getMonth() + 1, 0);
      r.echeance = d; r.infos.push('Échéance calculée à partir des conditions de paiement (' + r.conditions + ').');
    }
    if (r.echeance && r.dateFacture && r.echeance < r.dateFacture) r.echeance = null;

    // Montants : on collecte les candidats puis on cherche la combinaison HT + TVA = TTC
    const cand = { ht: [], tva: [], ttc: [] };
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].text;
      for (const k of ['ttc', 'ht', 'tva']) {
        if (!RE[k].test(t)) continue;
        if (k === 'ht' && RE.ttc.test(t) && !/h\.?\s*t/i.test(t.replace(RE.ttc, ''))) continue;
        if (k === 'tva' && /intra|n[°o]\s*tva|tva\s*:\s*FR|FR\s?\d{2}\s?\d{3}/i.test(t)) continue;
        const v = valueForLabel(lines, i, RE[k], k === 'tva');
        if (v !== null && v !== 0) cand[k].push({ v, i });
      }
    }
    const last = a => a.length ? a[a.length - 1].v : null;
    const sumTvaLines = cand.tva.length > 1 ? cand.tva.reduce((s, c) => s + c.v, 0) : null;
    let found = false;
    outer:
    for (const t of [...cand.ttc].reverse()) for (const h of [...cand.ht].reverse()) {
      for (const v of [...cand.tva].reverse().map(c => c.v).concat(sumTvaLines !== null ? [sumTvaLines] : [])) {
        if (near(h.v + v, t.v)) { r.ttc = t.v; r.ht = h.v; r.tva = v; found = true; break outer; }
      }
      if (near(h.v, t.v) && !cand.tva.length) { r.ttc = t.v; r.ht = h.v; r.tva = 0; found = true; break outer; }
    }
    if (!found) {
      r.ttc = last(cand.ttc); r.ht = last(cand.ht); r.tva = last(cand.tva);
      if (r.ht === null && r.ttc !== null && r.tva !== null) r.ht = Math.round((r.ttc - r.tva) * 100) / 100;
      if (r.tva === null && r.ttc !== null && r.ht !== null) r.tva = Math.round((r.ttc - r.ht) * 100) / 100;
      if (r.ttc === null && r.ht !== null && r.tva !== null) r.ttc = Math.round((r.ht + r.tva) * 100) / 100;
      if (r.ht !== null && r.tva !== null && r.ttc !== null) r.coherence = near(r.ht + r.tva, r.ttc);
    } else r.coherence = true;
    if (r.ht && r.tva !== null) {
      const taux = r.tva / r.ht * 100;
      const std = [20, 10, 5.5, 2.1, 0].find(s => Math.abs(taux - s) < 0.15);
      r.tauxTva = std !== undefined ? std : Math.round(taux * 10) / 10;
      if (std === undefined && cand.tva.length < 2) r.alertes.push('Taux de TVA inhabituel (' + r.tauxTva.toLocaleString('fr-FR') + ' %) : plusieurs taux sur la facture ou montant à vérifier.');
    }
    if (r.coherence === false) r.alertes.push('Les totaux ne collent pas : ' + fmtEur(r.ht) + ' HT + ' + fmtEur(r.tva) + ' TVA ≠ ' + fmtEur(r.ttc) + ' TTC (à vérifier, ou mauvaise lecture du PDF).');
    if (r.ttc === null && r.ht === null) r.alertes.push('Aucun total n\'a pu être identifié automatiquement : vérifie les montants dans le PDF.');
    if (/auto[\s-]?liquidation|art(icle)?\.?\s*283|exon[ée]r|tva\s*non\s*applicable|293\s*B/i.test(text)) r.infos.push('Facture sans TVA ou en autoliquidation (mention légale présente sur la facture).');

    // Lignes facturées : entre l'en-tête du tableau et le premier total
    // Premier total = premier libellé de total qui n'est pas un simple intitulé de colonne du tableau des lignes
    const firstTotal = lines.findIndex(l => (RE.ttc.test(l.text) || RE.ht.test(l.text) || /^\s*totaux|^\s*code\s+base|^\s*base\s+taux/i.test(l.text)) &&
      (lineAmounts(l).length > 0 || !RE.entete.test(l.text)));
    let start = lines.findIndex(l => RE.entete.test(l.text) && (l.text.match(RE.entete) || []).length >= 1 && lines.indexOf(l) < (firstTotal < 0 ? lines.length : firstTotal));
    const end = firstTotal < 0 ? lines.length : firstTotal;
    for (let i = start + 1; i < end; i++) {
      const l = lines[i];
      if (RE.exclusLigne.test(l.text)) continue;
      const am = lineAmounts(l); if (!am.length) continue;
      const AMT1 = new RegExp(AMT.source);
      const desc = l.items.filter(it => !AMT1.test(it.str) && /[a-zA-Zàéèêç]{3}/.test(it.str)).map(it => it.str.trim()).join(' ');
      if (!desc || parseDate(l.text) && desc.length < 25) continue;
      r.lignes.push({ libelle: desc.replace(/\s+/g, ' ').slice(0, 140), montant: am[am.length - 1].v, qte: am.length >= 3 ? am[0].v : null });
    }
    if (r.lignes.length > 25) { r.infos.push(r.lignes.length + ' lignes détectées : seules les 25 premières sont affichées.'); r.lignes = r.lignes.slice(0, 25); }

    // Références citées, période
    const seen = new Set();
    for (const m of text.matchAll(RE.refs)) {
      const lab = m[1].replace(/\s+/g, ' ').toLowerCase(), val = m[2].replace(/[.\-]$/, '');
      if (!/\d/.test(val) || val === r.numero) continue;
      const k = lab + val; if (seen.has(k)) continue; seen.add(k);
      r.refs.push(m[1].replace(/\s+/g, ' ') + ' ' + val);
      if (r.refs.length >= 6) break;
    }
    const pm = text.match(RE.periode); if (pm) r.periode = { du: parseDate(pm[1]), au: parseDate(pm[2]) };

    // Paiement
    const modes = [['prélèvement', /pr[ée]l[èe]vement/i], ['virement', /virement|\bIBAN\b/i], ['chèque', /ch[èe]que/i],
                   ['carte bancaire', /carte\s*bancaire|\bCB\b|carte\s*de\s*cr[ée]dit/i], ['LCR / traite', /\bLCR\b|traite/i]];
    // Le mode indiqué sur la ligne "Mode / Conditions de règlement" passe avant les mentions génériques
    const ligneMode = lines.map(l => l.text).filter(t => RE.modeLigne.test(t)).join(' ');
    const prio = modes.map(m => [m[0], ligneMode.search(m[1])]).filter(m => m[1] >= 0).sort((a, b) => a[1] - b[1]).map(m => m[0]);
    r.paiement = prio.concat(modes.filter(m => m[1].test(text) && !prio.includes(m[0])).map(m => m[0]));
    const ib = text.replace(/ /g, ' ').match(RE.iban);
    if (ib) { const s = ib[0].replace(/ /g, ''); r.iban = s.slice(0, 4) + ' •••• •••• ' + s.slice(-4); }
    r.dejaPaye = /acquitt[ée]e|d[ée]j[àa]\s*(r[ée]gl[ée]e|pay[ée]e)|pay[ée]e\s*le|r[ée]gl[ée]e\s*le|paid|montant\s*r[ée]gl[ée]/i.test(text);

    // Émetteur
    // 1. Mentions légales ("UTH - SAS au capital…", "STOIK CERT, AU CAPITAL DE…"), 2. expéditeur du mail
    let socPdf = null;
    for (const l of lines) {
      const m = l.text.match(/^\s*([A-Za-z0-9&'’. ]{2,40}?)\s*[,\-–]\s*(?:(?:SAS|SASU|SARL|SA|EURL|SNC|SCI)\b\s*,?\s*)?au\s+capital/i);
      if (m && !/lebon/i.test(m[1])) { socPdf = m[1].trim(); break; }
    }
    if (!socPdf) {
      const top = firstPage.slice(0, 15).map(l => l.text.trim());
      const soc = top.find(t => /\b(SAS|SARL|SASU|EURL|SNC)\b/.test(t) && t.length < 80 && !/lebon|capital/i.test(t));
      if (soc) socPdf = soc.split(/\s{3,}/)[0];
    }
    r.emetteur = socPdf || (!ctx.internal && ctx.senderName) || 'non identifié';
    if (/^\s*(relev[ée]|rappel|relance|[ée]tat\s*de\s*compte)/im.test(firstPage.slice(0, 20).map(l => l.text).join('\n')) || /rappel|relance|relev/i.test(ctx.fileName || ''))
    { r.releve = true; r.infos.push('Ce document ressemble à un relevé ou un rappel de compte, pas à une facture : il récapitule plusieurs factures.'); }
    const siret = text.match(/SIRE[TN][\s:n°]*((?:\d[  ]?){9}(?:(?:\d[  ]?){5})?)/i);
    if (siret) r.siret = siret[1].replace(/[  ]/g, '');

    // Points d'attention
    const today = ctx.today ? new Date(ctx.today) : new Date(); today.setHours(0, 0, 0, 0);
    if (r.echeance && !r.dejaPaye && !r.avoir) {
      const j = Math.round((r.echeance - today) / 86400000);
      r.joursEcheance = j;
      if (j < 0) r.alertes.push('Échéance dépassée depuis ' + (-j) + ' jour' + (j < -1 ? 's' : '') + ' (' + fmtDate(r.echeance) + ').');
      else if (j <= 7) r.alertes.push('Échéance proche : dans ' + j + ' jour' + (j > 1 ? 's' : '') + ' (' + fmtDate(r.echeance) + ').');
    }
    if (ctx.mailBody && /changement\s*(de|d'|des)\s*(rib|coordonn[ée]es\s*bancaires|iban)|nouveau\s*(rib|iban)|nouvelles?\s*coordonn[ée]es\s*bancaires/i.test(ctx.mailBody))
      r.alertes.push('⚠ Le mail annonce un changement de coordonnées bancaires : vérifie-le par téléphone auprès d\'un contact connu avant tout paiement (fraude au RIB fréquente).');
    if (r.avoir) r.infos.push('C\'est un avoir : il vient en déduction d\'une facture, il n\'y a rien à payer.');
    if (r.dejaPaye) r.infos.push('La facture indique qu\'elle est déjà réglée (acquittée) : rien à payer.');
    if (r.paiement[0] === 'prélèvement' && !r.dejaPaye) r.infos.push('Paiement par prélèvement automatique : aucune action de paiement à faire.');
    return r;
  }

  // ---------- Explication en français ------------------------------------------------------
  function resume(r) {
    if (r.scanned) return 'Ce PDF est une image scannée : son contenu ne peut pas être lu automatiquement.';
    const doc = r.releve ? 'Relevé de compte' : (r.avoir ? 'Avoir' : 'Facture');
    let s = doc + (r.numero && !r.releve ? ' n° ' + r.numero : '') + (r.emetteur ? ' de ' + r.emetteur : '') +
            (r.dateFacture ? (doc === 'Facture' ? ', émise le ' : ', émis le ') + fmtDate(r.dateFacture) : '') + '.';
    const Elle = doc === 'Facture' ? 'Elle' : 'Il';
    if (r.ttc !== null || r.ht !== null) {
      s += ' Montant ' + (r.avoir ? 'crédité' : 'total') + ' : ' + (r.ttc !== null ? fmtEur(r.ttc) + ' TTC' : fmtEur(r.ht) + ' HT');
      if (r.ht !== null && r.ttc !== null && r.tva) s += ', soit ' + fmtEur(r.ht) + ' HT + ' + fmtEur(r.tva) + ' de TVA' + (r.tauxTva ? ' (' + r.tauxTva.toLocaleString('fr-FR') + ' %)' : '');
      else if (r.ht !== null && r.ttc !== null && r.tva === 0) s += ', sans TVA';
      s += '.';
    }
    if (r.lignes.length === 1) s += ' ' + Elle + ' porte sur : ' + r.lignes[0].libelle + '.';
    else if (r.lignes.length > 1) s += ' ' + Elle + ' comporte ' + r.lignes.length + ' lignes, la plus importante étant « ' +
      r.lignes.reduce((a, b) => Math.abs(b.montant) > Math.abs(a.montant) ? b : a).libelle + ' ».';
    if (r.periode && r.periode.du && r.periode.au) s += ' Période facturée : du ' + fmtDate(r.periode.du) + ' au ' + fmtDate(r.periode.au) + '.';
    if (!r.avoir && !r.dejaPaye) {
      if (r.echeance) s += ' À payer avant le ' + fmtDate(r.echeance) + (r.paiement.length ? ' par ' + r.paiement[0] : '') + '.';
      else if (r.conditions) s += ' Conditions de paiement : ' + r.conditions + (r.paiement.length ? ', par ' + r.paiement[0] : '') + '.';
      else if (r.paiement.length) s += ' Paiement par ' + r.paiement[0] + '.';
    }
    return s;
  }

  global.FactureExplain = { extractLines, analyseFacture, resume, fmtEur, fmtDate, _parseDate: parseDate, _amounts: amountsIn };
})(typeof window !== 'undefined' ? window : globalThis);
