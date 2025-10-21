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

// “meki” dohvat sporednih tablica (nikad ne ruši)
async function getTableBySlug(tableName) {
  try {
    const recs = await atIndividual(tableName)
      .select({ filterByFormula: `{Slug} = "${SCHOOL_SLUG}"`, maxRecords: 200 })
      .all();
    return recs.map(r => r.fields);
  } catch (e) {
    console.warn('TABLE_WARN', tableName, e.message);
    return [];
  }
}

/**
 * GLOBAL: čita sve tablice dinamički preko Meta API-ja,
 * i iz svake skuplja Q/A u format { title, body }.
 * Polja koja tražimo: “Naziv rubrike / pitanje”, “Naziv”, “Pitanje” (title)
 * i “Opis”, “Sadržaj”, “Answer” (body).
 */
async function getGlobalBlocks() {
  if (!atGlobal || !AIRTABLE_BASE_ID_GLOBAL) return { globalRules: [], glossary: [] };
  try {
    // Meta API – popis tablica
    const metaResp = await fetch(
      `https://api.airtable.com/v0/meta/bases/${AIRTABLE_BASE_ID_GLOBAL}/tables`,
      { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } }
    );
    const meta = await metaResp.json();
    if (!meta?.tables?.length) return { globalRules: [], glossary: [] };

    const results = [];
    for (const t of meta.tables) {
      try {
        const recs = await atGlobal(t.name).select({ maxRecords: 500 }).all();
        for (const r of recs) {
          const f = r.fields || {};
          const title =
            f['Naziv rubrike / pitanje'] ||
            f['Naziv'] ||
            f['Pitanje'] ||
            f['Pojam'] ||
            '';
          const body =
            f['Opis'] ||
            f['Sadržaj'] ||
            f['Answer'] ||
            f['Objašnjenje'] ||
            '';

          if (title || body) {
            results.push({ title: String(title), body: String(body) });
          }
        }
      } catch (e) {
        console.warn('GLOBAL_TABLE_WARN', t.name, e.message);
      }
    }

    // Nema posebne podjele – sve ide u “globalRules”
    return { globalRules: results, glossary: [] };
  } catch (e) {
    console.warn('GLOBAL_META_WARN', e.message);
    return { globalRules: [], glossary: [] };
  }
}

function buildSystemPrompt(school, data, globalBlocks) {
  const persona = school['AI_PERSONA'] || 'Smiren, stručan instruktor koji jasno i praktično objašnjava.';
  const ton = school['AI_TON'] || 'prijateljski, jasan, bez žargona';
  const stil = school['AI_STIL'] || 'kratki odlomci; konkretni odgovori; CTA gdje ima smisla';
  const pravila = school['AI_PRAVILA'] || 'Odgovaraj isključivo o ovoj autoškoli. Ne izmišljaj cijene ni termine.';
  const uvod = school['AI_POZDRAV'] || 'Bok! 👋 Kako ti mogu pomoći oko upisa, cijena ili termina?';

  const kategorije = (data.kategorije || []).map(k =>
    `• ${k['Kategorija'] || k['Kategorija_ref'] || ''}: ${k['Opis'] || ''} | Teorija: ${k['Broj_sati_teorija'] || '-'}h | ` +
    `Praksa: ${k['Broj_sati_praksa'] || '-'}h | Cijena paketa: ${k['Cijena_paketa'] ?? '-'} | Dodatni sat: ${k['Cijena_dodatni_sat'] ?? '-'}`
  ).join('\n');

  const cjenik = (data.cjenik || []).map(c =>
    `• ${c['Naziv_paketa'] || c['Naziv'] || ''} (${c['Kategorija_ref'] || ''}) – ${c['Cijena'] ?? '-'} | ` +
    `Uključeno: ${c['Što_uključeno'] || ''} | Uvjeti: ${c['Uvjeti'] || ''}`
  ).join('\n');

  const naknade = (data.naknade || []).map(n =>
    `• ${n['Naziv_naknade'] || n['Naziv'] || ''}: ${n['Iznos'] ?? '-'} (${n['Kome_se_plaća'] || ''}) – ${n['Opis'] || ''}`
  ).join('\n');

  const uvjeti = (data.uvjeti || []).map(u =>
    `• Plaćanje: ${u['Načini_plaćanja'] || ''} | Rate: ${u['Rate_mogućnost'] || ''} | Avans: ${u['Avans'] || ''} | Rokovi: ${u['Rokovi'] || ''}`
  ).join('\n');

  const dodatne = (data.dodatne || []).map(d =>
    `• ${d['Naziv'] || ''}: ${d['Opis'] || ''} (${d['Cijena'] ?? '-'})`
  ).join('\n');

  const nastava = data.nastava?.[0] || {};
  const teorija = nastava['Teorija_prometni_propisi_opis'] || '';
  const prvaPomoc = nastava['Prva_pomoć_opis'] || '';

  const globalJoined = (globalBlocks.globalRules || [])
    .map(g => `• ${g.title}: ${g.body}`).join('\n');

  return `
Ti si AI asistent autoškole.
Osobnost: ${persona}
Ton: ${ton}
Stil: ${stil}
Pravila: ${pravila}

Kontakt: ${school['Telefon'] || ''} | ${school['Email'] || ''} | ${school['Web'] || ''} | Radno vrijeme: ${school['Radno_vrijeme'] || ''}

=== Ponuda po kategorijama ===
${kategorije || '(nema podataka)'}

=== Cjenik i pravila ===
${cjenik || '(nema podataka)'}

=== Naknade za polaganje ===
${naknade || '(nema podataka)'}

=== Uvjeti plaćanja ===
${uvjeti || '(nema podataka)'}

=== Dodatne usluge ===
${dodatne || '(nema podataka)'}

=== Nastava & predavanja ===
• Teorija: ${teorija}
• Prva pomoć: ${prvaPomoc}

=== GLOBAL – opći vodiči i objašnjenja ===
${globalJoined || '(—)'}

Otvarajući pozdrav: ${uvod}

Upute:
- Ako korisnik pita za upis, ponudi CTA iz "UPIŠI SE ONLINE" ako postoji.
- Ako nema traženih podataka, reci da provjeri s uredom i daj kontakt.
- Odgovaraj sažeto, jasno i lokalno relevantno.
`;
}

