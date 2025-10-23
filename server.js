// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Airtable from 'airtable';
import OpenAI from 'openai';

// -------- ENV --------
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

// -------- APP --------
const app = express();
app.use(cors());
app.use(express.json());

// Node 18+ ima global fetch; ako si na starijem Nodeu, dodaj: import fetch from 'node-fetch';
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const atInd = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID_INDIVIDUAL);
const atGlobal = AIRTABLE_BASE_ID_GLOBAL
  ? new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID_GLOBAL)
  : null;

// -------- Helpers --------
const norm = v => (Array.isArray(v) ? v[0] : v ?? '').toString();

function normSlug(v) {
  return norm(v).trim().toLowerCase();
}

// sigurna zamjena placeholdera {A.B.C} -> vrijednost iz objekta data
function fillPlaceholders(template, data) {
  if (!template) return '';
  return template.replace(/\{([\w.]+)\}/g, (_, path) => {
    const parts = path.split('.');
    let val = data;
    for (const p of parts) val = (val && val[p] !== undefined) ? val[p] : '';
    return (val ?? '').toString();
  });
}

// pomaže da ne ubacimo navodnike u filterByFormula
function sanitizeForFormula(s) {
  return norm(s).replace(/"/g, '').replace(/'/g, "’");
}

function listVehicles(vozni, wantedKat) {
  if (!vozni?.length) return '';
  const rows = vozni
    .filter(v => {
      const kat = norm(v['Kategorija'] || v['Namjena (kategorija)'] || v['Kategorija_ref']).toUpperCase();
      return wantedKat ? kat.includes(wantedKat) : true;
    })
    .map(v => {
      const kat = norm(v['Kategorija'] || v['Namjena (kategorija)'] || v['Kategorija_ref']);
      const model = norm(v['Naziv vozila'] || v['Model'] || v['Naziv']);
      const tip = norm(v['Tip vozila'] || v['Tip'] || v['Vrsta vozila']);
      const god = norm(v['Godina']);
      const mjenjac = norm(v['Mjenjač'] || v['Mjenjac']);
      return `• ${kat ? `[${kat}] ` : ''}${model || tip}${god ? ' (' + god + ')' : ''}${mjenjac ? ' – ' + mjenjac : ''}`;
    });
  return rows.slice(0, 20).join('\n');
}

function findLocation(lokacije, needle) {
  if (!lokacije?.length) return '';
  const row = lokacije.find(l => {
    const t = norm(l['Tip lokacije'] || l['Tip'] || l['Vrsta']).toLowerCase();
    return t.includes(needle);
  });
  if (!row) return '';
  const naziv = norm(row['Naziv ustanove / partnera'] || row['Naziv'] || 'Lokacija');
  const adresa = norm(row['Adresa'] || row['Lokacija']);
  const grad = norm(row['Grad']);
  const url = norm(row['Geo_URL'] || row['URL'] || row['Maps']);
  return `${naziv}${adresa ? ', ' + adresa : ''}${grad ? ', ' + grad : ''}${url ? ' | Mapa: ' + url : ''}`;
}

function uvjetiText(uvjeti) {
  if (!uvjeti?.length) return '';
  const first = uvjeti[0];
  const explicit = norm(first['Opis uvjeta']);
  if (explicit) return explicit;
  return [
    first['Načini_plaćanja'] ? `Načini plaćanja: ${first['Načini_plaćanja']}` : '',
    first['Rate_mogućnost'] ? `Rate: ${first['Rate_mogućnost']}` : '',
    first['Avans'] ? `Avans: ${first['Avans']}` : '',
    first['Rokovi'] ? `Rokovi: ${first['Rokovi']}` : ''
  ].filter(Boolean).join(' | ');
}

// dohvat škole po slugu
async function getSchoolRow(slug) {
  const safeSlug = sanitizeForFormula(slug || DEFAULT_SLUG);
  try {
    // pokušaj različite nazive polja sa slugom
    const candidates = [
      '{Slug (autoškola)}',
      '{Slug (Autoškola)}',
      '{slug (autoškola)}',
      '{Slug}'
    ];
    for (const field of candidates) {
      const recs = await atInd('AUTOŠKOLE')
        .select({ filterByFormula: `${field} = "${safeSlug}"`, maxRecords: 1 })
        .all();
      if (recs?.[0]) return recs[0].fields || {};
    }
    // fallback: vrati prvu školu (bolje nego ništa)
    const any = await atInd('AUTOŠKOLE').select({ maxRecords: 1 }).all();
    return any?.[0]?.fields || {};
  } catch (e) {
    console.warn('AUTOŠKOLE_WARN', e.message);
    return {};
  }
}

// dohvat tablice po slugu (univerzalno)
async function getTableBySlug(tableName, slug) {
  const safeSlug = sanitizeForFormula(slug || DEFAULT_SLUG);
  try {
    try {
      const filtered = await atInd(tableName)
        .select({ filterByFormula: `{Slug} = "${safeSlug}"`, maxRecords: 200 })
        .all();
      if (filtered?.length) return filtered.map(r => r.fields);
    } catch {/* ignore and fallback */}
    const recs = await atInd(tableName).select({ maxRecords: 200 }).all();
    const rows = recs.map(r => r.fields).filter(f => {
      const s = normSlug(f?.Slug || f?.['Slug (autoškola)'] || f?.['Slug (Autoškola)'] || f?.['slug (autoškola)']);
      return s === normSlug(safeSlug);
    });
    return rows.length ? rows : recs.map(r => r.fields);
  } catch (e) {
    console.warn('TABLE_WARN', tableName, e.message);
    return [];
  }
}

// GLOBAL: izlistaj sve tablice i napravi jednostavne “title/body” blokove
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
      } catch (e) {
        console.warn('GLOBAL_TABLE_WARN', t.name, e.message);
      }
    }
    return { globalRules: results };
  } catch (e) {
    console.warn('GLOBAL_META_WARN', e.message);
    return { globalRules: [] };
  }
}

