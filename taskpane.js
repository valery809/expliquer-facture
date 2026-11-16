/* Panneau "Expliquer la facture" : lit le PDF joint au mail ouvert et affiche l'analyse. */
(function () {
  'use strict';
  const F = window.FactureExplain;
  const $ = id => document.getElementById(id);
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  let pdfs = [];

  function etat(msg, erreur) {
    $('etat').textContent = msg; $('etat').className = 'etat' + (erreur ? ' erreur' : '');
    $('etat').classList.toggle('hidden', !msg);
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  Office.onReady(() => {
    if (!Office.context.requirements.isSetSupported('Mailbox', '1.8')) {
      etat('Cette version d\'Outlook est trop ancienne pour lire les pièces jointes depuis un complément.', true); return;
    }
    charger();
    // Volet épinglé : on recharge quand tu changes de mail
    if (Office.context.mailbox.addHandlerAsync) {
      Office.context.mailbox.addHandlerAsync(Office.EventType.ItemChanged, charger);
    }
  });

  function charger() {
    $('resultat').classList.add('hidden');
    const item = Office.context.mailbox.item;
    if (!item) { etat('Ouvre un mail pour l\'analyser.'); return; }
    pdfs = (item.attachments || []).filter(a =>
      a.attachmentType === Office.MailboxEnums.AttachmentType.File && /\.pdf$/i.test(a.name || '') && !a.isInline);
    if (!pdfs.length) { $('choix').classList.add('hidden'); etat('Ce mail ne contient pas de pièce jointe PDF.', true); return; }
    // Les PDF qui ressemblent à une facture passent en premier
    pdfs.sort((a, b) => score(b.name) - score(a.name));
    $('pj').innerHTML = pdfs.map((a, i) => '<option value="' + i + '">' + esc(a.name) + '</option>').join('');
    $('choix').classList.toggle('hidden', pdfs.length < 2);
    $('pj').onchange = () => analyser(pdfs[+$('pj').value]);
    analyser(pdfs[0]);
  }
  const score = n => /factur|invoice|avoir|^FA|^F\d/i.test(n) ? 2 : (/devis|cgv|condition|bon/i.test(n) ? 0 : 1);

  function contenu(att) {
    return new Promise((res, rej) => Office.context.mailbox.item.getAttachmentContentAsync(att.id, r => {
      if (r.status !== Office.AsyncResultStatus.Succeeded) return rej(new Error(r.error && r.error.message));
      if (r.value.format !== Office.MailboxEnums.AttachmentContentFormat.Base64) return rej(new Error('Format de pièce jointe inattendu'));
      res(r.value.content);
    }));
  }
  function corps() {
    return new Promise(res => Office.context.mailbox.item.body.getAsync(Office.CoercionType.Text, r => res(r.status === 'succeeded' ? r.value : '')));
  }

  async function analyser(att) {
    etat('Lecture de « ' + att.name + ' »…');
    $('resultat').classList.add('hidden');
    try {
      const [b64, body] = await Promise.all([contenu(att), corps()]);
      const bin = atob(b64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
      const lines = await F.extractLines(pdf);
      const item = Office.context.mailbox.item;
      const from = item.from || item.sender || {};
      const monDomaine = (Office.context.mailbox.userProfile.emailAddress || '').split('@')[1] || '';
      const ctx = { fileName: att.name, senderName: from.displayName, mailBody: body,
                    internal: !!monDomaine && (from.emailAddress || '').toLowerCase().endsWith('@' + monDomaine.toLowerCase()) };
      afficher(F.analyseFacture(lines, ctx), lines);
      etat('');
    } catch (e) {
      etat('Impossible de lire ce PDF : ' + e.message, true);
    }
  }

  function afficher(r, lines) {
    $('resume').textContent = F.resume(r);
    $('copier').onclick = () => {
      const t = $('resume').textContent;
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(
        () => { $('copier').textContent = 'Copié ✓'; setTimeout(() => $('copier').textContent = 'Copier le résumé', 1500); },
        () => { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); });
    };

    $('alertes').innerHTML = r.alertes.map(a => '<li>' + esc(a) + '</li>').join('');
    $('secAlertes').classList.toggle('hidden', !r.alertes.length);

    const rows = [];
    const add = (k, v, cls) => { if (v !== null && v !== undefined && v !== '') rows.push('<tr' + (cls ? ' class="' + cls + '"' : '') + '><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>'); };
    add('Émetteur', r.emetteur + (r.siret ? ' (SIRET ' + r.siret + ')' : ''));
    add(r.avoir ? 'N° d\'avoir' : 'N° de facture', r.numero);
    add('Date', r.dateFacture && F.fmtDate(r.dateFacture));
    add('Montant HT', r.ht !== null ? F.fmtEur(r.ht) : null);
    add('TVA', r.tva !== null ? F.fmtEur(r.tva) + (r.tauxTva !== null ? ' (' + r.tauxTva.toLocaleString('fr-FR') + ' %)' : '') : null);
    add('Total TTC', r.ttc !== null ? F.fmtEur(r.ttc) + (r.coherence ? '  ✓ cohérent' : '') : null, 'total');
    add('Échéance', r.echeance && (F.fmtDate(r.echeance) + (r.joursEcheance !== undefined ? (r.joursEcheance >= 0 ? ' (dans ' + r.joursEcheance + ' j)' : ' (dépassée)') : '')));
    add('Conditions', r.conditions);
    add('Paiement', r.paiement.join(', '));
    add('IBAN indiqué', r.iban);
    add('Période', r.periode && r.periode.du && r.periode.au ? 'du ' + F.fmtDate(r.periode.du) + ' au ' + F.fmtDate(r.periode.au) : null);
    add('Références citées', r.refs.join(' · '));
    $('cles').innerHTML = rows.join('');

    $('lignes').innerHTML = r.lignes.map(l => '<tr><td>' + esc(l.libelle) + '</td><td class="num">' + esc(F.fmtEur(l.montant)) + '</td></tr>').join('');
    $('secLignes').classList.toggle('hidden', !r.lignes.length);

    $('infos').innerHTML = r.infos.map(a => '<li>' + esc(a) + '</li>').join('');
    $('secInfos').classList.toggle('hidden', !r.infos.length);

    $('brut').textContent = lines.map(l => l.text).join('\n');
    $('resultat').classList.remove('hidden');
  }
})();
