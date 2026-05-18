# SPEC-005: Module Documentation Standard

## TLDR

**Key Points:**
- Dokumentacja jest trójpoziomowa: repo root README (tabelka modułów) → `packages/<name>/README.md` (skrócona dokumentacja modułu) → `packages/<name>/docs/*.md` (rozszerzona dokumentacja podzielona na pliki).
- `packages/<name>/README.md` zawiera prawdziwą treść (nie tylko nawigację) — krótkie omówienie modułu, quick start, screenshoty, linki do rozszerzonej docs.
- Wzorcem jest `packages/pdf-generators` — jego `docs/README.md` zostanie rozbity na osobne pliki zgodnie z tym standardem.
- CI blokuje PR jeśli wymagane pliki nie istnieją.

**Scope:**
- Trójpoziomowa hierarchia README: repo → pakiet → docs/
- Standard treści `packages/<name>/README.md` (skrócona dokumentacja)
- Wymagane pliki w `docs/` (rozszerzona dokumentacja)
- GitHub Actions walidacja — blokuje merge gdy brak wymaganych plików

**Concerns:**
- `carrier-inpost` nie ma żadnej dokumentacji — wymaga dopisania od zera
- Podwójny SPEC-004 w `.ai/specs/` — poza scope tej specyfikacji

---

## Overview

Każdy moduł w `offical-modules` jest zewnętrznym rozszerzeniem instalowanym przez deweloperów budujących aplikacje na Open Mercato. Jakość dokumentacji bezpośrednio przekłada się na adoption — moduł bez README to moduł, którego nikt nie zainstaluje bez zaglądania w kod.

Specyfikacja definiuje **wymagany minimalny zestaw dokumentacji** dla każdego pakietu oraz **strukturę katalogową** tak, aby autorzy wiedzieli dokładnie co napisać, a recenzenci i CI wiedzieli co sprawdzić przed mergem.

> **Market Reference**: Wzorowano się na podejściu stosowanym przez Shopify Polaris, Medusa.js i shadcn/ui — każdy z tych projektów posiada spójną strukturę per-pakiet z dokumentacją podzieloną na tematyczne pliki (installation, api, contributing). Odrzucono model monolitycznych wiki (Confluence, Notion) jako nietrwały i oderwany od kodu. Odrzucono też model jednego dużego README.md — przy modułach tej złożoności co pdf-generators szybko staje się nieczytelny.

## Problem Statement

Aktualny stan repozytorium:

| Pakiet | Root README | docs/ | Stan |
|--------|-------------|-------|------|
| `pdf-generators` | brak | `docs/README.md` (monoplik) | Częściowy — brak root README, brak podziału na pliki |
| `carrier-inpost` | brak | brak | Brak dokumentacji |
| `test-package` | brak | brak | Placeholder — wyłączony ze scope |

Brak standardu powoduje:
1. **npm pokazuje pustą stronę** pakietu — `packages/<name>/README.md` jest wymagany przez `npm publish`
2. **Autorzy nie wiedzą co pisać** — każdy wymyśla strukturę od nowa lub nie pisze nic
3. **Recenzenci nie mają checklisty** — PR może być merdżowany bez dokumentacji
4. **Zewnętrzni kontrybutorzy nie mogą się onboardować** — brak contributing guide

## Proposed Solution

Dokumentacja jest zorganizowana w trzech poziomach:

**Poziom 1 — Repo root `README.md`**
Tabelka wszystkich dostępnych modułów z krótkim opisem i linkiem do `packages/<name>/README.md`. Zarządzana przez maintainerów repozytorium.

**Poziom 2 — `packages/<name>/README.md`**
Główna dokumentacja modułu — skrócona, ale zawierająca prawdziwą treść: co robi, jak zainstalować, screenshoty, najważniejsze przykłady użycia. Zawiera sekcję z linkami do `docs/` dla tych którzy potrzebują więcej szczegółów. To jest to co użytkownik widzi na npmjs.com.

