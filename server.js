// server.js — AI Testigo (INDIVIDUAL only, improved locations + instructors grouping + dodatni sat + better category parsing)
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

const promptVersion = 'v1.6';

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
function softNoDiacritics(s='') {
  return norm(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function wordSet(s) {
  return new Set(softNorm(s).split(' ').filter(w => w.length >= 3));
}
function overlapScore(q, candidate) {
  const qs = wordSet(q);
  const cs = wordSet(candidate);
  let overlap = 0;
  for (const w of qs) if (cs.has(w)) overlap++;
  const denom = (qs.size + cs.size - overlap) || 1;
  const jaccard = qs.size ? overlap / denom : 0;
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

/* ==== Kategorije: robust parsing ==== */
const KAT_CODES = ['AM','A1','A2','A','B','BE','KOD 96','C','CE','D','KOD 95','F','G'];
function normalizeKat(value) {
  const s = softNorm(value).toUpperCase();
  if (!s) return '';
  // prvo specijalni
  if (s.includes('KOD 95') || s.includes('CODE 95')) return 'KOD 95';
  if (s.includes('KOD 96') || s.includes('CODE 96')) return 'KOD 96';
  if (s.includes('BE')) return 'BE';
  // zatim standardni tokeni
  for (const k of ['AM','A1','A2','A','B','C','CE','D','F','G']) {
    const rx = new RegExp(`\\b${k}\\b`, 'i');
    if (rx.test(s)) return k;
  }
  return '';
}

/* ==== Vehicles list ==== */
function listVehicles(rows, wantedKat, locationHint='') {
  if (!rows?.length) return '';
  const wanted = wantedKat ? wantedKat.toUpperCase() : '';
  const locHint = softNorm(locationHint);

  const items = rows
    .filter(r => {
      const katRaw = norm(r['Kategorija'] || r['Namjena (kategorija)'] || r['Kategorija_ref']);
      const k = normalizeKat(katRaw);
      if (wanted && k !== wanted) return false;

      // optional lokacija filter (ako upit sadrži Brač/Kaštela/Trstenik/Grad)
      if (locHint) {
        const hay = softNorm([
          r['Lokacija'],
          r['LOKACIJA'],
          r['Napomena'],
          r['Naziv vozila'],
          r['Model'],
          r['Naziv']
        ].map(norm).join(' '));
        if (!hay.includes(locHint)) return false;
      }

      return true;
    })
    .map(r => {
      const katRaw = norm(r['Kategorija'] || r['Kategorija_ref']);
      const kat = normalizeKat(katRaw) || katRaw;
      const model = norm(r['Naziv vozila'] || r['Model'] || r['Naziv']);
      const tip = norm(r['Tip vozila'] || r['Tip'] || r['Vrsta vozila']);
      const god = norm(r['Godina']);
      const mjenjac = norm(r['Mjenjač'] || r['Mjenjac']);
      const lok = norm(r['Lokacija'] || r['LOKACIJA']);
      return `• ${kat ? `[${kat}] ` : ''}${model || tip}${god ? ' (' + god + ')' : ''}${mjenjac ? ' – ' + mjenjac : ''}${lok ? ' | ' + lok : ''}`;
    });

  const list = items.slice(0, 30);
  const extra = items.length > 30 ? `\n…i još ${items.length - 30} vozila.` : '';
  return list.join('\n') + extra;
}

/* ==== Locations: robust find ==== */
function locTypeOfRow(r) {
  return softNorm(r['Tip lokacije'] || r['Tip'] || r['Vrsta'] || r['TIP'] || '');
}
function findBestLocation(rows, wantTypeKeywords = []) {
  if (!rows?.length) return null;
  const keys = (wantTypeKeywords || []).map(k => softNorm(k));
  let best = null;
  let bestScore = -1;

  for (const r of rows) {
    const hay = softNorm([
      r['Tip lokacije'], r['Tip'], r['Vrsta'], r['Naziv'], r['Naziv ustanove / partnera'],
      r['Adresa'], r['Lokacija'], r['Mjesto'], r['Grad'], r['Napomena']
    ].map(norm).join(' '));

    let score = 0;
    for (const k of keys) {
      if (k && hay.includes(k)) score += 2;
    }
    // bonus ako tip počinje s ključnom riječi
    const t = locTypeOfRow(r);
    for (const k of keys) {
      if (k && t.startsWith(k)) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore > 0 ? best : null;
}

function formatLocationRow(row) {
  if (!row) return '';
  const naziv = norm(row['Naziv ustanove / partnera'] || row['Naziv'] || 'Lokacija');
  const adresa = norm(row['Adresa'] || row['Lokacija']);
  const grad = norm(row['Mjesto'] || row['Grad']);
  const tel = norm(row['Telefon'] || row['Tel'] || row['Kontakt']);
  const url = norm(row['Geo_URL'] || row['URL'] || row['Maps'] || row['Google Maps'] || row['Link na Google Maps']);
  return [
    `• ${naziv}`,
    adresa ? `  ${adresa}${grad ? ', ' + grad : ''}` : (grad ? `  ${grad}` : ''),
    tel ? `  T: ${tel}` : '',
    url ? `  Mapa: ${url}` : ''
  ].filter(Boolean).join('\n');
}

/* ==== School locations (AUTOŠKOLE): 4 lokacije u jednom polju ==== */
function extractSchoolLocationsFromSchoolRow(school) {
  // očekujemo da u AUTOŠKOLE imaš ili "Opis lokacije" (multiline) ili slično
  const raw =
    norm(school['Opis lokacije'] || school['Opis lokacija'] || school['Opis'] || school['Lokacije'] || school['Opis poslovnica']);
  const adr = norm(school['Adresa']);
  const maps = norm(school['Google Maps'] || school['Maps'] || school['Geo_URL'] || school['Link na Google Maps']);

  const lines = raw
    .split(/\r?\n/g)
    .map(x => x.trim())
    .filter(Boolean);

  // ako nema multiline opisa, barem vrati osnovnu adresu
  if (!lines.length) {
    const base = [
      adr ? `• ${adr}` : '',
      maps ? `  Mapa: ${maps}` : ''
    ].filter(Boolean).join('\n');
    return base ? `📍 Lokacije:\n${base}` : '';
  }

  return `📍 Lokacije:\n` + lines.map(l => `• ${l}`).join('\n');
}

/* ==== Payment text ==== */
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

/* ==== Additional hours (robust) ==== */
function findAdditionalHoursRows(rows, kat) {
  const K = kat?.toUpperCase();
  if (!rows?.length || !K) return [];
  return rows.filter(r => {
    const k = normalizeKat(r['Kategorija'] || r['Namjena (kategorija)'] || r['Kategorija_ref'] || '');
    if (k && k !== K) return false;

    const naziv = softNorm(r['Naziv usluge'] || r['Naziv'] || r['Usluga'] || '');
    const vrsta = softNorm(r['VRSTA FAQ'] || r['Vrsta'] || r['Tip'] || '');
    // hvataj "dodatni sat", "dopunski sat", "sat vožnje", itd.
    const looksLikeExtra =
      (naziv.includes('dodatni') && naziv.includes('sat')) ||
      (naziv.includes('dopunski') && naziv.includes('sat')) ||
      (naziv.includes('sat') && naziv.includes('vozn')) ||
      vrsta.includes('dodatni') ||
      vrsta.includes('sat');
    return looksLikeExtra;
  });
}

/* ==== Instructors: group by location for Hajduk ==== */
function groupInstruktoriByLokacija(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const loc = norm(r['LOKACIJA'] || r['Lokacija'] || r['Poslovnica'] || '').trim() || 'Ostalo';
    if (!groups.has(loc)) groups.set(loc, []);
    groups.get(loc).push(r);
  }
  return groups;
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
  faq: ['FAQ - Odgovori na pitanja', 'FAQ', 'FAQ – Odgovori', 'FAQ Odgovori']
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

async function getAllNoSlug(nameVariants) {
  for (const name of nameVariants) {
    try {
      const all = await atInd(name).select({ maxRecords: 500 }).all();
      if (all?.length) return all.map(r => r.fields);
    } catch {}
  }
  return [];
}

/* ===== FAQ strict (omekšano) ===== */
function answerFromFAQ_STRICT(userText, faqRows) {
  if (!faqRows?.length) return '';
  const q = softNorm(userText);

  const wordCount = q.split(' ').filter(Boolean).length;
  if (wordCount <= 3 || q.length < 12) return '';

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

    const ans = norm(r['ODGOVORI'] || r['Odgovor'] || r['Odgovori']);
    if (!ans) continue;

    for (const cand of qList) {
      const { overlap, qsSize, jaccard } = overlapScore(q, cand);
      const sn = softNorm(cand);

      const almostExact = sn && (q.includes(sn) || sn.includes(q)) && Math.min(q.length, sn.length) >= 10;

      const goodMatch =
        almostExact ||
        (overlap >= 3 && jaccard >= 0.4) ||
        (overlap >= 2 && jaccard >= 0.25 && qsSize <= 6);

      if (goodMatch && (overlap > best.score || (overlap === best.score && jaccard > best.jaccard))) {
        best = { score: overlap, jaccard, ans };
      }
    }
  }

  return best.score ? best.ans : '';
}

function isCategoryOrPriceQuery(s) {
  const q = softNorm(s);
  const hasKat =
    /\b(am|a1|a2|a|b|be|c|ce|d|kod\s*95|kod\s*96)\b/.test(q) ||
    /kategor/.test(q);

  const hasBizWords =
    /(cijena|cijene|koliko\s*kosta|kosta|sati|satnica|hak|naknad|paket|minimalna\s*dob|uvjeti\s*upisa|vozni\s*park|vozila|informacij|upis|teorij|praksa|voznj|dodatni\s*sat|dopunski\s*sat)/.test(q);

  return hasKat || hasBizWords;
}

/* ===== AI prompt okviri iz tablica ===== */
function extractAIPromptSections(allData, slug) {
  const sectionLines = [];
  const keys = Object.keys(allData).filter(k => k !== 'faq');

  for (const key of keys) {
    const rows = allData[key] || [];
    if (!rows.length) continue;

    const row =
      rows.find(r =>
        Object.keys(r).some(f => f.startsWith('AI_')) &&
        (normSlug(r.Slug || r['Slug (autoškola)'] || r['Slug (Autoškola)'] || r['slug (autoškola)']) === normSlug(slug) || !r.Slug)
      ) ||
      rows.find(r => Object.keys(r).some(f => f.startsWith('AI_')));

    if (!row) continue;

    const ctx = norm(row.AI_CONTEXT);
    const patt = norm(row.AI_INTENT_PATTERNS);
    const rules = norm(row.AI_OUTPUT_RULES);
    const dis = norm(row.AI_DISAMBIGUATION);
    const fb = norm(row.AI_FALLBACK);

    const any = [ctx, patt, rules, dis, fb].some(Boolean);
    if (!any) continue;

    sectionLines.push(
      [
        `=== AI INSTRUKCIJE ZA TABLICU ${key.toUpperCase()} ===`,
        ctx ? `Kontekst: ${ctx}` : '',
        patt ? `Namjere (uzorci): ${patt}` : '',
        rules ? `Pravila izlaza: ${rules}` : '',
        dis ? `Rasplitanje/pojašnjenje: ${dis}` : '',
        fb ? `Fallback kad nema podatka: ${fb}` : ''
      ].filter(Boolean).join('\n')
    );
  }

  return sectionLines.join('\n\n');
}

/* ===== Category summary (robust) ===== */
function buildCategorySummary(katRaw, data) {
  const kat = normalizeKat(katRaw);
  if (!kat) return '';

  // 1) Sati
  let satnica = '';
  const rowK = (data.kategorije || []).find(r => normalizeKat(r['Kategorija'] || r['Naziv']) === kat);
  if (rowK) {
    const te = norm(rowK['Broj sati teorija'] || rowK['Broj_sati_teorija']);
    const pr = norm(rowK['Broj sati praksa'] || rowK['Broj_sati_praksa']);
    const trajanje = norm(rowK['Trajanje (tipično)']);
    const minDob = norm(rowK['Minimalna dob'] || rowK['Minimalna_dob']);
    const uvjetiUpisa = norm(rowK['Uvjeti upisa'] || rowK['Uvjeti_upisa']);

    satnica = `• Sati: Teorija ${te || '?'}h, Praksa ${pr || '?'}h${trajanje ? ` | Trajanje (tipično): ${trajanje}` : ''}`;
    if (minDob) satnica += `\n• Minimalna dob: ${minDob} godina`;
    if (uvjetiUpisa) satnica += `\n• Uvjeti upisa: ${uvjetiUpisa}`;
  }

  // 2) Cijene
  const cj = (data.cjenik || [])
    .filter(c => normalizeKat(c['Kategorija']) === kat)
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
    .filter(n => normalizeKat(n['Kategorija']) === kat)
    .map(n => {
      const vrsta = norm(n['Vrsta predmeta'] || n['Naziv naknade'] || n['Naziv'] || 'Naknada');
      const iznos = convertToEuro(norm(n['Iznos']));
      return `  - ${vrsta}: ${iznos}`;
    }).join('\n');
  const hakSekcija = hak ? `• Ispitne naknade (HAK):\n${hak}` : '';

  // 4) Uvjeti plaćanja
  const uvjeti = uvjetiText(data.uvjeti);
  const uvjetiSekcija = uvjeti ? `• Uvjeti plaćanja: ${uvjeti}` : '';

  // 5) Dodatni sat (robust)
  const extraRows = findAdditionalHoursRows(data.dodatne || [], kat);
  const dodatni = extraRows
    .map(d => {
      const iznos = convertToEuro(norm(d['Iznos'] || d['Cijena']));
      const naziv = norm(d['Naziv usluge'] || d['Naziv'] || 'Dodatni sat');
      return `  - ${naziv}: ${iznos || '—'}`;
    })
    .join('\n');
  const dodatniSekcija = dodatni ? `• Dodatni sati:\n${dodatni}` : '';

  return [
    `✅ KATEGORIJA ${kat}`,
    satnica,
    cjSekcija,
    hakSekcija,
    uvjetiSekcija,
    dodatniSekcija
  ].filter(Boolean).join('\n');
}

/* ===== Quick facts router ===== */
function extractFacts(userText, data, school, slug) {
  const t = softNorm(userText);

  // 0) "gdje poslujete / gdje ste" -> iz AUTOŠKOLE (posebno Hajduk)
  if (
    t.includes('gdje poslujete') ||
    t.includes('gdje ste') ||
    t.includes('gdje se nalazite') ||
    t.includes('lokacije') ||
    (t.includes('adresa') && !t.includes('hak')) ||
    (t.includes('poslovnica'))
  ) {
    const schoolLocs = extractSchoolLocationsFromSchoolRow(school);
    if (schoolLocs) return schoolLocs;
  }

  // 1) Instruktori – po lokaciji (Hajduk) ili standardno
  if (t.includes('instruktor')) {
    const rows = data.instruktori || [];
    if (!rows.length) return '';

    // ako pitaju benzin/dizel/vrsta motora -> izvuci NAPOMENA
    if (t.includes('benzin') || t.includes('dizel') || t.includes('diesel') || t.includes('vrsta motora')) {
      const lines = rows.map(r => {
        const ime = norm(r['Ime i prezime instruktora'] || r['Ime i prezime'] || r['Instruktor']);
        const vozilo = norm(r['Vozilo koje koristi'] || r['Vozilo']);
        const nap = norm(r['NAPOMENA'] || r['Napomena']);
        const lok = norm(r['LOKACIJA'] || r['Lokacija']);
        return (ime || vozilo || nap) ? `• ${ime}${lok ? ` (${lok})` : ''}${vozilo ? ` – ${vozilo}` : ''}${nap ? ` | ${nap}` : ''}` : '';
      }).filter(Boolean).slice(0, 80);

      return lines.length ? `INSTRUKTORI (napomene o vozilu/motoru):\n${lines.join('\n')}` : '';
    }

    // Hajduk: grupiranje po lokaciji
    if (normSlug(slug) === 'hajduk') {
      const groups = groupInstruktoriByLokacija(rows);
      const out = [];
      for (const [loc, list] of groups.entries()) {
        const lines = list.map(r => {
          const ime = norm(r['Ime i prezime instruktora'] || r['Ime i prezime'] || r['Instruktor']);
          const kat = norm(r['Kategorije']);
          const vozilo = norm(r['Vozilo koje koristi'] || r['Vozilo']);
          return `  • ${ime}${kat ? ' – ' + kat : ''}${vozilo ? ' | ' + vozilo : ''}`;
        }).filter(Boolean);
        if (lines.length) out.push(`📍 ${loc}\n${lines.join('\n')}`);
      }
      return out.length ? `INSTRUKTORI PO LOKACIJI:\n\n${out.join('\n\n')}` : '';
    }

    // ostale škole: default list
    const lines = rows.map(r => {
      const ime = norm(r['Ime i prezime instruktora'] || r['Ime i prezime'] || r['Instruktor']);
      const kat = norm(r['Kategorije']);
      const vozilo = norm(r['Vozilo koje koristi'] || r['Vozilo']);
      return (ime || kat || vozilo) ? `• ${ime}${kat ? ' – ' + kat : ''}${vozilo ? ' | ' + vozilo : ''}` : '';
    }).filter(Boolean).slice(0, 80);

    return lines.length ? `INSTRUKTORI:\n${lines.join('\n')}` : '';
  }

  // 2) Kategorije / cijene / sati / hak — “sve info”
  const wantedKat = normalizeKat(userText);
  if (wantedKat && (t.includes('sve info') || t.includes('sve informacije') || t.includes('cijene') || t.includes('sati') || t.includes('hak') || t.includes('paket'))) {
    const pack = buildCategorySummary(wantedKat, data);
    if (pack) return pack;
  }

  // 3) HAK / prva pomoć / liječnički / poligon -> LOKACIJE tablica (robust)
  if (t.includes('hak') || t.includes('ispitni centar')) {
    const row = findBestLocation(data.lokacije || [], ['hak', 'ispitni', 'centar']);
    if (row) return `HAK / ISPITNI CENTAR:\n${formatLocationRow(row)}`;
  }

  if (t.includes('prva pomoc') || t.includes('prva pomoć')) {
    const row = findBestLocation(data.lokacije || [], ['prva pomoc', 'prva pomoć', 'crveni kriz', 'crveni križ']);
    if (row) return `PRVA POMOĆ:\n${formatLocationRow(row)}`;
  }

  if (t.includes('lijecnick') || t.includes('liječnič') || t.includes('medicina rada') || t.includes('pregled')) {
    const row = findBestLocation(data.lokacije || [], ['medicina rada', 'lijecnick', 'liječnič', 'pregled']);
    if (row) return `LIJEČNIČKI PREGLED:\n${formatLocationRow(row)}`;
  }

  if (t.includes('poligon') || t.includes('vjezbali') || t.includes('vježbali')) {
    const row = findBestLocation(data.lokacije || [], ['poligon', 'vježbali', 'vjezbali']);
    if (row) return `POLIGON:\n${formatLocationRow(row)}`;
  }

  // 4) Uvjeti plaćanja
  if (t.includes('kartic') || t.includes('kartic') || t.includes('rate') || t.includes('plaćan') || t.includes('placan')) {
    const u = uvjetiText(data.uvjeti);
    if (u) return `UVJETI PLAĆANJA:\n${u}`;
  }

  // 5) Vozni park + lokacijski hint (brač/kaštela/trstenik/grad)
  if (t.includes('vozni park') || t.includes('vozila')) {
    const locHint =
      t.includes('brac') || t.includes('brač') ? 'brač' :
      t.includes('supetar') ? 'supetar' :
      t.includes('kaštel') || t.includes('kastel') ? 'kaštel' :
      t.includes('trstenik') ? 'trstenik' :
      t.includes('grad') ? 'grad' : '';

    const wanted = wantedKat || '';
    const list = listVehicles(data.vozni || [], wanted, locHint);
    if (list) return `VOZNI PARK${wanted ? ` – Kategorija ${wanted}` : ''}${locHint ? ` (${locHint})` : ''}:\n${list}`;
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
    const naziv = normalizeKat(k['Kategorija'] || k['Naziv']) || norm(k['Kategorija'] || k['Naziv']);
    const teorija = norm(k['Broj sati teorija'] || k['Broj_sati_teorija']);
    const praksa  = norm(k['Broj sati praksa']  || k['Broj_sati_praksa']);
    return `• ${naziv}: Teorija ${teorija}h | Praksa ${praksa}h`;
  }).filter(Boolean).join('\n');

  const cjenik = (data.cjenik || []).map(c => {
    const naziv = norm(c['Varijanta'] || c['Naziv']);
    const kat = normalizeKat(c['Kategorija']) || norm(c['Kategorija']);
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
    const kat = normalizeKat(d['Kategorija']) || norm(d['Kategorija']);
    const cijena = convertToEuro(norm(d['Iznos'] || d['Cijena']));
    return (name || kat || cijena) ? `• ${name}${kat ? ` (${kat})` : ''}${cijena ? ` – ${cijena}` : ''}` : '';
  }).filter(Boolean).join('\n');

  const instruktori = (data.instruktori || []).map(i => {
    const ime = norm(i['Ime i prezime instruktora'] || i['Ime i prezime'] || i['Instruktor']);
    const kat = norm(i['Kategorije']);
    const vozilo = norm(i['Vozilo koje koristi']);
    const lok = norm(i['LOKACIJA'] || i['Lokacija']);
    return (ime || kat || vozilo) ? `• ${ime}${lok ? ` (${lok})` : ''}${kat ? ' – ' + kat : ''}${vozilo ? ' | ' + vozilo : ''}` : '';
  }).filter(Boolean).join('\n');

  const vozniPark = listVehicles(data.vozni || [], '', '');
  const poligonRow = findBestLocation(data.lokacije || [], ['poligon', 'vježbali', 'vjezbali']);
  const poligon = poligonRow ? formatLocationRow(poligonRow) : '';

  return `
Ti si AI asistent autoškole.

**Politika odgovaranja (SAMO INDIVIDUAL BAZA):**
1) Koristi isključivo INDIVIDUAL podatke (tablice + činjenice). Ne koristi vanjske izvore.
2) Ako podatak ne postoji, reci iskreno da nemaš informaciju i ponudi kontakt. Ne pretpostavljaj i ne izmišljaj.
3) Za cijene i sate: primarni izvor je CJENIK + KATEGORIJE; HAK naknade iz tablice PLAĆANJE HAK-u; dodatni sati iz DODATNE USLUGE.
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

Važno:
- Kad korisnik pita "gdje ste / gdje poslujete / lokacije", koristi AUTOŠKOLE -> "Opis lokacije" i ne spominji ništa o Prvoj pomoći osim ako je izričito pita.
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
      if (key === 'faq') data[key] = await getAllNoSlug(variants);
      else data[key] = await getBySlugMulti(variants, slug);
    }

    // ❶ FAQ (omekšano) — samo ako NIJE upit o kategorijama/cijenama/HAK/vozila...
    if (!isCategoryOrPriceQuery(userMessage)) {
      const faqAnswer = answerFromFAQ_STRICT(userMessage, data.faq);
      if (faqAnswer) return res.json({ ok: true, reply: faqAnswer });
    }

    // ❷ Heuristike (lokacije, instruktori, kategorije paketi…)
    const facts = extractFacts(userMessage, data, safeSchool, slug);
    if (facts) {
      return res.json({ ok: true, reply: `${facts}\n\n(v ${promptVersion})` });
    }

    // ❸ AI odgovor
    const aiSections = extractAIPromptSections(data, slug);
    const systemPrompt = buildSystemPrompt(safeSchool, data, '', aiSections);

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
        reply: `Trenutno ne mogu dohvatiti odgovor. Pokušaj ponovno ili pitaj konkretnije.\n\n(v ${promptVersion})`
      });
    }

    if (!reply || reply === '...') {
      return res.json({ ok: true, reply: `Nažalost, nisam uspio generirati odgovor. Pokušaj ponovno konkretnije.\n\n(v ${promptVersion})` });
    }

    res.json({ ok: true, reply: `${reply}\n\n(v ${promptVersion})` });
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
