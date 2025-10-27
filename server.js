// server.js  — AI Testigo (INDIVIDUAL only, strict FAQ, AI_* prompts, category summary, timeout)
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Airtable from 'airtable';
import OpenAI from 'openai';
import { setTimeout as delay } from 'timers/promises';

const {
  PORT = 8080,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o',
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID_INDIVIDUAL,
  SCHOOL_SLUG: DEFAULT_SLUG = 'instruktor'
} = process.env;

const promptVersion = 'v1.5.0';

if (!OPENAI_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID_INDIVIDUAL) {
  console.error('❗ Nedostaju env varijable: OPENAI_API_KEY, AIRTABLE_API_KEY ili AIRTABLE_BASE_ID_INDIVIDUAL');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const atInd = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID_INDIVIDUAL);

/* ===== Helpers ===== */
const norm = v => (Array.isArray(v) ? v[0] : v ?? '').toString();
const normSlug = v => norm(v).trim().toLowerCase();
const sanitizeForFormula = s => norm(s).replace(/"/g, '').replace(/'/g, '’');

function softNorm(s = '') {
  return norm(s)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ćčđšž\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordSet(s) {
  return new Set(softNorm(s).split(' ').filter(w => w.length >= 3));
}
function overlapScore(q, candidate) {
  const qs = wordSet(q);
  const cs = wordSet(candidate);
  let overlap = 0;
  for (const w of qs) if (cs.has(w)) overlap++;
  const jaccard = qs.size ? overlap / (qs.size + cs.size - overlap || 1) : 0;
  return { overlap, qsSize: qs.size, csSize: cs.size, jaccard };
}

function convertToEuro(value) {
  const v = norm(value).trim();
  if (!v) return '';
  if (v.includes('€')) return v;
  if (v.toLowerCase().includes('kn')) {
    const num = parseFloat(v);
    return isNaN(num) ? v : Math.round(num / 7.5345) + ' €';
  }
  const num = parseFloat(v);
  return isNaN(num) ? v : `${num} €`;
}

function calcMonthlyRate(raw, months = 12) {
  const num = parseFloat(norm(raw));
  return isNaN(num) ? '—' : Math.round(num / months) + ' €/mj';
}

function listVehicles(rows, wantedKat) {
  if (!rows?.length) return '';
  const items = rows
    .filter(r => {
      const k = norm(r['Kategorija'] || r['Namjena (kategorija)'] || r['Kategorija_ref']).toUpperCase();
      return wantedKat ? k.includes(wantedKat) : true;
    })
    .map(r => {
      const kat = norm(r['Kategorija'] || r['Kategorija_ref']);
      const model = norm(r['Naziv vozila'] || r['Model'] || r['Naziv']);
      const tip = norm(r['Tip vozila'] || r['Tip'] || r['Vrsta vozila']);
      const god = norm(r['Godina']);
      const mjenjac = norm(r['Mjenjač'] || r['Mjenjac']);
      return `• ${kat ? `[${kat}] ` : ''}${model || tip}${god ? ' (' + god + ')' : ''}${mjenjac ? ' – ' + mjenjac : ''}`;
    });
  const list = items.slice(0, 20);
  const extra = items.length > 20 ? `\n…i još ${items.length - 20} vozila.` : '';
  return list.join('\n') + extra;
}

function findLocation(rows, needle) {
  if (!rows?.length) return '';
  const row = rows.find(l => norm(l['Tip lokacije'] || l['Tip'] || l['Vrsta']).toLowerCase().includes(needle));
  if (!row) return '';
  const naziv = norm(row['Naziv ustanove / partnera'] || row['Naziv'] || 'Lokacija');
  const adresa = norm(row['Adresa'] || row['Lokacija']);
  const grad = norm(row['Mjesto'] || row['Grad']);
  const url = norm(row['Geo_URL'] || row['URL'] || row['Maps'] || row['Google Maps'] || row['Link na Google Maps']);
  return `${naziv}${adresa ? ', ' + adresa : ''}${grad ? ', ' + grad : ''}${url ? ' | Mapa: ' + url : ''}`;
}

function uvjetiText(rows) {
  if (!rows?.length) return '';
  const f = rows[0];
  const explicit = norm(f['Opis uvjeta'] || f['Opis']);
  if (explicit) return explicit;
  return [
    f['Vrste plaćanja'] ? `Vrste plaćanja: ${f['Vrste plaćanja']}` : '',
    f['Načini_plaćanja'] ? `Načini plaćanja: ${f['Načini_plaćanja']}` : '',
    f['Rate_mogućnost'] ? `Rate: ${f['Rate_mogućnost']}` : '',
    f['Avans'] ? `Avans: ${f['Avans']}` : '',
    f['Rokovi'] ? `Rokovi: ${f['Rokovi']}` : ''
  ].filter(Boolean).join(' | ');
}

/* ===== Tablice (INDIVIDUAL) ===== */
const TABLES = {
  kategorije: ['KATEGORIJE', 'KATEGORIJE AUTOŠKOLE'],
  cjenik: ['CJENIK', 'CJENIK I PRAVILA'],
  hak: ['PLAĆANJE HAK-u', 'NAKNADE ZA POLAGANJE'],
  uvjeti: ['UVJETI PLAĆANJA'],
  dodatne: ['DODATNE USLUGE'],
  instruktori: ['INSTRUKTORI'],
  vozni: ['VOZNI PARK'],
  lokacije: ['LOKACIJE', 'LOKACIJE & PARTNERI'],
  nastava: ['NASTAVA & PREDAVANJA'],
  upisi: ['UPIŠI SE ONLINE'],
  faq: ['FAQ - Odgovori na pitanja', 'FAQ', 'FAQ – Odgovori', 'FAQ Odgovori'] // globalni FAQ
};

/* ===== Data access ===== */
async function getSchoolRow(slug) {
  const safe = sanitizeForFormula(slug || DEFAULT_SLUG);
  try {
    const fields = ['{Slug (autoškola)}', '{Slug (Autoškola)}', '{slug (autoškola)}', '{Slug}'];
    for (const f of fields) {
      try {
        const recs = await atInd('AUTOŠKOLE').select({ filterByFormula: `${f} = "${safe}"`, maxRecords: 1 }).all();
        if (recs?.[0]) return recs[0].fields || {};
      } catch {}
    }
    const any = await atInd('AUTOŠKOLE').select({ maxRecords: 1 }).all();
    return any?.[0]?.fields || {};
  } catch (e) {
    console.warn('AUTOŠKOLE_WARN', e.message);
    return {};
  }
}

async function getBySlugMulti(nameVariants, slug) {
  const safeSlug = sanitizeForFormula(slug || DEFAULT_SLUG);
  for (const name of nameVariants) {
    try {
      const filtered = await atInd(name).select({ filterByFormula: `{Slug} = "${safeSlug}"`, maxRecords: 200 }).all();
      if (filtered?.length) return filtered.map(r => r.fields);
      const all = await atInd(name).select({ maxRecords: 200 }).all();
      const rows = all.map(r => r.fields).filter(f =>
        normSlug(f?.Slug || f?.['Slug (autoškola)'] || f?.['Slug (Autoškola)'] || f?.['slug (autoškola)']) === normSlug(safeSlug)
      );
      return rows.length ? rows : all.map(r => r.fields);
    } catch {}
  }
  return [];
}

/* get all rows without slug filter — ONLY for FAQ (univerzalna tablica) */
async function getAllNoSlug(nameVariants) {
  for (const name of nameVariants) {
    try {
      const all = await atInd(name).select({ maxRecords: 500 }).all();
      if (all?.length) return all.map(r => r.fields);
    } catch {}
  }
  return [];
}

/* ===== Strict FAQ pretraživanje ===== */
function answerFromFAQ_STRICT(userText, faqRows) {
  if (!faqRows?.length) return '';
  const qRaw = userText;
  const q = softNorm(userText);
  const active = faqRows.filter(r => String(r['AKTIVNO'] ?? r['Aktivno'] ?? true) !== 'false');

  const splitMulti = (s) =>
    norm(s)
      .split(/\r?\n|\|/g)
      .flatMap(x => x.split(','))
      .map(x => x.trim())
      .filter(Boolean);

  let best = { score: 0, jaccard: 0, ans: '' };

  for (const r of active) {
    const qList = [
      ...splitMulti(r['PITANJA'] || r['Pitanja'] || r['Pitanje']),
      ...splitMulti(r['Primjeri upita'] || r['Primjer upita'] || ''),
      ...splitMulti(r['Ključne riječi'] || r['Kljucne rijeci'] || '')
    ].filter(Boolean);

    for (const cand of qList) {
      const { overlap, qsSize, jaccard } = overlapScore(qRaw, cand);
      // STRIKTNA PRAVILA:
      // - ili (A) gotovo identičan tekst (substring u oba smjera)
      // - ili (B) dovoljno jak “semantic-like” signal: >=3 zajedničke riječi i Jaccard >= 0.45
      const sn = softNorm(cand);
      const almostExact = (sn && (q.includes(sn) || sn.includes(q))) && Math.min(q.length, sn.length) >= 12;

      if (almostExact || (overlap >= 3 && jaccard >= 0.45 && qsSize >= 5)) {
        const ans = norm(r['ODGOVORI'] || r['Odgovor'] || r['Odgovori']);
        if (ans && (overlap > best.score || (overlap === best.score && jaccard > best.jaccard))) {
          best = { score: overlap, jaccard, ans };
        }
      }
    }
  }
  return best.ans || '';
}

/* ===== Detektor upita o kategorijama/cijenama — da FAQ ne preuzme to ===== */
function isCategoryOrPriceQuery(s) {
  const q = softNorm(s);
  const hasKat = /\b(am|a1|a2|a|b|c|ce|d|f|g)\b/.test(q) || /kategor/i.test(q);
  const hasBizWords = /(cijena|cijene|kolik(o|a) košta|sati|satnica|hak|naknad|paket|minimalna dob|uvjeti upisa|vozni park|vozila|informacij|upis|teorij|praksa|vožnj)/i.test(q);
  return hasKat || hasBizWords;
}

/* ===== AI prompt okviri iz tablica (AI_CONTEXT/… ) ===== */
function extractAIPromptSections(allData, slug) {
  const sectionLines = [];

  const keys = Object.keys(allData).filter(k => k !== 'faq'); // FAQ ne treba AI_* okvire
  for (const key of keys) {
    const rows = allData[key] || [];
    if (!rows.length) continue;

    // uzmi prvi red koji ima barem jedno AI_* polje (i po mogućnosti isti Slug)
    const row = rows.find(r =>
      Object.keys(r).some(f => f.startsWith('AI_')) &&
      (normSlug(r.Slug || r['Slug (autoškola)'] || r['Slug (Autoškola)'] || r['slug (autoškola)']) === normSlug(slug) || !r.Slug)
    ) || rows.find(r => Object.keys(r).some(f => f.startsWith('AI_')));

    if (!row) continue;

    const ctx   = norm(row.AI_CONTEXT);
    const patt  = norm(row.AI_INTENT_PATTERNS);
    const rules = norm(row.AI_OUTPUT_RULES);
    const dis   = norm(row.AI_DISAMBIGUATION);
    const fb    = norm(row.AI_FALLBACK);

    const any = [ctx, patt, rules, dis, fb].some(Boolean);
    if (!any) continue;

    sectionLines.push(
      [
        `=== AI INSTRUKCIJE ZA TABLICU ${key.toUpperCase()} ===`,
        ctx   ? `Kontekst: ${ctx}` : '',
        patt  ? `Namjere (uzorci): ${patt}` : '',
        rules ? `Pravila izlaza: ${rules}` : '',
        dis   ? `Rasplitanje/pojašnjenje: ${dis}` : '',
        fb    ? `Fallback kad nema podatka: ${fb}` : ''
      ].filter(Boolean).join('\n')
    );
  }

  return sectionLines.join('\n\n');
}

/* ===== Sastavljanje kompletnog odgovora po kategoriji ===== */
function buildCategorySummary(katRaw, data) {
  if (!katRaw) return '';
  const kat = katRaw.toUpperCase();

  // 1) Sati (KATEGORIJE)
  let satnica = '';
  const rowK = (data.kategorije || []).find(r => norm(r['Kategorija']).toUpperCase() === kat);
  if (rowK) {
    const te = norm(rowK['Broj sati teorija'] || rowK['Broj_sati_teorija']);
    const pr = norm(rowK['Broj sati praksa']  || rowK['Broj_sati_praksa']);
    const trajanje = norm(rowK['Trajanje (tipično)']);
    const minDob = norm(rowK['Minimalna dob'] || rowK['Minimalna_dob']);
    const uvjetiUpisa = norm(rowK['Uvjeti upisa'] || rowK['Uvjeti_upisa']);
    satnica = `• Sati: Teorija ${te || '?'}h, Praksa ${pr || '?'}h${trajanje ? ` | Trajanje (tipično): ${trajanje}` : ''}`;
    if (minDob) satnica += `\n• Minimalna dob: ${minDob} godina`;
    if (uvjetiUpisa) satnica += `\n• Uvjeti upisa: ${uvjetiUpisa}`;
  }

  // 2) Cijene (CJENIK)
  const cj = (data.cjenik || [])
    .filter(c => norm(c['Kategorija']).toUpperCase() === kat)
    .map(c => {
      const varijanta = norm(c['Varijanta'] || c['Naziv'] || 'Paket');
      const cijenaRaw = norm(c['Cijena']);
      const cijena = convertToEuro(cijenaRaw) || '—';
      const mjRata = calcMonthlyRate(cijenaRaw);
      const nap = norm(c['Napomena']);
      return `  - ${varijanta}: ${cijena} (${mjRata})${nap ? ` — ${nap}` : ''}`;
    }).join('\n');
  const cjSekcija = cj ? `• Cijene:\n${cj}` : '';

  // 3) HAK naknade
  const hak = (data.hak || [])
    .filter(n => norm(n['Kategorija']).toUpperCase() === kat)
    .map(n => {
      const vrsta = norm(n['Vrsta predmeta'] || n['Naziv naknade'] || n['Naziv'] || 'Naknada');
      const iznos = convertToEuro(norm(n['Iznos']));
      return `  - ${vrsta}: ${iznos}`;
    }).join('\n');
  const hakSekcija = hak ? `• Ispitne naknade (HAK):\n${hak}` : '';

  // 4) Uvjeti plaćanja
  const uvjeti = uvjetiText(data.uvjeti);
  const uvjetiSekcija = uvjeti ? `• Uvjeti plaćanja: ${uvjeti}` : '';

  // 5) Dodatni sat
  const dodatni = (data.dodatne || [])
    .filter(d => norm(d['Naziv usluge'] || d['Naziv']).toLowerCase().includes('dodatni sat') &&
                 norm(d['Kategorija']).toUpperCase() === kat)
    .map(d => `  - Dodatni sat (${kat}): ${convertToEuro(norm(d['Iznos']))}`)
    .join('\n');
  const dodatniSekcija = dodatni ? `• Dodatni sat:\n${dodatni}` : '';

  const dijelovi = [
    `✅ KATEGORIJA ${kat}`,
    satnica,
    cjSekcija,
    hakSekcija,
    uvjetiSekcija,
    dodatniSekcija
  ].filter(Boolean);

  return dijelovi.join('\n');
}

/* ===== Heuristike za brze činjenice ===== */
function extractFacts(userText, data, school) {
  const t = norm(userText).toLowerCase();

  // “Daj sve info za kategoriju X …”
  const wanted = ['am','a1','a2','a','b','c','ce','d'].find(k =>
    t.includes(` ${k} `) || t.endsWith(` ${k}`) || t.startsWith(`${k} `) ||
    t.includes(`kategoriju ${k}`) || t.includes(`za ${k} `)
  );
  if (wanted && (t.includes('sve info') || t.includes('sve informacije') || t.includes('cijene') || t.includes('sati') || t.includes('hak'))) {
    const pack = buildCategorySummary(wanted, data);
    if (pack) return pack;
  }

  // Minimalna dob
  if (wanted && (t.includes('minimalna dob') || t.includes('koliko godina') || t.includes('godina'))) {
    const row = (data.kategorije || []).find(r => norm(r['Kategorija']).toLowerCase() === wanted);
    if (row) {
      const md = norm(row['Minimalna dob'] || row['Minimalna_dob']);
      if (md) return `MINIMALNA DOB ZA ${wanted.toUpperCase()}:\n• ${md} godina`;
    }
  }

  // Uvjeti upisa / dokumenti
  if (wanted && (t.includes('uvjeti upisa') || t.includes('dokument') || t.includes('što trebam ponijeti') || t.includes('sto moram ponijeti'))) {
    const row = (data.kategorije || []).find(r => norm(r['Kategorija']).toLowerCase() === wanted);
    if (row) {
      const uv = norm(row['Uvjeti upisa'] || row['Uvjeti_upisa']);
      if (uv) return `UVJETI UPISA ZA ${wanted.toUpperCase()}:\n• ${uv}`;
    }
  }

  if (t.includes('adresa') || t.includes('gdje ste') || t.includes('gdje se nalazite') || t.includes('lokacija')) {
    const adr = norm(school['Adresa']);
    const maps = norm(school['Google Maps'] || school['Maps'] || school['Geo_URL'] || school['Link na Google Maps']);
    const hours = norm(school['Radno_vrijeme'] || school['Radno vrijeme']);
    if (adr || maps || hours) {
      return [
        'ADRESA AUTOŠKOLE:',
        adr ? `• ${adr}` : '',
        maps ? `• Mapa: ${maps}` : '',
        hours ? `• Radno vrijeme: ${hours}` : ''
      ].filter(Boolean).join('\n');
    }
    const alt = findLocation(data.lokacije, 'auto') || findLocation(data.lokacije, 'ured');
    if (alt) return `ADRESA AUTOŠKOLE:\n• ${alt}`;
  }

  if (t.includes('poligon') || t.includes('vježbalište')) {
    const pol = findLocation(data.lokacije, 'poligon');
    if (pol) return `POLIGON:\n• ${pol}`;
  }

  if (t.includes('prva pomoć')) {
    const pp = findLocation(data.lokacije, 'prva pomoć');
    if (pp) return `PRVA POMOĆ:\n• ${pp}`;
  }

  if (t.includes('liječnič') || t.includes('lijecnick') || t.includes('medicina rada') || t.includes('pregled')) {
    const med = findLocation(data.lokacije, 'medicina rada');
    if (med) return `MEDICINA RADA – Liječnički pregled:\n• ${med}`;
  }

  if (t.includes('kartic') || t.includes('rate') || t.includes('plaćan')) {
    const u = uvjetiText(data.uvjeti);
    if (u) return `UVJETI PLAĆANJA:\n${u}`;
  }

  if (t.includes('vozni park') || t.includes('vozila')) {
    let kat = '';
    for (const k of ['am','a1','a2','a','b','c','ce','d']) {
      if (t.includes(` ${k} `) || t.endsWith(` ${k}`) || t.startsWith(`${k} `)) { kat = k.toUpperCase(); break; }
    }
    const list = listVehicles(data.vozni, kat);
    if (list) return `VOZNI PARK${kat ? ` – Kategorija ${kat}` : ''}:\n${list}`;
  }

  if (t.includes('koliko sati') || t.includes('satnica') || t.includes('teorija') || t.includes('praksa')) {
    const kat = ['am','a1','a2','a','b','c','ce','d'].find(k =>
      t.includes(` ${k} `) || t.endsWith(` ${k}`) || t.startsWith(`${k} `) || t.includes(`${k} kategor`)
    );
    if (kat && Array.isArray(data.kategorije)) {
      const row = data.kategorije.find(k => norm(k['Kategorija']).toLowerCase() === kat);
      if (row) {
        return `SATNICA ZA ${kat.toUpperCase()}:\n• Teorija: ${row['Broj sati teorija'] || row['Broj_sati_teorija']}h\n• Praksa: ${row['Broj sati praksa'] || row['Broj_sati_praksa']}h`;
      }
    }
  }

  return '';
}

/* ===== Prompt ===== */
function buildSystemPrompt(school, data, facts, aiSections) {
  const persona = norm(school['AI_PERSONA'] || 'Smiren, stručan instruktor.');
  const ton = norm(school['AI_TON'] || 'prijateljski, jasan');
  const stil = norm(school['AI_STIL'] || 'kratki odlomci; konkretno');
  const pravila = norm(school['AI_PRAVILA'] || 'Odgovaraj isključivo prema INDIVIDUAL podacima. Ne nagađaj.');
  const uvod = norm(school['AI_POZDRAV'] || 'Bok! 👋 Kako ti mogu pomoći oko upisa, cijena ili termina?');

  const tel = norm(school['Telefon'] || school['Telefon (fiksni)'] || school['Mobitel']);
  const web = norm(school['Web'] || school['Web stranica']);
  const mail = norm(school['Email'] || school['E-mail']);

  const kategorije = (data.kategorije || []).map(k => {
    const naziv = norm(k['Kategorija'] || k['Naziv']);
    const teorija = norm(k['Broj sati teorija'] || k['Broj_sati_teorija']);
    const praksa  = norm(k['Broj sati praksa']  || k['Broj_sati_praksa']);
    return `• ${naziv}: Teorija ${teorija}h | Praksa ${praksa}h`;
  }).filter(Boolean).join('\n');

  const cjenik = (data.cjenik || []).map(c => {
    const naziv = norm(c['Varijanta'] || c['Naziv']);
    const kat = norm(c['Kategorija']);
    const cijenaRaw = norm(c['Cijena']);
    const cijena = convertToEuro(cijenaRaw);
    const mjRata = calcMonthlyRate(cijenaRaw);
    return `• ${naziv} (${kat}) – ${cijena || '—'} (${mjRata})`;
  }).filter(Boolean).join('\n');

  const hak = (data.hak || []).map(n => {
    const name = norm(n['Naziv naknade'] || n['Naziv'] || n['Vrsta predmeta']);
    const iznos = convertToEuro(norm(n['Iznos']));
    return (name || iznos) ? `• ${name}: ${iznos}` : '';
  }).filter(Boolean).join('\n');

  const uvjeti = uvjetiText(data.uvjeti);

  const dodatne = (data.dodatne || []).map(d => {
    const name = norm(d['Naziv usluge'] || d['Naziv']);
    const kat = norm(d['Kategorija']);
    const cijena = convertToEuro(norm(d['Iznos'] || d['Cijena']));
    return (name || kat || cijena) ? `• ${name}${kat ? ` (${kat})` : ''}${cijena ? ` – ${cijena}` : ''}` : '';
  }).filter(Boolean).join('\n');

  const instruktori = (data.instruktori || []).map(i => {
    const ime = norm(i['Ime i prezime instruktora'] || i['Ime i prezime'] || i['Instruktor']);
    const kat = norm(i['Kategorije']);
    const vozilo = norm(i['Vozilo koje koristi']);
    return (ime || kat || vozilo) ? `• ${ime}${kat ? ' – ' + kat : ''}${vozilo ? ' | ' + vozilo : ''}` : '';
  }).filter(Boolean).join('\n');

  const vozniPark = listVehicles(data.vozni, '');
  const poligon = findLocation(data.lokacije, 'poligon');

  return `
Ti si AI asistent autoškole.

**Politika odgovaranja (SAMO INDIVIDUAL BAZA):**
1) Koristi isključivo INDIVIDUAL podatke (tablice + činjenice). Ne koristi vanjske izvore.
2) Ako podatak ne postoji, reci iskreno da nemaš informaciju i ponudi kontakt. Ne pretpostavljaj i ne izmišljaj.
3) Za cijene i sate: primarni izvor je CJENIK + KATEGORIJE; HAK naknade iz tablice PLAĆANJE HAK-u; dodatni sat iz DODATNE USLUGE.
4) Poštuj niže AI okvire (AI_CONTEXT/INTENT_PATTERNS/OUTPUT_RULES/DISAMBIGUATION/FALLBACK) za svaku tablicu.

Osobnost: ${persona}
Ton: ${ton}
Stil: ${stil}
Pravila: ${pravila}

Kontakt: ${tel} | ${mail} | ${web} | Radno vrijeme: ${norm(school['Radno_vrijeme'] || school['Radno vrijeme'])}

${facts ? `\n=== ČINJENICE ZA ODGOVOR ===\n${facts}\n` : ''}

${aiSections ? `\n${aiSections}\n` : ''}

=== KATEGORIJE ===
${kategorije || '(nema podataka)'}

=== CJENIK ===
${cjenik || '(nema podataka)'}

=== HAK naknade ===
${hak || '(nema podataka)'}

=== Uvjeti plaćanja ===
${uvjeti || '(nema podataka)'}

=== Dodatne usluge ===
${dodatne || '(nema podataka)'}

=== Instruktori ===
${instruktori || '(nema podataka)'}

=== Vozni park ===
${vozniPark || '(nema podataka)'}

=== Poligon ===
${poligon || '(nema podataka)'}

Otvarajući pozdrav: ${uvod}
`.trim();
}

/* ===== OpenAI helper: hard timeout ===== */
async function withTimeout(promise, ms = 20000) {
  const timeout = delay(ms).then(() => { throw new Error('OPENAI_TIMEOUT'); });
  return Promise.race([promise, timeout]);
}

/* ===== API ===== */
app.all('/api/ask', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const userMessage = (req.method === 'GET' ? req.query.q : req.body?.q || req.body?.message) || '';
    const history = (req.method === 'GET' ? [] : (req.body?.history || [])).slice(-12);
    if (!userMessage) return res.status(400).json({ ok: false, error: 'Missing message (q)' });

    const slug = normSlug(req.query.slug || req.headers['x-school-slug'] || DEFAULT_SLUG);
    const school = await getSchoolRow(slug);
    const safeSchool = (school && Object.keys(school).length) ? school : {
      'AI_PERSONA': 'Smiren, stručan instruktor.',
      'AI_TON': 'prijateljski, jasan',
      'AI_STIL': 'kratki odlomci; konkretno',
      'AI_PRAVILA': 'Odgovaraj prvenstveno o autoškoli.',
      'AI_POZDRAV': 'Bok! Kako ti mogu pomoći?',
      'Telefon': '', 'Email': '', 'Web': '', 'Radno_vrijeme': ''
    };

    const data = {};
    for (const [key, variants] of Object.entries(TABLES)) {
      if (key === 'faq') {
        data[key] = await getAllNoSlug(variants); // FAQ je globalan
      } else {
        data[key] = await getBySlugMulti(variants, slug);
      }
    }

    /* ❶ FAQ odgovor — koristi se SAMO ako NIJE upit o kategorijama/cijenama/satima/HAK-u i ako je STROGO podudaranje */
    if (!isCategoryOrPriceQuery(userMessage)) {
      const faqAnswer = answerFromFAQ_STRICT(userMessage, data.faq);
      if (faqAnswer) {
        return res.json({
          ok: true,
          reply: `${faqAnswer}\n\n(Odgovor iz FAQ baze)`
        });
      }
    }

    /* Heuristike + AI prompt okviri iz tablica */
    const facts = extractFacts(userMessage, data, safeSchool);
    const aiSections = extractAIPromptSections(data, slug);
    const systemPrompt = buildSystemPrompt(safeSchool, data, facts, aiSections);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage }
    ];

    let reply;
    try {
      const chat = await withTimeout(
        openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages,
          temperature: 0.2,
          max_tokens: 700
        }),
        20000
      );
      reply = chat.choices?.[0]?.message?.content?.trim();
    } catch (err) {
      console.error('OPENAI_CALL_ERROR', err?.message);
      return res.json({
        ok: true,
        reply: "Trenutno ne mogu dohvatiti odgovor od AI modela. Pokušaj ponovno ili pitaj konkretnije (npr. 'Cijene i sati za A kategoriju')."
      });
    }

    if (!reply || reply === '...') {
      return res.json({
        ok: true,
        reply: "Nažalost, nisam uspio generirati odgovor. Pokušaj ponovno konkretnije."
      });
    }

    res.json({
      ok: true,
      reply: `${reply}\n\n(Ovaj odgovor koristi prompt verziju ${promptVersion})`
    });
  } catch (e) {
    console.error('API_ERROR', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ===== Debug & Health ===== */
app.get('/api/debug', async (req, res) => {
  const slug = normSlug(req.query.slug || DEFAULT_SLUG);
  const school = await getSchoolRow(slug);
  const data = {};
  for (const [key, variants] of Object.entries(TABLES)) {
    if (key === 'faq') data[key] = await getAllNoSlug(variants);
    else data[key] = await getBySlugMulti(variants, slug);
  }
  const aiSections = extractAIPromptSections(data, slug);
  res.json({ ok: true, slug, school, data, aiSections });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'AI agent radi ✅', time: new Date().toISOString() });
});

/* ===== Start ===== */
app.listen(PORT, () => {
  console.log(`✅ AI Testigo agent (INDIVIDUAL only) radi na portu :${PORT}`);
});