**Poziom 3 — `packages/<name>/docs/*.md`**
Rozszerzona dokumentacja podzielona tematycznie na osobne pliki. Linkowana z poziomu 2.

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| `packages/<name>/README.md` zawiera prawdziwą treść, nie tylko nawigację | npm renderuje root README — pusty plik z linkami to złe UX dla potencjalnego użytkownika pakietu |
| `docs/` z osobnymi plikami zamiast jednego `docs/README.md` | Każdy plik ma jednoznaczną odpowiedzialność; linkowanie z zewnątrz do konkretnej sekcji; łatwiejszy przegląd PR |
| Repo root README jako tabelka modułów | Jeden punkt wejścia do całego ekosystemu; GitHub renderuje go automatycznie |
| CI blokuje PR | Wymuszenie bez CI to tylko "sugestia" — dokumentacja zawsze odkładana jest na później |


## User Stories / Use Cases

- **Deweloper instalujący moduł** chce zobaczyć na npmjs.com krótki opis i linki do dokumentacji, żeby ocenić moduł bez zaglądania do kodu.
- **Deweloper integrujący moduł** chce otworzyć `docs/api.md` i znaleźć kompletne API reference z przykładami bez szukania po całym repozytorium.
- **Kontrybutor** chce otworzyć `docs/contributing.md` i wiedzieć jak uruchomić moduł lokalnie i jak dodać nową funkcjonalność.
- **Recenzent PR** chce uruchomić CI i dostać czytelny błąd jeśli wymagana dokumentacja nie istnieje.

## Architecture

Dokumentacja jest statycznym artefaktem repozytorium. Nie wymaga nowych modułów Medusa, encji, ani endpointów. "Komponentami" są: struktura plików, standard treści, i skrypt CI.

### Struktura katalogowa

```
README.md                          ← POZIOM 1 — repo root: tabelka wszystkich modułów

packages/<package-name>/
├── README.md                      ← POZIOM 2 — główna docs modułu (skrócona, z treścią)
├── docs/
│   ├── installation.md            ← POZIOM 3 — krok po kroku: install, register, generate
│   ├── usage.md                   ← POZIOM 3 — integracja zewnętrzna, przykłady
│   ├── api.md                     ← POZIOM 3 — REST endpoints + TypeScript exports
│   ├── contributing.md            ← POZIOM 3 — local setup, package structure
│   └── screenshots/               ← OPCJONALNE — PNG referencjonowane w README lub docs
└── skill/
    └── SKILL.md                   ← OPCJONALNE (WYMAGANE gdy moduł ma rozszerzalny API)
```

### Skill modułu (`skill/SKILL.md`)

Każdy moduł który udostępnia **rozszerzalny API** — tzn. inny moduł może do niego dodawać własną zawartość (szablony, adaptery, handlery, providers) — powinien dostarczać skill który automatyzuje ten proces dla konsumenta.

Skill jest plikiem Markdown instalowanym przez `yarn install-skills` do środowiska LLM dewelopera. Dzięki niemu deweloper może napisać np. `scaffold pdf templates for my module` zamiast ręcznie tworzyć pliki według dokumentacji.

**Kiedy skill jest wymagany:**

- Moduł eksportuje klasę bazową do rozszerzenia (np. `BaseDocumentService`)
- Moduł używa convention file pattern (np. `pdf-generators.ts`, `carrier-rates.ts`)
- Moduł ma precyzyjny schemat plików który konsument musi odtworzyć

**Kiedy skill jest opcjonalny:**

- Moduł nie ma publicznego API do rozszerzenia (działa samodzielnie)
- Integracja ogranicza się do konfiguracji w `src/modules.ts`

**Wymagana zawartość `skill/SKILL.md`:**

```markdown
---
name: <skill-name>          # kebab-case, np. scaffold-pdf-templates
description: <opis>         # jednozdaniowy opis + słowa kluczowe wyzwalające skill
---

# <skill-name>

Co robi skill i kiedy go używać.

## Inputs
Jakie zmienne pyta użytkownika przed generowaniem plików.

## Kroki
Jakie pliki generuje i w jakiej kolejności — z pełnymi szablonami kodu.
```

Wzorzec: `packages/pdf-generators` na branchu `feat/pdf-generators` dostarcza skill `scaffold-pdf-templates` który generuje `DocumentService`, komponent React-PDF i convention file w jednym kroku.

