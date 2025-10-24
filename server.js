import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Airtable from 'airtable';
import OpenAI from 'openai';

/* ===== ENV ===== */
const {
  PORT = 8080,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID_INDIVIDUAL,
  AIRTABLE_BASE_ID_GLOBAL,
  SCHOOL_SLUG: DEFAULT_SLUG = 'instruktor'
} = process.env;

if (!OPENAI_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID_INDIVIDUAL) {
  console.error('❗ Nedostaju env varijable: OPENAI_API_KEY, AIRTABLE_API_KEY ili AIRTABLE_BASE_ID_INDIVIDUAL');
  process.exit(1);
}

/* ===== APP ===== */
const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const atInd = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID_INDIVIDUAL);
const atGlobal = AIRTABLE_BASE_ID_GLOBAL
  ? new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID_GLOBAL)
  : null;

/* ===== Helpers ===== */
const norm = v => (Array.isArray(v) ? v[0] : v ?? '').toString();
const normSlug = v => norm(v).trim().toLowerCase();
const sanitizeForFormula = s => norm(s).replace(/"/g, '').replace(/'/g, '’');

function convertToEuro(value) {
  const num = parseFloat(value);
  if (value.includes('kn')) return Math.round(num / 7.5345) + ' €';
  return value.includes('€') ? value : `${num} €`;
}

function calcMonthlyRate(price, months = 12) {
  const num = parseFloat(price);
  return isNaN(num) ? '-' : Math.round(num / months) + ' €/mj';
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
  return items.slice(0, 20).join('\n');
}

function findLocation(rows, needle) {
  if (!rows?.length) return '';
  const row = rows.find(l => norm(l['Tip lokacije'] || l['Tip'] || l['Vrsta']).toLowerCase().includes(needle));
  if (!row) return '';
  const naziv = norm(row['Naziv ustanove / partnera'] || row['Naziv'] || 'Lokacija');
  const adresa = norm(row['Adresa'] || row['Lokacija']);
  const grad = norm(row['Grad']);
  const url = norm(row['Geo_URL'] || row['URL'] || row['Maps'] || row['Google Maps']);
  return `${naziv}${adresa ? ', ' + adresa : ''}${grad ? ', ' + grad : ''}${url ? ' | Mapa: ' + url : ''}`;
}

function uvjetiText(rows) {
  if (!rows?.length) return '';
  const f = rows[0];
  const explicit = norm(f['Opis uvjeta'] || f['Opis']);
  if (explicit) return explicit;
  return [
    f['Načini_plaćanja'] ? `Načini plaćanja: ${f['Načini_plaćanja']}` : '',
    f['Rate_mogućnost'] ? `Rate: ${f['Rate_mogućnost']}` : '',
    f['Avans'] ? `Avans: ${f['Avans']}` : '',
    f['Rokovi'] ? `Rokovi: ${f['Rokovi']}` : ''
  ].filter(Boolean).join(' | ');
}

/* ===== Slug → škola ===== */
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

/* ===== Tablice ===== */
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
  upisi: ['UPIŠI SE ONLINE']
};

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
function extractFacts(userText, data, school) {
  const t = norm(userText).toLowerCase();

  // Lokacija autoškole
  if (t.includes('adresa') || t.includes('gdje ste') || t.includes('gdje se nalazite') || t.includes('lokacija')) {
    const adr = norm(school['Adresa']);
    const maps = norm(school['Google Maps'] || school['Maps'] || school['Geo_URL']);
    const hours = norm(school['Radno_vrijeme']);
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

  // Poligon
  if (t.includes('poligon') || t.includes('vježbalište')) {
    const pol = findLocation(data.lokacije, 'poligon');
    if (pol) return `POLIGON:\n• ${pol}`;
  }

  // Prva pomoć
  if (t.includes('prva pomoć')) {
    const pp = findLocation(data.lokacije, 'prva pomoć');
    if (pp) return `PRVA POMOĆ:\n• ${pp}`;
  }

  // Plaćanje
  if (t.includes('kartic') || t.includes('rate') || t.includes('plaćan')) {
    const u = uvjetiText(data.uvjeti);
    if (u) return `UVJETI PLAĆANJA:\n${u}`;
  }

  // Vozni park
  if (t.includes('vozni park') || t.includes('vozila')) {
    let kat = '';
    for (const k of ['am', 'a1', 'a2', 'a', 'b', 'c', 'ce', 'd']) {
      if (t.includes(` ${k} `) || t.endsWith(` ${k}`) || t.startsWith(`${k} `)) { kat = k.toUpperCase(); break; }
    }
    const list = listVehicles(data.vozni, kat);
    if (list) return `VOZNI PARK${kat ? ` – Kategorija ${kat}` : ''}:\n${list}`;
  }

  // Satnica
  if (t.includes('koliko sati') || t.includes('satnica') || t.includes('teorija') || t.includes('praksa')) {
    const kat = ['am', 'a1', 'a2', 'a', 'b', 'c', 'ce', 'd'].find(k => t.includes(k));
    const row = data.kategorije.find(k => norm(k['Kategorija'])?.toLowerCase() === kat);
    if (row) {
      return `SATNICA ZA ${kat.toUpperCase()}:\n• Teorija: ${row['Broj_sati_teorija']}h\n• Praksa: ${row['Broj_sati_praksa']}h`;
    }
  }

  return '';
}

function buildSystemPrompt(school, data, globalBlocks, facts) {
  const persona = norm(school['AI_PERSONA'] || 'Smiren, stručan instruktor.');
  const ton = norm(school['AI_TON'] || 'prijateljski, jasan');
  const stil = norm(school['AI_STIL'] || 'kratki odlomci; konkretno');
  const pravila = norm(school['AI_PRAVILA'] || 'Odgovaraj prvenstveno o autoškoli. Ne nagađaj. Koristi samo dostupne podatke.');
  const uvod = norm(school['AI_POZDRAV'] || 'Bok! 👋 Kako ti mogu pomoći oko upisa, cijena ili termina?');

  const kategorije = (data.kategorije || []).map(k => {
    const naziv = norm(k['Kategorija'] || k['Naziv']);
    const teorija = k['Broj_sati_teorija'];
    const praksa = k['Broj_sati_praksa'];
    return `• ${naziv}: Teorija ${teorija}h | Praksa ${praksa}h`;
  }).join('\n');

  const cjenik = (data.cjenik || []).map(c => {
    const naziv = norm(c['Varijanta'] || c['Naziv']);
    const kat = norm(c['Kategorija']);
    const cijena = convertToEuro(norm(c['Cijena']));
    const mjRata = calcMonthlyRate(norm(c['Cijena']));
    return `• ${naziv} (${kat}) – ${cijena} (${mjRata})`;
  }).join('\n');

  const hak = (data.hak || []).map(n =>
    `• ${norm(n['Naziv'])}: ${convertToEuro(norm(n['Iznos']))} (${norm(n['Kome_se_plaća'])})`
  ).join('\n');

  const uvjeti = uvjetiText(data.uvjeti);
  const dodatne = (data.dodatne || []).map(d =>
    `• ${norm(d['Naziv'])}: ${norm(d['Opis'])} (${convertToEuro(norm(d['Cijena']))})`
  ).join('\n');

  const instruktori = (data.instruktori || []).map(i => {
    const ime = norm(i['Ime i prezime']);
    const kat = norm(i['Kategorije']);
    const tel = norm(i['Telefon']);
    return `• ${ime}${kat ? ' – ' + kat : ''}${tel ? ' | ' + tel : ''}`;
  }).join('\n');

  const vozniPark = listVehicles(data.vozni, '');
  const poligon = findLocation(data.lokacije, 'poligon');

  const globalJoined = (globalBlocks.globalRules || []).map(g => `• ${g.title}: ${g.body}`).join('\n');

  return `
Ti si AI asistent autoškole.

**Politika odgovaranja:**
1) Koristi INDIVIDUAL podatke (tablice + činjenice).
2) Ako nema, koristi GLOBAL vodiče.
3) Ako nema ni tamo, reci iskreno da nemaš podatak i predloži kontakt.

Osobnost: ${persona}
Ton: ${ton}
Stil: ${stil}
Pravila: ${pravila}

Kontakt: ${norm(school['Telefon'])} | ${norm(school['Email'])} | ${norm(school['Web'])} | Radno vrijeme: ${norm(school['Radno_vrijeme'])}

${facts ? `\n=== ČINJENICE ZA ODGOVOR ===\n${facts}\n` : ''}

=== Kategorije ===
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

=== Globalni vodiči ===
${globalJoined || '(—)'}

Otvarajući pozdrav: ${uvod}
`.trim();
}
/* ===== API ===== */
app.all('/api/ask', async (req, res) => {
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
      data[key] = await getBySlugMulti(variants, slug);
    }

    const globalBlocks = atGlobal
      ? { globalRules: await getBySlugMulti(['GLOBAL RULES', 'GLOBALNE INFORMACIJE'], slug) }
      : { globalRules: [] };

    const facts = extractFacts(userMessage, data, safeSchool);
    const systemPrompt = buildSystemPrompt(safeSchool, data, globalBlocks, facts);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: userMessage }
    ];

    const chat = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.4
    });

    const reply = chat.choices?.[0]?.message?.content?.trim();
    if (!reply) return res.status(500).json({ ok: false, error: 'Empty response from OpenAI' });

    res.json({ ok: true, reply });
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
    data[key] = await getBySlugMulti(variants, slug);
  }
  res.json({ ok: true, slug, school, data });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'AI agent radi ✅', time: new Date().toISOString() });
});

/* ===== Start ===== */
app.listen(PORT, () => {
  console.log(`✅ AI Testigo agent radi na portu :${PORT}`);
});
