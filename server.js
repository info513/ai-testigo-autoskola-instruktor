// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Airtable from 'airtable';
import OpenAI from 'openai';

const {
  PORT = 8080,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID_INDIVIDUAL,
  AIRTABLE_BASE_ID_GLOBAL,
  SCHOOL_SLUG = 'instruktor'
} = process.env;

if (!OPENAI_API_KEY || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID_INDIVIDUAL) {
  console.error('❗ Nedostaju env varijable: OPENAI_API_KEY, AIRTABLE_API_KEY ili AIRTABLE_BASE_ID_INDIVIDUAL');
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

const ai = new OpenAI({ apiKey: OPENAI_API_KEY });
const atIndividual = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID_INDIVIDUAL);
const atGlobal = AIRTABLE_BASE_ID_GLOBAL
  ? new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID_GLOBAL)
  : null;

/* ---------------- Helpers ---------------- */

function normSlug(v){ if(Array.isArray(v)) v = v[0]; return (v ?? '').toString().trim().toLowerCase(); }
function getSlugFromFields(f){
  return normSlug(
    f?.Slug ?? f?.slug ?? f?.['Slug (autoškola)'] ?? f?.['Slug (Autoškola)'] ?? f?.['slug (autoškola)']
  );
}

async function getSchoolRow() {
  try {
    const recs = await atIndividual('AUTOŠKOLE')
      .select({ filterByFormula: `{Slug (autoškola)} = "${SCHOOL_SLUG}"`, maxRecords: 1 })
      .all();
    return recs[0]?.fields || {};
  } catch (e) {
    console.warn('AUTOŠKOLE_WARN', e.message);
    return {};
  }
}

/** tolerantni dohvat tablice po slugu */
async function getTableBySlug(tableName) {
  try {
    // 1) pokušaj direktno po {Slug}
    try {
      const filtered = await atIndividual(tableName)
        .select({ filterByFormula: `{Slug} = "${SCHOOL_SLUG}"`, maxRecords: 200 })
        .all();
      if (filtered?.length) return filtered.map(r => r.fields);
    } catch {}
    // 2) fallback – povuci sve, lokalno filtriraj po više naziva
    const recs = await atIndividual(tableName).select({ maxRecords: 200 }).all();
    const rows = recs.map(r => r.fields).filter(f => getSlugFromFields(f) === SCHOOL_SLUG);
    return rows.length ? rows : recs.map(r => r.fields);
  } catch (e) {
    console.warn('TABLE_WARN', tableName, e.message);
    return [];
  }
}

/** GLOBAL – čitamo sve tablice i radimo jednostavne Q/A blokove za opće stvari */
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
          const body  = f['Opis'] || f['Sadržaj'] || f['Answer'] || f['Objašnjenje'] || '';
          if (title || body) results.push({ title: String(title), body: String(body) });
        }
      } catch (e) { console.warn('GLOBAL_TABLE_WARN', t.name, e.message); }
    }
    return { globalRules: results };
  } catch (e) {
    console.warn('GLOBAL_META_WARN', e.message);
    return { globalRules: [] };
  }
}

/* ---------- ciljano izvlačenje činjenica za česta pitanja ---------- */
function listVehicles(vozni, wantedKat) {
  if (!vozni?.length) return '';
  const rows = vozni.filter(v => {
    const kat = (v['Kategorija'] || v['Namjena (kategorija)'] || v['Kategorija_ref'] || '').toString();
    return wantedKat ? kat.includes(wantedKat) : true;
  }).map(v => {
    const kat = v['Kategorija'] || v['Namjena (kategorija)'] || v['Kategorija_ref'] || '';
    const model = v['Naziv vozila'] || v['Model'] || v['Naziv'] || '';
    const tip   = v['Tip vozila'] || v['Tip'] || v['Vrsta vozila'] || '';
    const god   = v['Godina'] || '';
    const mjenjac = v['Mjenjač'] || v['Mjenjac'] || '';
    return `• ${kat ? `[${kat}] ` : ''}${model || tip}${god ? ' ('+god+')' : ''}${mjenjac ? ' – '+mjenjac : ''}`;
  });
  return rows.slice(0,20).join('\n');
}
function findLocation(lokacije, needle){
  if(!lokacije?.length) return '';
  const row = lokacije.find(l=>{
    const t = (l['Tip lokacije'] || l['Tip'] || l['Vrsta'] || '').toString().toLowerCase();
    return t.includes(needle);
  });
  if(!row) return '';
  const naziv  = row['Naziv ustanove / partnera'] || row['Naziv'] || 'Lokacija';
  const adresa = row['Adresa'] || row['Lokacija'] || '';
  const grad   = row['Grad'] || '';
  const url    = row['Geo_URL'] || row['URL'] || row['Maps'] || '';
  return `${naziv}${adresa ? ', '+adresa : ''}${grad ? ', '+grad : ''}${url ? ' | Mapa: '+url : ''}`;
}
function uvjetiText(uvjeti){
  if(!uvjeti?.length) return '';
  const first = uvjeti[0];
  return first['Opis uvjeta'] || [
    first['Načini_plaćanja'] ? `Načini plaćanja: ${first['Načini_plaćanja']}` : '',
    first['Rate_mogućnost']  ? `Rate: ${first['Rate_mogućnost']}` : '',
    first['Avans']           ? `Avans: ${first['Avans']}` : '',
    first['Rokovi']          ? `Rokovi: ${first['Rokovi']}` : ''
  ].filter(Boolean).join(' | ');
}