### Poziom 1 — repo root `README.md`

Istniejąca sekcja z tabelką modułów (już jest w repo). Wymaga aktualizacji gdy dodawany jest nowy moduł:

```markdown
## Available modules

| Module | Description | Docs |
|--------|-------------|------|
| [`@open-mercato/pdf-generators`](packages/pdf-generators/README.md) | PDF generation framework | [Docs](packages/pdf-generators/README.md) |
| [`@open-mercato/carrier-inpost`](packages/carrier-inpost/README.md) | InPost carrier integration | [Docs](packages/carrier-inpost/README.md) |
```

### Poziom 2 — `packages/<name>/README.md` — szablon

Zawiera prawdziwą, skróconą treść. Standardowe sekcje:

```markdown
# @open-mercato/<name>

<2-3 zdania: co robi moduł, dla kogo, co dostarcza out-of-the-box.>

---

## Screenshots

<Min. 1 screenshot jeśli moduł ma UI — referencjonowany z docs/screenshots/>

---

## Quick start

\`\`\`bash
yarn mercato module add @open-mercato/<name>
\`\`\`

<Najważniejszy przykład użycia — 1 blok kodu lub opis flow.>

---

## Documentation

- [Installation](docs/installation.md)
- [Usage & Integration](docs/usage.md)
- [API Reference](docs/api.md)
- [Contributing](docs/contributing.md)

---

## License

MIT
```

Rozmiar: **orientacyjnie 50–150 linii**. Jeśli sekcja "Quick start" rozrasta się ponad 1 przykład — przenieś do `docs/usage.md` i zostaw tylko link.

---

## Wymagana zawartość plików

### `docs/installation.md`

Obowiązkowe elementy:

1. **Wymagania** — wersja Open Mercato, peer dependencies (jeśli nieoczywiste)
2. **Instalacja krok po kroku** — `mercato module add`, rejestracja w `src/modules.ts`, `yarn generate`, migracje, weryfikacja
3. **Uprawnienia** — jeśli moduł dodaje nowe ACL features, jak je zsynchronizować z rolami
4. **Weryfikacja** — co sprawdzić żeby potwierdzić że moduł działa

### `docs/usage.md`

Obowiązkowe elementy:

1. **Overview** — co robi moduł z perspektywy użytkownika
2. **Podstawowe przypadki użycia** — z przykładami kodu lub screenshotami
3. **Integracja zewnętrzna** — jak moduł rozszerzać z innego modułu (convention files, extension points)

Opcjonalne:

- **Built-in defaults** — gdy moduł dostarcza gotowe szablony / konfiguracje do nadpisania
- **Configuration** — env vars, ustawienia runtime

### `docs/api.md`

Obowiązkowe elementy (jeśli moduł udostępnia API):

1. **REST Endpoints** — dla każdego endpointu: metoda + ścieżka, opis, request body, response shape, kody błędów
2. **TypeScript exports** — publiczne klasy, funkcje, typy eksportowane z pakietu z opisem

Sekcja może być pusta (z notatką) jeśli moduł nie udostępnia żadnego API.

### `docs/contributing.md`

Obowiązkowe elementy:

1. **Local setup** — jak uruchomić moduł w trybie watch + sandbox
2. **Package structure** — drzewo katalogów `src/` z opisem każdego pliku/folderu
3. **Jak dodać nową funkcjonalność** — przepływ pracy dla najczęstszego przypadku rozszerzenia (np. nowy template, nowy carrier)

---

## Implementation Plan

### Phase 1: Standard i infrastruktura

1. Sfinalizować tę specyfikację (done)
2. Zaktualizować root `AGENTS.md` — dodać sekcję "Documentation Requirements" z linkiem do tej specyfikacji
3. Zaktualizować skill `scaffold-module` — generuje puste szablony wymaganych plików docs podczas scaffoldowania nowej paczki
4. Dodać GitHub Actions workflow `.github/workflows/docs-check.yml` — przy każdym PR sprawdza czy wszystkie wymagane pliki (`README.md`, `docs/installation.md`, `docs/usage.md`, `docs/api.md`, `docs/contributing.md`) istnieją w zmienionych paczkach; blokuje merge jeśli brakuje