// ciljano generiranje “činjenica” za često tražene pojmove u upitu
function extractFacts(userText, data, school) {
  const t = norm(userText).toLowerCase();

  // adresa škole / lokacija
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

  // poligon
  if (t.includes('poligon') || t.includes('vježbalište') || t.includes('vjezbalište')) {
    const pol = findLocation(data.lokacije, 'poligon');
    if (pol) return `POLIGON:\n• ${pol}`;
  }

  // prva pomoć
  if (t.includes('prva pomoć') || t.includes('prve pomoći') || t.includes('prve pomoci')) {
    const pp = findLocation(data.lokacije, 'prva pomoć') || norm(data.nastava?.[0]?.['Prva_pomoć_opis']);
    if (pp) return `PRVA POMOĆ:\n• ${pp}`;
  }

  // plaćanje / rate
  if (t.includes('kartic') || t.includes('rate') || t.includes('plaćan') || t.includes('placan')) {
    const u = uvjetiText(data.uvjeti);
    if (u) return `UVJETI PLAĆANJA:\n${u}`;
  }

  // vozni park (prepoznaj kategoriju)
  if (t.includes('voz') || t.includes('vozila') || t.includes('vozni park')) {
    let kat = '';
    for (const k of ['am', 'a1', 'a2', 'a', 'b', 'c', 'ce', 'd']) {
      if (t.includes(` ${k} `) || t.endsWith(` ${k}`) || t.startsWith(`${k} `)) { kat = k.toUpperCase(); break; }
    }
    const list = listVehicles(data.vozni, kat);
    if (list) return `VOZNI PARK${kat ? ` – Kategorija ${kat}` : ''}:\n${list}`;
  }

  return '';
}

