import en from '../i18n/en.json'
import pl from '../i18n/pl.json'
import de from '../i18n/de.json'
import es from '../i18n/es.json'

const KOD_URZEDU_KEY = 'financial_pl.jpk.generate.kodUrzeduInvalid'

describe('financial_pl i18n locale parity (QA #42)', () => {
  const base = new Set(Object.keys(en))

  it('every non-English locale defines exactly the same key set as English', () => {
    for (const [name, dict] of Object.entries({ pl, de, es })) {
      const keys = new Set(Object.keys(dict))
      const missing = [...base].filter((k) => !keys.has(k))
      const extra = [...keys].filter((k) => !base.has(k))
      expect({ locale: name, missing, extra }).toEqual({ locale: name, missing: [], extra: [] })
    }
  })

  it('the tax-office-code validation message no longer leaks the Polish "kod urzędu" into en/de/es', () => {
    const dicts: Record<string, Record<string, string>> = {
      en: en as Record<string, string>,
      de: de as Record<string, string>,
      es: es as Record<string, string>,
    }
    for (const [name, dict] of Object.entries(dicts)) {
      expect(`${name}: ${dict[KOD_URZEDU_KEY]}`).not.toContain('kod urzędu')
    }
    // Polish is the one locale where "kod urzędu" is the correct term.
    expect((pl as Record<string, string>)[KOD_URZEDU_KEY]).toContain('kod urzędu')
  })
})
