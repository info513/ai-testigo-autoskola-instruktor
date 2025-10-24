// server.js
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
  const url = norm(row['Geo_URL'] || row['URL'] || row['Maps']);
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
      } catch { /* try next variant */ }
    }
    const any = await atInd('AUTOŠKOLE').select({ maxRecords: 1 }).all();
    return any?.[0]?.fields || {};
  } catch (e) {
    console.warn('AUTOŠKOLE_WARN', e.message);
    return {};
  }
}

/* ===== Dohvat tablica s novim/starim nazivima ===== */
const TABLES = {
  kategorije: ['KATEGORIJE', 'KATEGORIJE AUTOŠKOLE'],
  cjenik: ['CJENIK', 'CJENIK I PRAVILA'],
  hak: ['PLAĆANJE HAK-u', 'NAKNADE ZA POLAGANJE'],
  uvjeti: ['UVJETI PLAĆANJA'],
  dodatne: ['DODATNE USLUGE'],
  instruktori: ['INSTRUKTORI'],
  vozni: ['VOZNI PARK'],
  lokacije: ['LOKACIJE', 'LOKACIJE & PARTNERI'],
  nastava: ['NASTAVA & PREDAVANJA'],          // opcionalno (možda nema)
  upisi: ['UPIŠI SE ONLINE']                  // opcionalno (možda nema)
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
    } catch { /* try next variant */ }
  }
  return [];
}