// slaganje system promp ta
function buildSystemPrompt(school, data, globalBlocks, facts) {
  const persona = norm(school['AI_PERSONA'] || 'Smiren, stručan instruktor koji jasno i praktično objašnjava.');
  const ton = norm(school['AI_TON'] || 'prijateljski, jasan, bez žargona');
  const stil = norm(school['AI_STIL'] || 'kratki odlomci; konkretni odgovori; CTA gdje ima smisla');
  const pravila = norm(school['AI_PRAVILA'] || 'Primarno odgovaraj o ovoj autoškoli i ne izmišljaj podatke.');
  const uvod = norm(school['AI_POZDRAV'] || 'Bok! 👋 Kako ti mogu pomoći oko upisa, cijena ili termina?');

  const kategorije = (data.kategorije || []).map(k =>
    `• ${norm(k['Kategorija'] || k['Kategorija_ref'] || k['Naziv'])}: Teorija ${k['Broj_sati_teorija'] ?? '-'}h | Praksa ${k['Broj_sati_praksa'] ?? '-'}h | Paket ${k['Cijena_paketa'] ?? '-'} | Dodatni sat ${k['Cijena_dodatni_sat'] ?? '-'}`
  ).join('\n');

  const cjenik = (data.cjenik || []).map(c =>
    `• ${norm(c['Naziv_paketa'] || c['Naziv'])} (${norm(c['Kategorija_ref'] || c['Kategorija'])}) – ${norm(c['Cijena']) || '-'} | Uključeno: ${norm(c['Što_uključeno'] || c['Sto_ukljuceno'])} | Uvjeti: ${norm(c['Uvjeti'])}`
  ).join('\n');

  const naknade = (data.naknade || []).map(n =>
    `• ${norm(n['Naziv_naknade'] || n['Naziv'])}: ${norm(n['Iznos']) || '-'} (${norm(n['Kome_se_plaća'] || n['Kome se plaća'] || n['Tko'])}) – ${norm(n['Opis'])}`
  ).join('\n');

  const uvjeti = uvjetiText(data.uvjeti);
  const dodatne = (data.dodatne || []).map(d => `• ${norm(d['Naziv'])}: ${norm(d['Opis'])} (${norm(d['Cijena']) || '-'})`).join('\n');

  const vozniPark = listVehicles(data.vozni, '');
  const poligon = findLocation(data.lokacije, 'poligon');

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

=== Ponuda po kategorijama ===
${kategorije || '(nema podataka)'}

=== Cjenik i pravila ===
${cjenik || '(nema podataka)'}

=== Uvjeti plaćanja ===
${uvjeti || '(nema podataka)'}

=== Naknade za polaganje ===
${naknade || '(nema podataka)'}

=== Dodatne usluge ===
${dodatne || '(nema podataka)'}

=== Vozni park (sažetak) ===
${vozniPark || '(nema podataka)'}

=== Poligon (sažetak) ===
${poligon || '(nema podataka)'}

=== Globalni vodiči (opće) — koristi samo ako Individual nema podatak ===
${globalJoined || '(—)'}

Otvarajući pozdrav: ${uvod}
`.trim();
}

// -------- API --------

// Health
app.get('/api/health', (_, res) => res.json({ ok: true }));

// Debug – pokazuje slug, matched tablice i sample polja
app.get('/api/debug', async (req, res) => {
  try {
    const slug = normSlug(req.query.slug || req.headers['x-school-slug'] || DEFAULT_SLUG);
    const school = await getSchoolRow(slug);

    const tabs = [
      'KATEGORIJE AUTOŠKOLE', 'CJENIK I PRAVILA', 'NAKNADE ZA POLAGANJE',
      'UVJETI PLAĆANJA', 'DODATNE USLUGE', 'NASTAVA & PREDAVANJA',
      'UPIŠI SE ONLINE', 'VOZNI PARK', 'LOKACIJE & PARTNERI'
    ];

    const out = { slug, schoolName: school?.['Naziv'] || null, tables: {}, samples: {} };

    for (const t of tabs) {
      const all = await atInd(t).select({ maxRecords: 200 }).all();
      const slugs = Array.from(new Set(all.map(r =>
        normSlug(r.fields?.Slug || r.fields?.['Slug (autoškola)'] || r.fields?.['Slug (Autoškola)'] || r.fields?.['slug (autoškola)'])
      ).filter(Boolean)));
      const filtered = await getTableBySlug(t, slug);
      out.tables[t] = { total: all.length, matched: filtered.length, slugsFound: slugs };
      out.samples[t] = filtered.slice(0, 2).map(r => Object.fromEntries(Object.entries(r).slice(0, 10)));
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Glavni endpoint – podržava POST (JSON) i GET (za brzo testiranje)
app.all('/api/ask', async (req, res) => {
  try {
    const userMessage =
      (req.method === 'GET' ? req.query.q : req.body?.q || req.body?.message) || '';
    const history = (req.method === 'GET' ? [] : (req.body?.history || [])).slice(-12);
    if (!userMessage) return res.status(400).json({ ok: false, error: 'Missing message (q)' });

    // slug prioritet: query > header > .env
    const slug = normSlug(req.query.slug || req.headers['x-school-slug'] || DEFAULT_SLUG);

    // 1) Škola (individual)
    const school = await getSchoolRow(slug);
    const safeSchool = (school && Object.keys(school).length) ? school : {
      'AI_PERSONA': 'Smiren, stručan instruktor.',
      'AI_TON': 'prijateljski, jasan',
      'AI_STIL': 'kratki odlomci; konkretno',
      'AI_PRAVILA': 'Odgovaraj prvenstveno o autoškoli.',
      'AI_POZDRAV': 'Bok! Kako ti mogu pomoći?',
      'Telefon': '', 'Email': '', 'Web': '', 'Radno_vrijeme': ''
    };

    // 2) INDIVIDUAL tablice za ovu školu
    const [
      kategorije, cjenik, naknade, uvjeti, dodatne, nastava, upisi, vozni, lokacije
    ] = await Promise.all([
      getTableBySlug('KATEGORIJE AUTOŠKOLE', slug),
      getTableBySlug('CJENIK I PRAVILA', slug),
      getTableBySlug('NAKNADE ZA POLAGANJE', slug),
      getTableBySlug('UVJETI PLAĆANJA', slug),
      getTableBySlug('DODATNE USLUGE', slug),
      getTableBySlug('NASTAVA & PREDAVANJA', slug),
      getTableBySlug('UPIŠI SE ONLINE', slug),
      getTableBySlug('VOZNI PARK', slug),
      getTableBySlug('LOKACIJE & PARTNERI', slug)
    ]);
    const data = { kategorije, cjenik, naknade, uvjeti, dodatne, nastava, upisi, vozni, lokacije };

    // 3) GLOBAL blokovi (opći sadržaji)
    const globalBlocks = await getGlobalBlocks();

    // 4) Činjenice ciljane na ovaj upit (adresa, poligon, prva pomoć, vozila...)
    const facts = extractFacts(userMessage, data, safeSchool);

    // 5) System prompt
    const systemPrompt = buildSystemPrompt(safeSchool, data, globalBlocks, facts);

    // 6) FAQ (GLOBAL → ako ima tablicu FAQ – Pitanja kandidata s AI_ACTIVE viewom i AI_INDEX formulom)
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

    // 7) Poziv prema LLM-u
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
- Ako traži kontakt: daj tel, mob, email + link na kontakt formu.
- Ako pita cijenu: prikaži prvo mjesečni iznos ≈ cijena/12 (zaokruži), zatim puni iznos.
- Uz cijenu dodaj satnicu (PPSP, PP, UV, VOŽNJA) ako postoji.
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
    if (upisi?.[0]?.['URL_forme']) {
      cta = { text: upisi?.[0]?.['CTA_tekst'] || 'Upiši se online', url: upisi?.[0]?.['URL_forme'] };
    }

    res.json({ ok: true, slug, answer, cta });
  } catch (err) {
    console.error('ASK_ERROR', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// -------- START --------
app.listen(PORT, () => {
  console.log(`✅ AI Testigo agent radi na portu :${PORT}`);
});