/** napravi “ČINJENICE ZA ODGOVOR” za konkretno korisničko pitanje */
function extractFacts(userText, data, school){
  const t = (userText || '').toLowerCase();

  // adresa škole
  if (t.includes('adresa') || t.includes('gdje ste') || t.includes('gdje se nalazite')) {
    const adr = school?.['Adresa'] || '';
    if (adr) return `ADRESA AUTOŠKOLE:\n• ${adr}`;
    const alt = findLocation(data.lokacije, 'autoškola') || findLocation(data.lokacije, 'ured');
    if (alt) return `ADRESA AUTOŠKOLE:\n• ${alt}`;
  }

  // poligon
  if (t.includes('poligon')) {
    const pol = findLocation(data.lokacije, 'poligon');
    if (pol) return `POLIGON:\n• ${pol}`;
  }

  // prva pomoć
  if (t.includes('prva pomoć') || t.includes('prve pomoći')) {
    const pp = findLocation(data.lokacije, 'prva pomoć') || data.nastava?.[0]?.['Prva_pomoć_opis'] || '';
    if (pp) return `PRVA POMOĆ:\n• ${pp}`;
  }

  // plaćanje / kartice / rate
  if (t.includes('kartic') || t.includes('rate') || t.includes('plaćan') || t.includes('placan')) {
    const u = uvjetiText(data.uvjeti);
    if (u) return `UVJETI PLAĆANJA:\n${u}`;
  }

  // vozila / vozni park (+ kategorija)
  if (t.includes('voz') || t.includes('vozila') || t.includes('vozni park')) {
    let kat = '';
    for (const k of ['am','a1','a2','a','b','c','ce','d']) {
      if (t.includes(` ${k} `) || t.endsWith(` ${k}`) || t.startsWith(`${k} `)) { kat = k.toUpperCase(); break; }
    }
    const list = listVehicles(data.vozni, kat);
    if (list) return `VOZNI PARK${kat?` – Kategorija ${kat}`:''}:\n${list}`;
  }

  return ''; // nema posebnih činjenica – neka model koristi sažetke + global
}

/* ---------- System prompt (primarno Individual, fallback Global) ---------- */
function buildSystemPrompt(school, data, globalBlocks, facts) {
  const persona = school['AI_PERSONA'] || 'Smiren, stručan instruktor koji jasno i praktično objašnjava.';
  const ton     = school['AI_TON']     || 'prijateljski, jasan, bez žargona';
  const stil    = school['AI_STIL']    || 'kratki odlomci; konkretni odgovori; CTA gdje ima smisla';
  const pravila = school['AI_PRAVILA'] || 'Primarno odgovaraj o ovoj autoškoli i ne izmišljaj podatke.';

  const uvod    = school['AI_POZDRAV'] || 'Bok! 👋 Kako ti mogu pomoći oko upisa, cijena ili termina?';

  const kategorije = (data.kategorije || []).map(k =>
    `• ${k['Kategorija'] || k['Kategorija_ref'] || k['Naziv'] || ''}: Teorija ${k['Broj_sati_teorija'] ?? '-'}h | Praksa ${k['Broj_sati_praksa'] ?? '-'}h | Paket ${k['Cijena_paketa'] ?? '-'} | Dodatni sat ${k['Cijena_dodatni_sat'] ?? '-'}``
  ).join('\n');

  const cjenik = (data.cjenik || []).map(c =>
    `• ${c['Naziv_paketa'] || c['Naziv'] || ''} (${c['Kategorija_ref'] || c['Kategorija'] || ''}) – ${c['Cijena'] ?? '-'} | Uključeno: ${c['Što_uključeno'] || ''} | Uvjeti: ${c['Uvjeti'] || ''}`
  ).join('\n');

  const naknade = (data.naknade || []).map(n =>
    `• ${n['Naziv_naknade'] || n['Naziv'] || ''}: ${n['Iznos'] ?? '-'} (${n['Kome_se_plaća'] || n['Tko'] || ''}) – ${n['Opis'] || ''}`
  ).join('\n');

  const uvjeti = uvjetiText(data.uvjeti);
  const dodatne = (data.dodatne || []).map(d => `• ${d['Naziv'] || ''}: ${d['Opis'] || ''} (${d['Cijena'] ?? '-'})`).join('\n');

  const vozniPark = listVehicles(data.vozni, '');
  const poligon   = findLocation(data.lokacije, 'poligon');

  const globalJoined = (globalBlocks.globalRules || []).map(g => `• ${g.title}: ${g.body}`).join('\n');

  return `
Ti si AI asistent autoškole.

**Politika odgovaranja (vrlo važno):**
1) **Prvo** koristi podatke iz baze **AI TESTIGO – Individualni podatci** (sekcije niže i/ili ČINJENICE ZA ODGOVOR).
2) **Ako u Individualnoj bazi nema odgovora**, smiješ i trebaš koristiti **GLOBALNE VODIČE** (sekcija "Globalni vodiči (opće)").
3) Ako nema ni tamo, reci da trenutačno nemaš taj podatak i ponudi kontakt. Nikada ne izmišljaj.