### Phase 2: Dokumentacja istniejących pakietów

Każdy istniejący pakiet w `packages/` musi zostać uzupełniony o wymaganą strukturę docs. Każdy pakiet to osobny PR.

Dla `carrier-inpost`:
1. Dodać `packages/carrier-inpost/README.md` (skrócona dokumentacja)
2. Stworzyć `packages/carrier-inpost/docs/installation.md`
3. Stworzyć `packages/carrier-inpost/docs/usage.md`
4. Stworzyć `packages/carrier-inpost/docs/api.md`
5. Stworzyć `packages/carrier-inpost/docs/contributing.md`
6. Zaktualizować repo root `README.md` — dodać link do `carrier-inpost` w tabelce modułów

### File Manifest

| Plik | Akcja | Cel |
|------|-------|-----|
| `AGENTS.md` | Modify | Dodać sekcję Documentation Requirements |
| `.github/workflows/docs-check.yml` | Create | CI walidacja wymaganych plików |
| `packages/carrier-inpost/README.md` | Create | Skrócona dokumentacja modułu (poziom 2) |
| `packages/carrier-inpost/docs/installation.md` | Create | — |
| `packages/carrier-inpost/docs/usage.md` | Create | — |
| `packages/carrier-inpost/docs/api.md` | Create | — |
| `packages/carrier-inpost/docs/contributing.md` | Create | — |
| `README.md` | Modify | Zaktualizować tabelkę modułów z linkiem do carrier-inpost docs |

---

## Risks & Impact Review

### Dług techniczny — carrier-inpost

#### Brak wiedzy o module carrier-inpost
- **Scenario**: Wymagana dokumentacja musi zostać napisana przez kogoś kto rozumie moduł — jeśli oryginalny autor jest niedostępny, maintainer musi zapoznać się z kodem od zera
- **Severity**: Medium
- **Affected area**: `packages/carrier-inpost`
- **Mitigation**: Phase 1 wprost przypisuje stworzenie docs dla carrier-inpost; scaffold-module generuje szablony z placeholder content jako punkt startowy
- **Residual risk**: Jakość dokumentacji carrier-inpost zależy od dostępności autora

### Rozjazd szablonu CI ze strukturą plików

#### Zmiana wymaganej struktury bez aktualizacji CI
- **Scenario**: Ktoś decyduje że `docs/api.md` nie jest wymagany dla prostych modułów bez API, ale CI nadal go wymaga i blokuje PR
- **Severity**: Low
- **Affected area**: Wszystkie nowe PR dodające moduły
- **Mitigation**: Lista wymaganych plików w CI jest zarządzana jako tablica w jednym miejscu w workflow YAML — prosta do edycji
- **Residual risk**: Akceptowalny — prosta zmiana w jednym pliku

---

## Final Compliance Report — 2026-05-18

### AGENTS.md Files Reviewed
- `AGENTS.md` (root)

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | Pakiety w `packages/<name>/` | Compliant | Dotyczy wyłącznie plików docs — nie dodaje kodu poza packages/ |
| root AGENTS.md | Nie modyfikuje core packages | Compliant | Spec nie ingeruje w żaden core package |
| root AGENTS.md | Check `.ai/specs/` before starting | Compliant | Sprawdzono — brak istniejącej spec o dokumentacji |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| File Manifest pokrywa wszystkie pakiety z Problem Statement | Pass | pdf-generators i carrier-inpost |
| Implementation Phases są wykonywalne bez blokowania się | Pass | Phase 1 i 2 są niezależne |
| CI scope odpowiada wymaganym plikom z Architecture | Pass | Sprawdza dokładnie 5 plików z listy |

### Verdict

**Fully compliant** — Approved, ready for implementation.

---

## Changelog

### 2026-05-18
- Pełna specyfikacja po rozstrzygnięciu Open Questions
- Zmiana architektury na trójpoziomową: repo root → `packages/<name>/README.md` (skrócona treść) → `docs/*.md` (rozszerzona)
- `packages/<name>/README.md` zawiera prawdziwą treść, nie tylko nawigację
- CI blokuje PR jeśli brakuje wymaganych plików