/* ===== GLOBAL blokovi (opći sadržaji) ===== */
async function getGlobalBlocks() {
  if (!atGlobal || !AIRTABLE_BASE_ID_GLOBAL) return { globalRules: [] };
  try {
    const metaResp = await fetch(
      `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID_GLOBAL}/tables`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const meta = await metaResp.json();
    if (!meta?.tables?.length) return { globalRules: [] };

    const results = [];
    for (const t of meta.tables) {
      try {
        const recs = await atGlobal(t.name).select({ maxRecords: 500 }).all();
        for (const r of recs) {
          const f = r.fields || {};
          const title = f['Naziv rubrike / pitanje'] || f['Naziv'] || f['Pitanje'] || f['Pojam'] || '';
          const body = f['Opis'] || f['Sadržaj'] || f['Answer'] || f['Objašnjenje'] || '';
          if (title || body) results.push({ title: norm(title), body: norm(body) });
        }
      } catch { /* ignore table */ }
    }
    return { globalRules: results };
  } catch (e) {
    console.warn('GLOBAL_META_WARN', e.message);
    return { globalRules: [] };
  }
}

/* ===== Heuristike za “činjenice” ===== */
function extractFacts(userText, data, school) {
  const t = norm(userText).toLowerCase();

  if (t.includes('adresa') || t.includes('gdje ste') || t.includes('gdje se nalazite') || t.includes('lokacija')) {
    const adr = norm(school['Adresa']);
    const maps = norm(school['Google Maps'] || school['Maps'] || school['School.Maps_URL']);
    const hours = norm(school['Radno_vrijeme'] || school['School.Hours']);
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

  if (t.includes('poligon') || t.includes('vježbalište') || t.includes('vjezbalište')) {
    const pol = findLocation(data.lokacije, 'poligon');
    if (pol) return `POLIGON:\n• ${pol}`;
  }

  if (t.includes('prva pomoć') || t.includes('prve pomoći') || t.includes('prve pomoci')) {
    const pp = findLocation(data.lokacije, 'prva pomoć');
    if (pp) return `PRVA POMOĆ:\n• ${pp}`;
  }

  if (t.includes('kartic') || t.includes('rate') || t.includes('plaćan') || t.includes('placan')) {
    const u = uvjetiText(data.uvjeti);
    if (u) return `UVJETI PLAĆANJA:\n${u}`;
  }

  if (t.includes('vozni park') || t.includes('vozila') || t.includes('voz')) {
    let kat = '';
    for (const k of ['am', 'a1', 'a2', 'a', 'b', 'c', 'ce', 'd']) {
      if (t.includes(` ${k} `) || t.endsWith(` ${k}`) || t.startsWith(`${k} `)) { kat = k.toUpperCase(); break; }
    }
    const list = listVehicles(data.vozni, kat);
    if (list) return `VOZNI PARK${kat ? ` – Kategorija ${kat}` : ''}:\n${list}`;
  }

  return '';
}

/* ===== System prompt ===== */
function buildSystemPrompt(school, data, globalBlocks, facts) {
  const persona = norm(school['AI_PERSONA'] || 'Smiren, stručan instruktor koji jasno i praktično objašnjava.');
  const ton = norm(school['AI_TON'] || 'prijateljski, jasan, bez žargona');
  const stil = norm(school['AI_STIL'] || 'kratki odlomci; konkretno; CTA gdje ima smisla');
  const pravila = norm(school['AI_PRAVILA'] || 'Primarno odgovaraj o ovoj autoškoli i ne izmišljaj podatke.');
  const uvod = norm(school['AI_POZDRAV'] || 'Bok! 👋 Kako ti mogu pomoći oko upisa, cijena ili termina?');

  const kategorije = (data.kategorije || []).map(k =>
    `• ${norm(k['Kategorija'] || k['Naziv'] || k['Kategorija_ref'])}: Teorija ${k['Broj_sati_teorija'] ?? '-'}h | Praksa ${k['Broj_sati_praksa'] ?? '-'}h`
  ).join('\n');

  const cjenik = (data.cjenik || []).map(c =>
    `• ${norm(c['Varijanta'] || c['Naziv_paketa'] || c['Naziv'])} (${norm(c['Kategorija'] || c['Kategorija_ref'])}) – ${norm(c['Cijena']) || '-'}${norm(c['Napomena']) ? ' | ' + norm(c['Napomena']) : ''}`
  ).join('\n');

  const hak = (data.hak || []).map(n =>
    `• ${norm(n['Naziv_naknade'] || n['Naziv'])}: ${norm(n['Iznos']) || '-'} (${norm(n['Kome_se_plaća'] || n['Kome se plaća'] || n['Tko'])})${norm(n['Opis']) ? ' – ' + norm(n['Opis']) : ''}`
  ).join('\n');

  const uvjeti = uvjetiText(data.uvjeti);
  const dodatne = (data.dodatne || []).map(d => `• ${norm(d['Naziv'])}: ${norm(d['Opis'])} (${norm(d['Cijena']) || '-'})`).join('\n');
  const vozniPark = listVehicles(data.vozni, '');
  const poligon = findLocation(data.lokacije, 'poligon');

  const instruktori = (data.instruktori || []).map(i => {
    const ime = norm(i['Ime i prezime'] || i['Ime'] || i['Instruktor']);
    const kat = norm(i['Kategorije'] || i['Kategorija']);
    const tel = norm(i['Telefon'] || i['Mobitel']);
    return `• ${ime}${kat ? ' – ' + kat : ''}${tel ? ' | ' + tel : ''}`;
  }).join('\n');

  const globalJoined = (globalBlocks.globalRules || []).map(g => `• ${g.title}: ${g.body}`).join('\n');

  return `
Ti si AI asistent autoškole.

**Politika odgovaranja (važno):**
1) Prvo koristi INDIVIDUAL podatke (sekcije niže + ČINJENICE ZA ODGOVOR).
2) Ako nema u INDIVIDUAL, smiješ koristiti GLOBAL vodiče.
3) Ako nema ni tamo, reci da trenutno nemaš taj podatak i ponudi kontakt. Ne izmišljaj.

Osobnost: ${persona}
Ton: ${ton}
Stil: ${stil}
Pravila: ${pravila}

Kontakt: ${norm(school['Telefon'])} | ${norm(school['Email'])} | ${norm(school['Web'])} | Radno vrijeme: ${norm(school['Radno_vrijeme'])}

${facts ? `\n=== ČINJENICE ZA ODGOVOR (obavezno koristi) ===\n${facts}\n` : ''}

=== Kategorije (sati) ===
${kategorije || '(nema podataka)'}

=== CJENIK ===
${cjenik || '(nema podataka)'}

=== PLAĆANJE HAK-u (ispitne naknade) ===
${hak || '(nema podataka)'}

=== Uvjeti plaćanja ===
${uvjeti || '(nema podataka)'}

=== Dodatne usluge ===
${dodatne || '(nema podataka)'}

=== Instruktori ===
${instruktori || '(nema podataka)'}

=== Vozni park (sažetak) ===
${vozniPark || '(nema podataka)'}

=== Poligon (sažetak) ===
${poligon || '(nema podataka)'}

=== Globalni vodiči (koristi samo ako Individual nema podatak) ===
${globalJoined || '(—)'}

Otvarajući pozdrav: ${uvod}
`.trim();
}

/* ===== API ===== */

// Health
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Debug (ne ruši se ako tablica ne postoji)
app.get('/api/debug', async (req, res) => {
  try {
    const slug = normSlug(req.query.slug || req.headers['x-school-slug'] || DEFAULT_SLUG);
    const school = await getSchoolRow(slug);
    const report = { slug, schoolName: school?.['Naziv'] || null, tables: {}, samples: {} };

    for (const [key, variants] of Object.entries(TABLES)) {
      let total = 0, matched = 0, slugsFound = [];
      let sample = [];
      for (const t of variants) {
        try {
          const all = await atInd(t).select({ maxRecords: 200 }).all();
          total = all.length;
          slugsFound = Array.from(new Set(all.map(r =>
            normSlug(r.fields?.Slug || r.fields?.['Slug (autoškola)'] || r.fields?.['Slug (Autoškola)'] || r.fields?.['slug (autoškola)'])
          ).filter(Boolean)));
          const filtered = await getBySlugMulti([t], slug);
          matched = filtered.length;
          sample = filtered.slice(0, 2).map(r => Object.fromEntries(Object.entries(r).slice(0, 10)));
          break; // uspjelo za ovaj naziv
        } catch { /* probaj idući naziv */ }
      }
      report.tables[key] = { foundNames: variants, total, matched, slugsFound };
      report.samples[key] = sample;
    }

    res.json(report);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Glavni endpoint
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

    const [
      kategorije, cjenik, hak, uvjeti, dodatne, instruktori, vozni, lokacije, nastava, upisi
    ] = await Promise.all([
      getBySlugMulti(TABLES.kategorije, slug),
      getBySlugMulti(TABLES.cjenik, slug),
      getBySlugMulti(TABLES.hak, slug),
      getBySlugMulti(TABLES.uvjeti, slug),
      getBySlugMulti(TABLES.dodatne, slug),
      getBySlugMulti(TABLES.instruktori, slug),
      getBySlugMulti(TABLES.vozni, slug),
      getBySlugMulti(TABLES.lokacije, slug),
      getBySlugMulti(TABLES.nastava, slug),
      getBySlugMulti(TABLES.upisi, slug)
    ]);

    const data = { kategorije, cjenik, hak, uvjeti, dodatne, instruktori, vozni, lokacije, nastava, upisi };

    const globalBlocks = await getGlobalBlocks();
    const facts = extractFacts(userMessage, data, safeSchool);
    const systemPrompt = buildSystemPrompt(safeSchool, data, globalBlocks, facts);

    // GLOBAL FAQ (ako postoji)
    let faqText = '';
    try {
      if (atGlobal) {
        const faq = await atGlobal('FAQ – Pitanja kandidata')
          .select({
            view: 'AI_ACTIVE',
            filterByFormula: `FIND(LOWER("${sanitizeForFormula(userMessage)}"), {AI_INDEX})`,
            maxRecords: 3
          })
          .firstPage();
        faqText = (faq || []).map(r => `Q: ${norm(r.fields.Pitanje)}\nA: ${norm(r.fields.Odgovor)}`).join('\n\n');
      }
    } catch (e) {
      console.warn('FAQ_SEARCH_WARN', e.message);
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...history,
      {
        role: 'user',
        content:
`Korisnički upit: "${userMessage}"

Relevantni GLOBAL FAQ zapisi:
${faqText || '—'}

Upute:
- Ako korisnik traži lokaciju: daj adresu + Maps + radno vrijeme iz INDIVIDUAL.
- Ako traži kontakt: daj tel, mob, email + link na kontakt formu (ako postoji).
- Ako pita cijenu: prikaži prvo mjesečni iznos ≈ cijena/12 (zaokruži), zatim puni iznos.
- Uz cijenu dodaj satnicu (teorija/praksa) ako postoji.
- Ponudi online upis (ako postoji URL forme) i pitaj treba li još nešto.`
      }
    ];

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || 'Trenutno nemam odgovor.';
    let cta = null;
    if (upisi?.[0]?.['URL_forme'] || upisi?.[0]?.['URL'] || upisi?.[0]?.['Link']) {
      cta = {
        text: upisi?.[0]?.['CTA_tekst'] || upisi?.[0]?.['CTA'] || 'Upiši se online',
        url: upisi?.[0]?.['URL_forme'] || upisi?.[0]?.['URL'] || upisi?.[0]?.['Link']
      };
    }

    res.json({ ok: true, slug, answer, cta });
  } catch (err) {
    console.error('ASK_ERROR', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`✅ AI Testigo agent radi na portu :${PORT}`);
});