Osobnost: ${persona}
Ton: ${ton}
Stil: ${stil}
Pravila: ${pravila}

Kontakt: ${school['Telefon'] || ''} | ${school['Email'] || ''} | ${school['Web'] || ''} | Radno vrijeme: ${school['Radno_vrijeme'] || ''}

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

=== Globalni vodiči (opće) — koristi ih samo ako Individual nema podatak ===
${globalJoined || '(—)'}

Otvarajući pozdrav: ${uvod}
`.trim();
}

/* ---------------- API ---------------- */

app.post('/api/ask', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message) return res.status(400).json({ ok: false, error: 'Missing message' });

    const school = await getSchoolRow();
    const safeSchool = (school && Object.keys(school).length) ? school : {
      'AI_PERSONA': 'Smiren, stručan instruktor.',
      'AI_TON': 'prijateljski, jasan',
      'AI_STIL': 'kratki odlomci; konkretno',
      'AI_PRAVILA': 'Odgovaraj prvenstveno o autoškoli.',
      'AI_POZDRAV': 'Bok! Kako ti mogu pomoći?',
      'Telefon': '', 'Email': '', 'Web': '', 'Radno_vrijeme': ''
    };

    const [
      kategorije, cjenik, naknade, uvjeti, dodatne, nastava, upisi,
      vozni, lokacije, globalBlocks
    ] = await Promise.all([
      getTableBySlug('KATEGORIJE AUTOŠKOLE'),
      getTableBySlug('CJENIK I PRAVILA'),
      getTableBySlug('NAKNADE ZA POLAGANJE'),
      getTableBySlug('UVJETI PLAĆANJA'),
      getTableBySlug('DODATNE USLUGE'),
      getTableBySlug('NASTAVA & PREDAVANJA'),
      getTableBySlug('UPIŠI SE ONLINE'),
      getTableBySlug('VOZNI PARK'),
      getTableBySlug('LOKACIJE & PARTNERI'),
      getGlobalBlocks()
    ]);

    const data = { kategorije, cjenik, naknade, uvjeti, dodatne, nastava, upisi, vozni, lokacije };

    // ciljane činjenice za ovo konkretno pitanje
    const facts = extractFacts(message, data, safeSchool);

    const systemPrompt = buildSystemPrompt(safeSchool, data, globalBlocks, facts);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-12),
      { role: 'user', content: message }
    ];

    const completion = await ai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.15
    });

    const answer = completion.choices?.[0]?.message?.content?.trim() || 'Trenutno nemam odgovor.';
    let cta = null;
    if (upisi?.[0]?.['URL_forme']) {
      cta = { text: upisi?.[0]?.['CTA_tekst'] || 'Upiši se online', url: upisi?.[0]?.['URL_forme'] };
    }
    res.json({ ok: true, answer, cta });

  } catch (err) {
    console.error('ASK_ERROR', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

// detaljniji debug – pokazuje i sample vrijednosti
app.get('/api/debug', async (_, res) => {
  try {
    const school = await getSchoolRow();
    const tabs = [
      'KATEGORIJE AUTOŠKOLE','CJENIK I PRAVILA','NAKNADE ZA POLAGANJE',
      'UVJETI PLAĆANJA','DODATNE USLUGE','NASTAVA & PREDAVANJA',
      'UPIŠI SE ONLINE','VOZNI PARK','LOKACIJE & PARTNERI'
    ];

    const out = {
      schoolSlug: school?.['Slug (autoškola)'] || null,
      tables: {},
      samples: {}
    };

    for (const t of tabs) {
      const all = await atIndividual(t).select({ maxRecords: 200 }).all();
      const slugs = Array.from(new Set(all.map(r => getSlugFromFields(r.fields)).filter(Boolean)));
      const filtered = await getTableBySlug(t);
      out.tables[t] = { total: all.length, matched: filtered.length, slugsFound: slugs };
      out.samples[t] = filtered.slice(0,2).map(r => Object.fromEntries(Object.entries(r).slice(0,10)));
    }

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ AI Testigo agent radi na portu :${PORT}`);
});