/* ---------------- API ---------------- */

app.post('/api/ask', async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (!message) return res.status(400).json({ ok: false, error: 'Missing message' });

    // “safe” škola – da radi i kad Individual još nije popunjen
    const school = await getSchoolRow();
    const safeSchool = (school && Object.keys(school).length) ? school : {
      'AI_PERSONA': 'Smiren, stručan instruktor.',
      'AI_TON': 'prijateljski, jasan',
      'AI_STIL': 'kratki odlomci; konkretno',
      'AI_PRAVILA': 'Odgovaraj isključivo o autoškoli.',
      'AI_POZDRAV': 'Bok! Kako ti mogu pomoći?',
      'Telefon': '', 'Email': '', 'Web': '', 'Radno_vrijeme': ''
    };

    const [kategorije, cjenik, naknade, uvjeti, dodatne, nastava, upisi, globalBlocks] = await Promise.all([
      getTableBySlug('KATEGORIJE AUTOŠKOLE'),
      getTableBySlug('CJENIK I PRAVILA'),
      getTableBySlug('NAKNADE ZA POLAGANJE'),
      getTableBySlug('UVJETI PLAĆANJA'),
      getTableBySlug('DODATNE USLUGE'),
      getTableBySlug('NASTAVA & PREDAVANJA'),
      getTableBySlug('UPIŠI SE ONLINE'),
      getGlobalBlocks()
    ]);

    const systemPrompt = buildSystemPrompt(safeSchool, {
      kategorije, cjenik, naknade, uvjeti, dodatne, nastava, upisi
    }, globalBlocks);

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).slice(-12),
      { role: 'user', content: message }
    ];

    const completion = await ai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.2
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

// brzi dijagnostički endpoint
app.get('/api/debug', async (_, res) => {
  try {
    const school = await getSchoolRow();
    const tabs = ['KATEGORIJE AUTOŠKOLE','CJENIK I PRAVILA','NAKNADE ZA POLAGANJE','UVJETI PLAĆANJA','DODATNE USLUGE','NASTAVA & PREDAVANJA','UPIŠI SE ONLINE'];
    const out = {
      schoolSlug: school?.['Slug (autoškola)'] || null,
      tables: {},
      global: {}
    };
    for (const t of tabs) out.tables[t] = (await getTableBySlug(t)).length;
    const g = await getGlobalBlocks();
    out.global.rules = g.globalRules.length;
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ AI Testigo agent radi na portu :${PORT}`);
});
