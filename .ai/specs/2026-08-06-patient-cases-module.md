# Patient Cases — Made-to-Order Production for a Person

## TLDR

**Key Points:**
- New community module `@open-mercato/patient-cases` (module ID `patient_cases`) introducing the **case** — one lifecycle binding a person, a series of appointments, and a production order.
- Unlocks made-to-order manufacturing where the subject of the order is a person under GDPR Art. 9: orthotics, prosthetics, dental labs, hearing aids, custom insoles and orthopaedic footwear, bespoke eyewear.

**Scope:**
- `Patient` — record with encrypted PII, hash-based deduplication on a national identifier, fallback identity path.
- `Case` — lifecycle from intake to handover, carrying measurements, product specification, and references to the production and sales orders.
- The **appointment layer** — booking, conflict checking, availability — is *not* specified here. Two documents cover it: **SPEC-008** (PR #33) proposes a generic reservations engine, and **SPEC-009** (PR #53) states this vertical's requirements against whichever engine wins. This document defines only the case's view: an ordered series of reservations it owns the position and numbering of (`CaseBooking`).
- Consent is **not** implemented here — it is consumed from `@open-mercato/forms` (`FormConsentRecord`).

**Concerns:**
- Core has no booking primitive — the reason SPEC-009 exists. Two candidates are already in flight for that layer (SPEC-008, PR #33, and SPEC-009), and nothing in *this* document depends on which wins, which is why they were separated.
- Patient names are **not** searchable, by decision rather than by limitation. Declaring them in `defaultEncryptionMaps` does not break the internal token index — `query_index` tokenizes decrypted content — but that index stores an unkeyed SHA-256 of every token *and of every prefix*, which is reversible offline for a surname. Art. 9 identifiers therefore stay out of it, and patient lookup is exact-match through `hashField` (Q3).

## Open Questions — answered

> The gate this document opened with is **closed**. Q1 moved to SPEC-009 (where the appointment layer belongs); Q2–Q5 were answered by maintainers in review on 2026-08-26. The numbering is deliberately unchanged, so the review conversation keeps its references.
>
> Two answers changed the design and are carried into the body of this document rather than left as notes here: **Q3** (Art. 9 identifiers stay out of the token index) and **Q5** (the clinical-documentation boundary). Two are release conditions rather than design decisions and are tracked under Migration & Compatibility and in the Risk Register: the stable `forms` release behind **Q2**, and the keyed token hash behind **Q3(a)**.

- **Q2 — is `@open-mercato/forms` an acceptable peer dependency, and what does its contract guarantee before 1.0?**
  **Answered: yes to the dependency, with a release gate.** The direction is right and dropping the module-owned consent entity was the right instinct. The release state is not right: on npm the package publishes only `0.0.0-canary.*` and one `0.0.0-develop.*`, and the `latest` dist-tag points at a canary older than the one `canary` points at, so a plain install resolves to a months-old prerelease with no semver signal. The fields this module's GDPR posture rests on therefore carry **no compatibility guarantee today**. Maintainers will cut a stable `0.1.0` of `forms` and declare `subject_type`, `subject_id`, `consent_field_key`, `clause_sha256` and the status set STABLE in `BACKWARD_COMPATIBILITY.md`. **That release is a precondition for the implementation PR, not for this one.** Until it lands, the dependency is pinned to an exact published version and read through `formsConsentRecordService` rather than through the entity — which is what the risk register already required.

- **Q3 — should search tokens derived from Art. 9 names exist at all?**
  **Answered: not as things stand — so they will not.** The premise this question had been narrowed to turned out to be worse than assumed. Raw tokens reach the database only under `OM_SEARCH_STORE_RAW_TOKENS=true`, which defaults to false, so `search_tokens.token` is normally null. But `hashToken` is an unkeyed `sha256(token)` with no salt and no per-tenant context, and `enablePartials` defaults to true, so a surname is stored as its whole prefix ladder — each entry an unkeyed digest of a short string drawn from a small dictionary. That is reversible offline and leaks length on top: `search_tokens` holds a recoverable copy of the names sitting next to the encrypted column, which is the `national_id_hash` pepper finding one layer up.
  **For this module**: Art. 9 identifiers do not enter the token index. Patient lookup stays exact-match through `hashField`, as already specified, and **the exclusion is declared in the module's own search field policy** rather than left to `OM_SEARCH_FIELD_BLOCKLIST`, which is a deployment-level substring match that a module cannot guarantee. This costs the module nothing it had.
  **(a) For the platform**: keying the token hash through the same secret chain as `hashForLookup`, with per-tenant context, behind an opt-in flag — enabling it invalidates existing rows and requires a full reindex. Filed upstream together with `isLookupPepperConfigured()`, since both need one place that answers whether a secret is configured.

- **Q4 — is role-scoped field visibility a platform concern or a module concern?**
  **Answered: module, and the design in this document is the one to ship.** The platform has no field-level read policy anywhere — not in the query engine, not in `makeCrudRoute`, not in custom fields; grants are resource plus action, never column. No platform version is promised, because an honest one has to cover CRUD responses, `query_index` documents, search tokens, exports and AI tools in the same change, or the data leaves through a surface nobody checked. That list is the entry condition on the upstream issue. Here the design stays as specified: a reduced projection in the read path keyed on `patient_cases.view_sensitive`, with measurements behind their own `patient_cases.view_measurements` grant.

- **Q5 — is clinical documentation out of scope?**
  **Answered: confirmed, and the boundary is now stated in the body** (Data Models → *Case*). Measurements, specification, schedule and status are order data. Diagnoses and treatment notes are a different regime — professional secrecy, statutory rather than configurable retention, interoperability with medical systems — and a tenant who needs them gets a separate module referencing `Case` by id, never a column on it.

---

## Overview

`patient_cases` serves organisations that manufacture a made-to-order product **for a specific person**, where the product is derived from that person's measurements and delivered through a sequence of appointments running in parallel with a workshop process.

The target audience is small-to-mid manufacturers in regulated care-adjacent verticals: orthotics and prosthetics, dental laboratories, hearing-aid providers, custom insole and orthopaedic footwear makers, bespoke eyewear. What they share is a shape core cannot express today: an order whose content is body measurements, whose subject is a person under GDPR Art. 9, and whose fulfilment is a visit series (consultation → fitting → trial fitting → finishing → handover → follow-up).

Key benefits: a single case lifecycle instead of a patient record and a schedule stitched together per deployment; encryption, deduplication and retention handled once by the platform instead of re-implemented per integrator; and a production board that can be shown to the workshop floor without exposing patient data.

**Scope boundary.** This document covers the patient record and the case lifecycle. The appointment layer — the entities, the conflict check, the availability computation and the calendar — is out of scope here and is the subject of **SPEC-009**, which states this vertical's requirements against a booking engine; **SPEC-008** (PR #33) proposes such an engine independently. Either can satisfy this document, and both can be reviewed without it. The seam between them is deliberately narrow and stated in Architecture → *The seam with SPEC-009*.

> **Market Reference**: Studied HL7 FHIR (`Patient` / `Schedule` / `Slot` / `Appointment` / `Encounter`), OpenMRS, OpenEMR and Cal.com.
> **Adopted**: the separation of *planned* from *actual* (FHIR keeps `Appointment` apart from `Encounter`) — modelled here as an explicit state machine rather than two entities; the three-way distinction between free, booked and **blocked** time; booking as a multi-actor reservation, since FHIR hangs a schedule off an actor (practitioner, location, device) and a conflict check must therefore cover all of them; booking type as configurable data with its own duration and buffers, as in Cal.com's event types; a nullable national identifier, since no mature system treats one as mandatory; and non-attendance as its own terminal state rather than a cancellation.
> **Rejected**: FHIR conformance as such (this module is FHIR-*shaped*, not FHIR-*conformant* — full resources and terminology bindings are cost without a consumer until data exchange is actually required), the participant confirmation round-trip (`AppointmentResponse` — in a practice the receptionist sets the time), and recurring visits or treatment series.

## Problem Statement

**Core cannot express an appointment.** Verified against the generated module fact-sheets for core 0.6.6, and re-checked against `develop` after the CRM calendar landed: still zero entities named `appointment`, `booking`, `visit` or `slot`. What exists nearby stops short:

| Module | What it owns | What it does not own |
|---|---|---|
| `planner` | `planner_availability_rule_set`, `planner_availability_rule`, `plannerAvailabilityService` | anything booked against that availability |
| `resources` | `resources_resource`, `resources_resource_type` — "assets and resources with scheduling policies" | the schedule itself |
| `staff` | `staff_team_member`, `staff_leave_request`, time entries | who that member is seeing, and when |
| `customers` | 26 CRM entities including `customer_activity`, `customer_interaction` | a person under GDPR Art. 9, and a booked appointment |
| `sales` | orders, fulfilment, billing | an order whose content is body measurements and whose recipient owns them |

**What the CRM calendar is, and is not.** Since 0.6.6 core ships a full-page calendar at `/backend/calendar` (`customers/backend/calendar/page.tsx`). Its own specification is explicit that it adds **"no new entity, no new API route, no schema change"** — it is a read view plus an editor over `CustomerInteraction`, the CRM touchpoint model. It is a genuinely good calendar and it is not a reservation: conflicts are computed client-side over the visible window as advisory badges rather than enforced on write, the actors compared are `ownerUserId` and participant *users* rather than rooms or equipment, there is no availability computation against `planner` rules, and there are no per-type durations or buffers. A double-booked fitting chair has to be a rejected write, not a badge.

The planning primitives exist and are good. What is missing is the entity that consumes them, and the subject the whole cycle organises itself around. The first gap — the booking that consumes the availability — is SPEC-009's subject; the second — the person the cycle organises itself around — is this document's. The table is kept whole here because the two gaps were found together, in one deployment, and neither reads correctly without the other.

**Evidence from a live deployment.** A manufacturer of made-to-measure devices for patients (client anonymised) migrated from a low-code platform to Open Mercato. OM is the system of record there — patient records, measurement charts, a production board, and a workshop tablet with PIN login. Three defects logged during the internal test run before launch map directly onto the gaps above:

1. **The visit calendar** had to be built from scratch, including all conflict and availability handling, because core has no appointment concept.
2. **Terminology drift between "consultation" and "visit"** — not a typo but a symptom. With nothing modelling the difference between a *case* and a *visit within it*, the vocabulary split apart in the code and in conversations with the client. A consultation is in fact one visit type within a case, not a synonym for the case.
3. **Search collided with encryption** — recorded here as a historical observation rather than a standing platform gap. The deployment predates `query_index` decrypting documents before building search tokens; what survives of the problem is the external-engine path and the privacy question in Q3.

A fourth observation concerns access rather than a defect: the owner refused workshop technicians access to sensitive patient data, granting them exactly first name, last name, weight and height. The production board and the tablet went live under that constraint — a field-level requirement on a record that is simultaneously the subject of a production order (Q4).

## Proposed Solution

A community module owning three concepts and duplicating nothing core or another community module already provides.

**`Patient`** — the record. PII declared in `defaultEncryptionMaps`; deduplication on `national_id_hash` with tenant-scoped uniqueness; a fallback identity path (identity document type and number) when no national identifier exists, since foreign patients and newborns are a normal population rather than an edge case.

**`Case`** — one lifecycle from intake to handover, binding the patient, the measurements, the product specification, the visit series, and references to the production and sales orders. Hierarchical numbering is user-visible: case `OL/148/2026`, production order `OL/148/2026/Z`, visits `/1`, `/2`.

**The appointment layer is consumed, not defined here.** A case owns an ordered series of bookings and the user-visible numbering of that series (`/1`, `/2`); the booking primitive itself — its type dictionary, state machine, buffers, participants and availability computation — is SPEC-009's subject. This document treats a booking as an id it references, exactly as it treats a `staff` member or a `sales` order.

**Consent is consumed, not rebuilt.** `@open-mercato/forms` already ships `FormConsentRecord` — a per-subject, per-clause, deliberately PII-free projection keyed by `(organization_id, subject_type, subject_id, form_id, consent_field_key)` with `active` / `superseded` / `revoked` status, materialised by the `forms-consent-projector` subscriber. This module uses it with `subject_type = 'patient_cases.patient'` instead of shipping a parallel consent log (Q2).

### Design Decisions

| Decision | Rationale |
|----------|-----------|
| The **case** is the central entity; the patient record and the booking series are its layers | Modelling the patient record and the appointment as two independent capabilities duplicates the numbering, the vocabulary and the lifecycle in two places — which is the same terminology debt described in the Problem Statement, relocated into the architecture |
| The appointment layer is somebody else's specification | The layer is subject-agnostic and useful beyond this vertical, and an engine for it is already proposed in SPEC-008 (#33). Splitting the *documents* lets this half be answered and built while that question is open, without splitting the *lifecycle*, whose centre stays the case |
| Consent consumed from `forms`, not owned here | `FormConsentRecord` is already subject-agnostic, PII-free and clause-hash-versioned; a second consent log would fragment the audit surface and duplicate GDPR export/erasure that `forms` already implements |
| `measurements` / `specification` as `jsonb` | Their shape depends on the product type and is defined per tenant; individual dimensions are never filtered or sorted on. Everything that *is* filtered on has its own column |
| Every case status change writes a `CaseTransition` row | The status column is never edited without history, which is what makes the lifecycle auditable and reversible |

### Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| Extend `customers` with a "patient" role | Drags an Art. 9 domain into a module built for sales and marketing semantics, and forces patient rows to be special-cased in RBAC and encryption inside a module never designed for it |
| Book onto the CRM calendar (`customers`, `/backend/calendar`) | Its data model is `CustomerInteraction` — a CRM touchpoint whose conflict detection is client-side and advisory, whose actors are users rather than rooms and equipment, and which computes no availability. Storing a fitting there means a reservation nothing enforces, on a subject that is a CRM contact rather than a person under Art. 9. Its *view* layer, however, is reused rather than rebuilt — see UI/UX |
| Model the case as a `sales.order` with extra fields | A sales order has neither a visit series nor measurements as its content, and its recipient is a counterparty rather than the person whose measurements are the subject. The link to sales exists as a reference, not as inheritance |
| Store measurements as `forms` submissions rather than `jsonb` on the case | Tempting once `forms` is a dependency anyway: it would bring versioning (measurements change between fittings), per-form encryption of the content and read auditing for free. Deferred rather than rejected — measurements are the workshop's manufacturing input and want to be a plain readable structure on the case, not a submission to resolve through another module on every board render. Revisit if measurement history becomes a requirement |
| Ship an own `PatientConsent` append-only log | Duplicates `forms.FormConsentRecord`, which is already subject-agnostic and PII-free, and would fragment GDPR export/erasure across two modules |
| Separate *modules* for the patient record and for appointments | Rejected as an early decision, and distinct from the document split adopted here: the numbering, the vocabulary and the lifecycle stay owned by the case, while the booking primitive knows nothing about cases. Where that primitive ends up — SPEC-008's engine, a `planner` contribution, or module-local entities — is answered on its own merits rather than by how this document is filed |

## User Stories / Use Cases

- **A receptionist** wants to open a case for a returning patient without re-entering their details, so that intake takes seconds and no duplicate record is created.
- **A receptionist** wants to reach the booking flow for the next appointment in the series directly from the case timeline, so that the fitting is scheduled while the patient is still at the desk (the booking itself is SPEC-009's).
- **A practice owner** wants a case's planned fitting and handover dates to stay visibly out of date once an appointment is missed, so that nothing quietly runs on a schedule that no longer holds.
- **A practitioner** wants measurements captured on a structured chart with left/right copy, so that the workshop receives unambiguous input rather than a scanned form.
- **A workshop technician** wants to see the case number, the product type and the patient's height and weight on the production board, and nothing else, so that the practice can grant floor access without exposing patient data.
- **A data protection officer** wants every consent event to be queryable per patient with the clause version that was signed, so that an audit can be answered without opening submissions.

## Architecture

The module owns nothing that core already provides. Attending people come from `staff`, the sales link from `sales`, consent from `forms`, and the booking series from whatever the appointment layer turns out to be (SPEC-009). Every one of those links is an indexed plain-`uuid` (or string) column — no ORM relation crosses a module boundary.

```
                 ┌──────────────────────────────────────┐
                 │            patient_cases             │
                 │                                      │
   Patient ──────┤  Case ──┬── CaseTransition           │
   (encrypted)   │         │                            │
                 └───┬─────┴────┬───────────┬───────────┘
                     │          │           │
        forms ───────┘          │           └────── sales
   (consent record)             │              (order reference)
                       staff (practitioner)
                                │
                   ┌────────────┴─────────────┐
                   │  appointment layer       │  ← SPEC-009, gated on its Q1
                   │  (booking series)        │
                   └──────────────────────────┘
```

### The seam with SPEC-009

The two documents meet at exactly one place, and the shape of that seam is what SPEC-009's Q1 decides:

- **The case owns the series and its numbering**, materialised as `CaseBooking` (see Data Models): which reservations belong to the case, in what order, with the position assigned in this module's transaction. `OL/148/2026/1`, `/2` are a view of the case, never of the booking, and the appointment layer defines no numbering format at all.
- **The booking primitive stays subject-agnostic.** Under the generic outcome of Q1 a booking carries a subject reference (`subject_type` / `subject_id`) and knows nothing about cases; the case attaches to the booking rather than the booking reaching into the case.
- **Terminology is mapped, not shared.** This document keeps the domain word — a *visit* — and states that a visit **is** a booking of the configured type for the case's patient. SPEC-009 uses only the neutral word. The mapping lives here, in one sentence, because an unmapped synonym pair is precisely the terminology debt the Problem Statement describes.
- **The two lifecycles stay separate.** The case status machine is specified here; the booking status machine (including non-attendance as its own terminal state) is specified there. Neither document restates the other's.

With `patient_cases` deployed and no appointment layer present, cases still open, progress and hand over; the timeline simply shows no bookings.

**What this vertical needs from whichever booking layer wins.** Stated here because it is the consumer's requirement, not the engine's design, and because it is short enough to check against any candidate:

1. **Minute-level scheduling.** A fitting is at 10:30, not on Tuesday. SPEC-008's MVP is explicit that an hourly timeline is out of scope for now, while noting the model already stores full timestamps.
2. **Per-type duration and buffers.** A consultation, a trial fitting and a handover occupy different amounts of a practitioner's day, and the cleaning gap after a cast is part of the occupancy rather than a display detail.
3. **Several participants in one reservation.** A fitting occupies a practitioner *and* a room *and* sometimes a device; a conflict on any of them is a conflict.
4. **Server-side rejection, not an advisory badge.** Two receptionists booking the same slot must produce a 409, not two bookings and a warning icon.
5. **Non-attendance as its own terminal state**, distinct from cancellation — the two are different business events and collapsing them destroys the metric.
6. **Availability computed against `planner` rules**, so reception can ask for free slots rather than reading occupancy and subtracting mentally.

Items 3 and 4 are schema and write-path decisions: cheap while an engine is still a specification, expensive afterwards. That is the whole reason this list is published now rather than filed as feedback later.

**Write path.** All mutations go through the Command pattern. Multi-phase writes (case scalar changes plus a transition row, or a visit plus its participants) use `withAtomicFlush(em, phases, { transaction: true })`; side effects and cache invalidation run after commit, never inside the flush.

### Commands & Events

- **Commands**: `patient_cases.patient.create` · `patient_cases.patient.update` · `patient_cases.case.create` · `patient_cases.case.transition`
- **Events**: `patient_cases.case.created` · `patient_cases.case.status_changed` · `patient_cases.case.handed_over` · `patient_cases.case.consent_check_bypassed`

Events make the operational metrics — time-to-handover, cases opened through an unconfigured consent gate — measurable without bolting on separate analytics. The scheduling metrics (no-show rate, schedule utilisation) belong to the appointment layer's events in SPEC-009.

### UMES Extension Points

The module is an external extension and modifies no core package.

| Extension point | Use |
|---|---|
| **Event subscribers** | None in v1. `forms.submission.submitted` is deliberately *not* subscribed to — `forms` already projects consent itself and this module reads the projection. The appointment layer's `staff.leave_request.*` subscriber belongs to SPEC-009 |
| **Response enrichers** | Attach the practitioner's display name (from `staff`) to case list responses, instead of joining across modules |
| **Widget injection** | `InjectionDataTableWidget` adding an "Open case" row action to the `sales` order table when an order carries a `patient_cases` reference; `InjectionMenuItemWidget` on `menu:sidebar:main` for the module's pages. Under SPEC-009's generic outcome, the case timeline's booking block is itself a widget injected into the booking detail |
| **API interceptors** | None in v1. Listed explicitly so the absence is a decision, not an omission |
| **Custom entities** | None — all entities are module-owned |

## Data Models

All entities carry the standard columns: `id` (UUID PK), `organization_id`, `tenant_id`, `created_at`, `updated_at`, `deleted_at`, `is_active`, with `organization_id` indexed. Only domain fields are listed below.

Optimistic locking is on by default in the platform (`OM_OPTIMISTIC_LOCK`), so every editable entity here exposes `updated_at` as `updatedAt` in list and detail responses, every edit and delete request carries the expected-version header (`x-om-ext-optimistic-lock-expected-updated-at`), and a stale write returns the platform's own conflict body — `409 { error: 'record_modified', code: 'optimistic_lock_conflict', currentUpdatedAt, expectedUpdatedAt }` (`OPTIMISTIC_LOCK_CONFLICT_ERROR` / `_CODE`, header `x-om-ext-optimistic-lock-expected-updated-at`); the module does not invent an error code of its own. Two receptionists editing one patient record is an ordinary collision in this domain, not a corner case, so the conflict is a documented outcome rather than a surprise.

### Patient (`patient_cases_patients`)
- `first_name`: string — encrypted
- `last_name`: string — encrypted
- `phone`: string, nullable — encrypted
- `email`: string, nullable — encrypted; `email_hash`: string, nullable, indexed
- `national_id`: string, nullable — encrypted; `national_id_hash`: string, nullable, **unique per organization** — index on `(tenant_id, organization_id, national_id_hash)`
- `has_no_national_id`: boolean, default `false`
- `identity_document_type`: string, nullable — `passport` | `other`
- `identity_document_number`: string, nullable — encrypted
- `birth_date`: date, nullable
- `sex`: string, nullable — `female` | `male` | `other` | `unknown`
- `preferred_language`: string(8), nullable — ISO 639-1
- `address_line`, `city`: string, nullable — encrypted
- `postal_code`: string(16), nullable
- `height_cm`, `weight_kg`: int, nullable
- `default_practitioner_id`: string, nullable, indexed — FK id → `staff.staff_team_member`

`national_id_hash` is nullable, so Postgres's `NULL <> NULL` semantics already permit any number of patients without an identifier under a unique index, with no extra schema work.

**Uniqueness is scoped per organization, not per tenant.** Every read path in the platform filters by `organization_id`, so a tenant-wide unique index would let a receptionist in organisation B hit `409 duplicate_national_id` carrying the id of a record they cannot open, cannot read, and are not meant to know exists — intake blocked with no in-product resolution. Scoping the index to the organisation removes the situation instead of specifying a workaround for it. The accepted cost is that one person registered in two organisations of the same tenant is two records, which is what the organisational boundary already means everywhere else in the platform. The lookup endpoint is scoped identically.

### Case (`patient_cases_cases`)
- `case_number`: string(64) — unique per organization
- `patient_id`: string, indexed — FK id → `patient_cases_patients`
- `product_type_id`: string, nullable — FK id → the tenant's product catalogue
- `status`: string — `draft` | `in_progress` | `in_production` | `ready` | `handed_over` | `cancelled`
- `sides`: string, nullable — `left` | `right` | `both`
- `measurements`: jsonb, nullable — shape defined per product type
- `specification`: jsonb, nullable
- `planned_fitting_at`, `planned_handover_at`: timestamptz, nullable
- `practitioner_id`: string, nullable, indexed — FK id → `staff`
- `production_order_ref`: string, nullable
- `sales_order_id`: string, nullable, indexed — FK id → `sales`
- `terms_consent_bypassed`: boolean, default `false` — set when the case was created while no consent source was resolvable

**Clinical documentation is out of scope, and this is where that boundary sits.** `measurements`, `specification`, the schedule and the status are *order* data: what is being made, for whom, to what dimensions, and how far along it is. Diagnoses, treatment notes and anything else a clinician records about a patient's condition belong to a different regime — professional secrecy, statutory rather than tenant-configurable retention, and interoperability obligations with medical systems (in Poland, the EDM/P1 surface). A tenant who needs them gets a separate module referencing `Case` by id. They never become a column here, and no field on this entity may be repurposed to hold them.

### CaseTransition (`patient_cases_case_transitions`)
- `case_id`: string, indexed
- `from_status`, `to_status`: string
- `changed_by`: string — `auth.user` id
- `note`: text, nullable

Append-only. A status is never written without a matching transition row.

### CaseBooking (`patient_cases_case_bookings`)
- `case_id`: string, indexed — FK id → `patient_cases_cases`
- `booking_ref`: string, indexed — the opaque id of a reservation in whichever appointment layer is installed
- `sequence_no`: int — the `/1`, `/2` position within the case
- `unique (case_id, sequence_no)` and `unique (tenant_id, organization_id, booking_ref)`

**A reservation belongs to exactly one case.** The uniqueness on `booking_ref` is scoped to the organisation rather than to the case, which is what enforces it: attaching a reservation already attached elsewhere fails, rather than quietly giving one appointment two meanings. This is a domain rule, not a modelling convenience — a visit exists to answer *what it is for*, and a schedule that cannot tell reception which case a patient is coming about is worse than no schedule. Bilateral work is one case with `sides = 'both'`, which is what that column is for. Two genuinely separate cases mean two appointments even on the same day, and in practice they usually want to be separate anyway: different cases can be handled by different practitioners in different rooms, so they are separate reservations by nature rather than by constraint.

This is the whole of the seam on this side, and it is deliberately three columns. The case owns the *series*: which reservations belong to it and in what order. The appointment layer owns the *reservation*: when it is, who it occupies, what state it is in. Neither stores the other's half.

**Why the link lives here rather than only on the booking.** A booking that carries `(subject_type, subject_id)` back to the case is the natural design and SPEC-009 specifies it, but relying on it alone would make this module unusable with any engine that has no subject field — and it would put the case's numbering inside a table this module does not own. With `CaseBooking` the module works against *any* layer that can hand back an id, including a spreadsheet during migration.

**Nothing about the reservation is copied here** — no start time, no status, no participants. Ordering the timeline therefore costs one read from the appointment layer, which is correct: a cached `starts_at` would be a second source of truth for the one fact most likely to change.

**Series position is assigned by this module, inside the case's own write transaction**, and the unique index is the arbiter. Two receptionists adding a visit to one case at the same moment produce one `/2` and one retry, not two `/2`s. `sequence_no` is never reused after a booking is detached — the numbers a patient has already seen on paperwork stay meaningful.

### Encryption

`src/modules/patient_cases/encryption.ts` declares `defaultEncryptionMaps` for `patient_cases:patient` covering `first_name`, `last_name`, `phone`, `address_line`, `city`, `identity_document_number`, `email` (`hashField: 'email_hash'`) and `national_id` (`hashField: 'national_id_hash'`). Reads go exclusively through `findWithDecryption` / `findOneWithDecryption` with `{ tenantId, organizationId }`.

Deliberately not encrypted: `sex`, `preferred_language`, `postal_code`, `height_cm`, `weight_kg` — classification codes and numbers that must be filtered and grouped on, with no compliance benefit from encryption.

#### Art. 9 identifiers stay out of the search index

`src/modules/patient_cases/search.ts` declares the patient's indexable fields and **excludes `first_name`, `last_name`, `phone`, `email`, `national_id`, `identity_document_number`, `address_line` and `city` from the search source entirely** — not merely from the documents sent to an external engine, but from the internal token index too.

The reason is that `search_tokens` is not the safe half. `hashToken` is an unkeyed `sha256` with no salt and no per-tenant context, and partial matching is on by default, so an indexed surname becomes its entire prefix ladder of unkeyed digests over a small dictionary — recoverable offline, with the ladder leaking length as a bonus. A recoverable copy of the names in a table next to the encrypted column defeats the point of encrypting it (Q3).

Two consequences the implementation must honour:
- **Patients are not fuzzy-searchable.** Reception finds a patient by exact identifier through `hashField`, or by opening the case. This is a product constraint, stated here so it is not discovered as a missing feature.
- **The exclusion lives in the module.** `OM_SEARCH_FIELD_BLOCKLIST` is a deployment-level substring match; a module cannot guarantee a deployment sets it. The module's own field policy is the thing under this module's control, so it is the thing that carries the rule.

If the platform later lands a keyed, per-tenant token hash (filed upstream under Q3(a)), this exclusion becomes a tenant-configurable choice rather than a module constant. Until then it is a constant.

**The case, transition and booking-link entities carry no direct identifiers** — they reference the patient by id. That is deliberately not the same claim as "no personal data": `measurements` and `specification` are body measurements bound to a patient id, i.e. pseudonymised data concerning health. What the absence of direct identifiers buys is narrower and still worth having — the production board and the calendar can be shown to a role holding no right to the patient record. The workshop's access to measurements is justified on its own footing, as processing necessary to manufacture the device, and that justification is exactly what Q4 has to settle.

#### Lookup hashes require a pepper

`hashForLookup(value, context?)` uses a keyed HMAC only when a secret resolves — `LOOKUP_HASH_PEPPER`, then `TENANT_DATA_ENCRYPTION_FALLBACK_KEY`, then `TENANT_DATA_ENCRYPTION_KEY` — and otherwise falls back to `legacyHashForLookup`, an unkeyed SHA-256 of the normalised value. A national identifier has a small, structured search space, so an unkeyed digest is invertible offline against a stolen dump in minutes, which would make the encrypted `national_id` column standing next to it decorative.

As module-level rules:
- A lookup pepper is a **deployment precondition**, stated in the module README and verified at setup time.
- The module refuses to write `national_id_hash` when no secret resolves — failing loudly rather than persisting an invertible digest. Deduplication degrades to the fallback-identity path until the secret is configured.
- Hashes are computed with an explicit context — `hashForLookup(nationalId, 'patient_cases:national_id')` — so the same identifier hashed for another entity is not comparable across tables.
- Lookups match through `lookupHashCandidates(value, context)` rather than a single digest, so rows written before a pepper (or before the context) existed still resolve. Introducing a pepper into a running tenant therefore degrades matching rather than breaking it, and a one-off rehash pass — read through the candidates, rewrite with the current scheme — is part of that tenant's migration, not an afterthought.
- The platform exposes no predicate for "is a lookup pepper configured", so the module resolves the same variable chain itself to decide whether to refuse the write. That duplication is deliberate and worth removing upstream: a small exported helper (`isLookupPepperConfigured()`) would let every module fail the same way rather than each re-implementing the check.

### Consent (external)

Consent state is read from `forms.FormConsentRecord` with `subject_type = 'patient_cases.patient'` and `subject_id = patient.id`. The module stores no consent columns. Opening a case requires an `active` record for the tenant-configured terms clause; processing and marketing consents are read for display and for governing consent-dependent processing, and do **not** gate the record — the lawful basis for holding the documentation is a statutory retention obligation, not a consent the patient could withdraw out from under the practice.

**How such a record comes to exist.** `FormConsentRecord` rows are projected from a form submission and inherit that submission's subject — the projector copies `subjectType` / `subjectId` off the submission — so a row with `subject_type = 'patient_cases.patient'` only ever appears if something creates a submission already bound to the patient. This module therefore owns the binding, not merely the read:
- **At the desk** — the patient record page opens the configured terms form as a submission carrying `subjectType = 'patient_cases.patient'` and `subjectId = patient.id`, and the signature is captured in person.
- **Remotely** — a distribution created from the patient record carries the same subject binding, so the projection lands on the patient when the patient signs.

Nothing is subscribed to on the `forms` side: `forms` projects the record itself and this module reads the projection.

**Read path.** Consent state is read through the DI service `formsConsentRecordService` registered by `forms`, never by querying `forms` entities across the module boundary. Where an HTTP read is needed instead, the route is `GET /api/forms/forms/subjects/{subjectType}/{subjectId}/consents`, guarded by `forms.view` — so the reception and practitioner roles need `forms.view` granted in this module's `setup.ts` alongside its own features.

**A bypassed gate leaves a trace.** When the terms clause is unconfigured or `forms` is absent, case creation proceeds (see the fail-open risk) and records that it did: `Case.terms_consent_bypassed` is set on the row, and `patient_cases.case.consent_check_bypassed` is emitted and recorded through the `audit_logs` `actionLogService`. A setup-time warning does not survive into the record, and "which cases were opened without a consent check" has to be answerable from the data a year later rather than reconstructible from deployment history.

### Retention, Erasure and Access Audit

The Overview promises the platform handles retention once; this is what that means concretely for Art. 9 data.

**How long.** Retention is a per-tenant setting, not a module constant, because the answer depends on what the tenant legally is: a healthcare provider keeping medical documentation (in Poland, a 20-year obligation) or a manufacturer of a made-to-order device, where ordinary limitation and tax periods apply. The module ships no default that pretends to settle that; setup requires the period to be stated explicitly. The basis is statutory, never consent — which is the same distinction that keeps processing consent from gating the record.

**Erasure against a live obligation.** An erasure request is recorded as an event in its own right and answered, not silently refused. Where the retention obligation still runs, GDPR Art. 17(3)(b) governs: the record is soft-deleted and drops out of every operational read immediately, the requester is told the date on which erasure completes, and the anonymisation runs when the obligation lapses. Where no obligation applies, anonymisation runs at once.

**Erasure means anonymisation, not deletion.** Anonymisation clears the encrypted PII columns and both identifier hashes, and drops `measurements` and `specification`; the case keeps its number, product type, dates and status as a de-identified production record. Deleting the case outright would rewrite the manufacturing history for a right that only extends to the personal data.

**Access audit.** Reads of a patient detail record and identifier lookups go to `audit_logs` through its `accessLogService`; list views are not logged. That is a decision rather than an omission — auditing reception's daily list traffic drowns the trail that matters, which is who opened whose record.

## API Contracts

All list/CRUD routes use `makeCrudRoute` with `indexer: { entityType }`. Every route file exports per-method `metadata` (`requireAuth`, `requireFeatures`) and `openApi`.

### Patients
- `GET | POST | PUT | DELETE /api/patient_cases/patients` — features `patient_cases.view` / `.create` / `.edit` / `.delete`
- Request (POST): `{ firstName, lastName, phone?, email?, hasNoNationalId, nationalId?, identityDocumentType?, identityDocumentNumber?, birthDate?, sex?, preferredLanguage?, addressLine?, city?, postalCode?, heightCm?, weightKg?, defaultPractitionerId? }`
- Response: `{ item: Patient }` with encrypted fields decrypted for roles holding `patient_cases.view_sensitive`, and reduced otherwise (Q4) to exactly `firstName`, `lastName`, `heightCm`, `weightKg` — the set the reference deployment's owner granted the workshop floor
- Errors: `409 { error: 'duplicate_national_id', patientId }` · `400 { error: 'identity_inconsistent' }` · `409 { error: 'record_modified', code: 'optimistic_lock_conflict', currentUpdatedAt, expectedUpdatedAt }`

### Patient lookup
- `GET /api/patient_cases/patients/lookup?nationalId=` — feature `patient_cases.view`
- Response: `{ match: { id, displayName } | null }` — always `200`. Advisory before submit; the unique index is the authoritative block.

### Case bookings
- `POST | DELETE /api/patient_cases/cases/:id/bookings` — features `patient_cases.edit`
- Request (POST): `{ bookingRef }` · Response: `{ item: CaseBooking }` with the assigned `sequenceNo`
- Attaches a reservation created in the appointment layer to the case and gives it its position in the series; DELETE detaches without touching the reservation itself, because cancelling a booking is that layer's operation, not this one's.
- Errors: `409 { error: 'booking_already_attached', caseId }` — returned whether the reservation is already on *this* case or on another one, since a reservation belongs to exactly one case · `409 { error: 'sequence_conflict' }` (concurrent attach; the client retries)

### Cases
- `GET | POST | PUT | DELETE /api/patient_cases/cases` — features `patient_cases.view` / `.create` / `.edit` / `.delete`
- Request (POST): `{ patientId, productTypeId?, sides?, plannedFittingAt?, plannedHandoverAt?, practitionerId? }`
- Errors: `422 { error: 'terms_consent_missing' }` when no `active` terms consent record exists for the patient · `409 { error: 'record_modified', code: 'optimistic_lock_conflict', … }`

### Case transition
- `POST /api/patient_cases/cases/:id/transition` — feature `patient_cases.edit`
- Request: `{ toStatus, note? }` · Response: `{ item: Case, transition: CaseTransition }`
- Errors: `409 { error: 'illegal_transition', from, to }`

## Internationalization (i18n)

Keys under `patient_cases.*`, with `en` as the source locale and `pl` shipped alongside (the reference deployment is Polish).

- `patient_cases.page.title`, `patient_cases.page.group`
- `patient_cases.patient.*` — field labels, identity-block copy, masking hint
- `patient_cases.case.*` — status labels, timeline headings
- `patient_cases.consent.*` — copy explaining that processing consent governs optional processing and does not gate the record
- `patient_cases.error.*` — `duplicate_national_id`, `identity_inconsistent`, `terms_consent_missing`, `illegal_transition`, `record_modified` (the optimistic-lock conflict, phrased as "someone else changed this record")

No hardcoded user-facing strings; all copy resolves through `useT()`.

## UI/UX

Backend pages under `/backend/patient-cases`, all sharing one `pageGroup` / `pageGroupKey`. Only the non-obvious parts are described; standard `CrudForm` / `DataTable` patterns are not re-documented.

**Case timeline** — the module's central screen. `FormHeader mode="detail"` with the case status, then the production order and the booking series as items of a single lifecycle under hierarchical numbering. Booking the next appointment is an action on the case, not a separate flow; with no appointment layer installed the block renders an empty state rather than disappearing.

**Patient record** — the identity block carries a "patient has no national identifier" toggle that swaps the identifier field for a fallback document type and number. The identifier field runs a debounced `lookup` with a blocking `Alert` on a match. The consent block renders `forms` consent records read-only, with a link to the signing flow; withdrawal is exactly as much a single click as granting, because asymmetry there is a legal defect rather than a UX one.

**Measurement chart** — a stepped wizard with autosave, left/right side switching and copy-between-sides. Measurements are the content of the case, not an attachment.

**What the reduced field set contains, and why measurements are not in it.** Without `patient_cases.view_sensitive` a caller receives the patient's first name, last name, height and weight, plus the case number and product type from the case — nothing else. `measurements` and `specification` are deliberately excluded even though the workshop is the party that manufactures from them: they are pseudonymised data concerning health, and a production board visible from the shop floor is the wrong surface for a full body profile. Where a workshop genuinely needs dimensions to work, the tenant grants a separate `patient_cases.view_measurements` feature to that role, so the decision is explicit, auditable and revocable per tenant rather than implied by having board access at all.

**Production board** — a `DataTable`-backed board whose stages are per-tenant configurable data. This is the screen the workshop floor sees, and the one that must not display sensitive data (Q4).

**No third calendar.** The repository already carries two calendar surfaces: `@open-mercato/ui/backend/schedule` (`ScheduleGrid`, `ScheduleAgenda`, `ScheduleToolbar`, `ScheduleView`, `recurrence.ts`), and the CRM calendar's own hand-rolled components inside `customers`, written because — per its specification — the `ScheduleItem` model did not fit CRM rendering. This module renders through the `ui` package, which is a package import rather than a cross-module one.

What `ScheduleItem` already gives, checked rather than assumed: `kind: 'availability' | 'event' | 'exception'` — **three** kinds, which is exactly the free / booked / blocked triple this design argues is three different things rather than two. That is a stronger starting point than the design assumed.

What it does not give, and what therefore has to be contributed rather than wished for:
- `status` is `'draft' | 'negotiation' | 'confirmed' | 'cancelled'` — it carries neither `checked_in` nor `no_show`, so the visit state machine either travels in `metadata` or the union gains two members. The second is additive and preferable.
- `subjectType` is a closed `'member' | 'resource'`, and one item carries one subject. A reservation occupying a practitioner *and* a room therefore renders as one item per lane — which is how a resource-lane calendar draws it anyway, so this is a rendering convention to state rather than a blocker.
- Buffers have no representation at all; a buffer band around a block is a new visual affordance.

Extracting the shared half of the CRM calendar into `ui` is worth doing before a fourth calendar appears, and is raised with maintainers rather than assumed here.

`DataTable` hosts keep `entityId` and `extensionTableId` stable (`patient_cases.patient`, `patient_cases.case`) so injection from other modules stays backward-compatible. `pageSize` ≤ 100. Every dialog supports `Cmd/Ctrl+Enter` to submit and `Escape` to cancel; icon-only buttons carry `aria-label`.

### Illustrative mocks

The two screens below are static mocks of the proposed module, rendered with synthetic data and a deliberately generic made-to-measure product. They illustrate the design described above; they are not screenshots of any customer's system. They are linked as pull-request attachments rather than committed under `.ai/specs/`, which is text-only.

**Case timeline** — the case as the parent entity, binding the patient, the production order and the visit series into one lifecycle.

![Case timeline](https://github.com/user-attachments/assets/48b488e1-0f02-4d0c-aae8-ca382f012535)

**Production board** — workshop stages run in parallel with the booking series and feed back into it: sending an item back to modelling moves the planned handover, which moves the appointment.

![Production board](https://github.com/user-attachments/assets/fca693a5-17a7-40a7-a06d-646c548dee90)

## Configuration

- Terms clause binding — tenant setting naming the `forms` form id and `consent_field_key` that count as the practice's terms acceptance. Without it the terms gate is inactive and case creation is not blocked.
- Case-number format — tenant setting; defaults to `{PREFIX}/{SEQ}/{YYYY}`.
- Retention period — tenant setting, required at setup, with no module default (see Data Models → Retention, Erasure and Access Audit).
- Lookup pepper — `LOOKUP_HASH_PEPPER` (or one of the encryption-key fallbacks) is a deployment precondition; without it the module refuses to write identifier hashes and deduplication degrades to the fallback-identity path.

## Migration & Compatibility

- **Additive only.** The module introduces new tables and changes no existing contract or schema. Disabling it touches nothing.
- Migrations are generated with `yarn mercato db:generate` from entity changes; none are hand-written.
- No backfill is required for a new installation. For a tenant migrating from a bespoke implementation, patient import must run before the encryption maps are seeded, or `yarn mercato entities seed-encryption` must be re-run afterwards.
- **Peer dependency**: `@open-mercato/forms` for consent — an official module from this repository, **not part of `@open-mercato/core`**, so installing it is an explicit step for the tenant rather than something the framework brings along. If absent, the terms gate is inactive and the consent block renders an empty state; nothing else degrades. This is the only cross-package dependency.
- **Release precondition (Q2).** The implementation PR waits for a stable `@open-mercato/forms` `0.1.0` declaring `subject_type`, `subject_id`, `consent_field_key`, `clause_sha256` and the consent status set STABLE in `BACKWARD_COMPATIBILITY.md`. Until then the dependency is pinned to an exact published version — never a range — and every read goes through `formsConsentRecordService`, so a column rename is absorbed where it can be and surfaces as a failed gate with a recorded bypass where it cannot.
- **Optional peers**: `staff` (practitioner names), `sales` (order reference), and an appointment layer (the booking series on the case timeline; `CaseBooking` rows simply never get created without one). Each absence degrades one capability and none breaks the schema (see the Risk Register).

## Implementation Plan

### Phase 1: Patient record
1. Scaffold `packages/patient-cases` with the `scaffold-module` skill; `src/modules/patient_cases/` with `index.ts`, `acl.ts`, `setup.ts`.
2. `data/entities.ts` — `Patient`; `data/validators.ts` — identifier normalisation and the `has_no_national_id` ↔ fallback-document branching.
3. `encryption.ts` with the PII map and hash fields; generate the migration.
4. `api/patients/route.ts` via `makeCrudRoute` with `indexer`; `api/patients/lookup/route.ts`.
5. Backend list + record pages with identifier masking and the debounced lookup alert.

**Done when**: a patient with a national identifier cannot be created twice in one organisation (409 carries the existing id); a patient without one saves through the fallback path; identifier hashes are refused when no lookup pepper resolves; a role without `patient_cases.view_sensitive` receives the reduced field set from the API, not a UI-filtered one; a stale edit returns `optimistic_lock_conflict`.

### Phase 2: Case
1. `Case` and `CaseTransition` entities; generate the migration.
2. Case create/update commands; `api/cases/route.ts`.
3. `api/cases/[id]/transition/route.ts` with the state machine and `patient_cases.case.status_changed`.
4. Measurements and specification editing with autosave and left/right copy.
5. Case timeline page.
6. `forms` consent integration — terms gate on case creation, consent block on the record page.

**Done when**: every status change has a matching `CaseTransition` row and no illegal transition is accepted; case creation without an active terms consent returns 422, and creation through an open gate sets `terms_consent_bypassed` and emits the audit event; left/right measurement copy is independent after the copy.

### File Manifest

| File | Action | Purpose |
|------|--------|---------|
| `packages/patient-cases/package.json` | Create | `@open-mercato/patient-cases`, publishable |
| `packages/patient-cases/src/index.ts` | Create | Barrel exporting module metadata |
| `.../modules/patient_cases/index.ts` | Create | `ModuleInfo` metadata |
| `.../modules/patient_cases/acl.ts` | Create | `view`, `create`, `edit`, `delete`, `view_sensitive`, `view_measurements` |
| `.../modules/patient_cases/setup.ts` | Create | `defaultRoleFeatures` (including `forms.view` for reception and practitioner roles), required retention setting |
| `.../modules/patient_cases/encryption.ts` | Create | `defaultEncryptionMaps` |
| `.../modules/patient_cases/search.ts` | Create | Search field policy excluding Art. 9 identifiers from the token index (Q3) |
| `.../modules/patient_cases/events.ts` | Create | `createModuleEvents` declarations |
| `.../modules/patient_cases/data/entities.ts` | Create | 4 entities |
| `.../modules/patient_cases/data/validators.ts` | Create | Zod schemas; types via `z.infer` |
| `.../modules/patient_cases/data/enrichers.ts` | Create | Practitioner display names |
| `.../modules/patient_cases/api/**/route.ts` | Create | 5 route files |
| `.../modules/patient_cases/backend/**` | Create | List, record, timeline, measurement chart, board |
| `.../modules/patient_cases/widgets/injection-table.ts` | Create | Sales row action, sidebar menu item |
| `.../modules/patient_cases/i18n/{en,pl}.json` | Create | Locale dictionaries |

### Testing Strategy

- **Unit**: identifier normalisation and fallback branching; the case state machine including every illegal transition; the refusal to write an identifier hash with no lookup pepper configured; hash-candidate matching across the pepper migration.
- **Integration**: duplicate identifier returns 409 with the existing id within one organisation and no 409 across organisations; fallback-identity patients save without a uniqueness check; case creation without an active terms consent returns 422 and, through an open gate, sets `terms_consent_bypassed`; a stale edit returns `record_modified`; a user lacking `patient_cases.view_sensitive` receives the reduced field set.
- **Sandbox**: install the preview build into `apps/sandbox`, run migrations, walk the intake → case → measurements → handover path.

### Integration Coverage

| Surface | Covered by |
|---|---|
| `GET/POST/PUT/DELETE /api/patient_cases/patients` | TC-PC-001 (CRUD + dedup 409) |
| `GET /api/patient_cases/patients/lookup` | TC-PC-002 (match / no match / failure fail-open) |
| `GET/POST/PUT/DELETE /api/patient_cases/cases` | TC-PC-003 (CRUD + terms gate 422) |
| `POST /api/patient_cases/cases/:id/transition` | TC-PC-004 (legal + illegal transitions) |
| `POST/DELETE /api/patient_cases/cases/:id/bookings` | TC-PC-005 (attach, detach, duplicate attach, concurrent attach) |
| UI: patient record, case timeline, measurement chart | TC-PC-006 (happy path walk-through) |

## Risks & Impact Review

### Data Integrity Failures

#### Concurrent creation of the same patient
- **Scenario**: Two receptionists submit the same national identifier within the same second; both lookups return no match before either write lands.
- **Severity**: Medium
- **Affected area**: `POST /api/patient_cases/patients`, patient record UI
- **Mitigation**: The organization-scoped unique index on `national_id_hash` is the authoritative arbiter, not the advisory lookup. The second insert fails on the constraint and is translated into `409 { error: 'duplicate_national_id', patientId }` pointing at the existing record — which the caller can always open, because the index and every read share the same scope.
- **Residual risk**: Patients registered through the fallback-identity path have no system-level uniqueness at all. Accepted and documented; soft deduplication on the document number is deferred.

#### Case status written without a transition row
- **Scenario**: A crash between the scalar status update and the insert of `CaseTransition` leaves a case whose history does not explain its state.
- **Severity**: High
- **Affected area**: case lifecycle, audit trail
- **Mitigation**: Both writes run inside one `withAtomicFlush(em, phases, { transaction: true })`. Side effects and cache invalidation are outside the flush and fire only after commit.
- **Residual risk**: A direct database edit bypassing the module still desynchronises history — the same exposure every audited entity in the platform carries.

#### Two visits attached to one case at the same moment
- **Scenario**: Two receptionists each create a reservation for the same case and attach it within the same second; both read `max(sequence_no) = 1`.
- **Severity**: Medium
- **Affected area**: case timeline, patient-facing paperwork
- **Mitigation**: `unique (case_id, sequence_no)` is the arbiter, assigned inside this module's write transaction rather than read-then-written. The loser retries and takes `/3`; the client is told to retry rather than shown a raw constraint error.
- **Residual risk**: A reservation can exist in the appointment layer without a `CaseBooking` row if the attach fails after the booking was created. It surfaces as an orphan on that layer's calendar rather than as a phantom on the timeline, and re-attaching the same reservation to the same case is idempotent; re-attaching it to a *different* case is refused, because a reservation belongs to exactly one case.

#### Referenced entity deleted mid-flight
- **Scenario**: A practitioner is removed from `staff` while cases referencing them exist.
- **Severity**: Medium
- **Affected area**: case list, enrichers
- **Mitigation**: Cross-module links are plain id columns with no FK constraint, so nothing cascades. Enrichers resolve a missing id to `null` and the UI renders an "unassigned" state.
- **Residual risk**: Historical cases keep an unresolvable id. Acceptable — it preserves the audit record rather than rewriting history.

### Cascading Failures & Side Effects

#### `forms` unavailable or not installed
- **Scenario**: The consent projection cannot be read, so the terms gate has nothing to evaluate.
- **Severity**: Medium
- **Affected area**: case creation, consent block
- **Mitigation**: The gate is fail-open by design and documented as such: with no consent source the module does not block clinical operations, and the consent block renders an empty state. The alternative — blocking intake because an optional peer is down — is worse for the practice and no better for compliance, since the record's lawful basis is a retention obligation rather than consent.
- **Residual risk**: A tenant could run without consent capture and not notice. Mitigated by a setup-time warning when the terms clause setting is present but `forms` is absent, and — because a warning does not survive into the record — by `Case.terms_consent_bypassed` plus a `patient_cases.case.consent_check_bypassed` audit event on every case created through the open gate.

### Tenant & Data Isolation Risks

#### Art. 9 names recoverable from the search index
- **Scenario**: Patient names are declared in the module's search source so reception can find people by surname. `query_index` tokenizes the *decrypted* value, and `search_tokens` stores an unkeyed `sha256` per token with partial matching on by default — so each surname lands as its full prefix ladder of unkeyed digests over a small dictionary. Anyone holding a database dump recovers the names from the index and never touches the encrypted column.
- **Severity**: High
- **Affected area**: `search_tokens`, patient list search, the whole point of encrypting `first_name` / `last_name`
- **Mitigation**: The module's own `search.ts` excludes every Art. 9 identifier from the search source, so no token is ever produced (Q3). The exclusion is module-owned rather than delegated to `OM_SEARCH_FIELD_BLOCKLIST`, which a module cannot guarantee a deployment configures. Patient lookup is exact-match through `hashField`, which is peppered.
- **Residual risk**: Patients are not fuzzy-searchable — a real product cost, accepted deliberately and documented in the module README rather than presented as a missing feature. It lifts if the platform lands a keyed, per-tenant token hash (filed upstream under Q3(a)), at which point the exclusion can become a tenant-configurable choice.

#### Encrypted fields returned to an under-privileged role
- **Scenario**: A workshop role calls the patient endpoint directly and receives the full decrypted record because the visibility filter lives only in the UI.
- **Severity**: High
- **Affected area**: `GET /api/patient_cases/patients`, production board
- **Mitigation**: Field reduction happens in the read path, keyed on `patient_cases.view_sensitive`; the UI renders whatever the server returns. Q4 asks whether the mechanism belongs to the platform.
- **Residual risk**: Until Q4 is resolved the reduction is module-local, so a future platform mechanism will supersede it. Being additive, that migration is non-breaking.

### Migration & Deployment Risks

#### Encryption maps seeded after patient import
- **Scenario**: A tenant imports patients before `defaultEncryptionMaps` is applied, leaving plaintext rows that later reads treat as ciphertext.
- **Severity**: High
- **Affected area**: patient record, lookup
- **Mitigation**: Documented ordering — seed encryption before import — plus `yarn mercato entities rotate-encryption-key` to encrypt plaintext rows after the fact. (`entities rotate-encryption-key` is the command that walks entity encryption maps; `auth rotate-encryption-key` is the auth-module counterpart and is not the one meant here.)
- **Residual risk**: A tenant that ignores both leaves PII at rest in plaintext. Detectable, correctable, and called out in the module README.

#### The consent dependency is a pre-release package
- **Scenario**: `@open-mercato/forms` publishes only `0.0.0` pre-releases today (dist-tags `canary` and `develop`). A tenant installs this module, gets a canary of the package its consent record depends on, and a later shape change to `FormConsentRecord` silently breaks the terms gate or the consent history.
- **Severity**: High
- **Affected area**: consent gate, GDPR audit trail, release plan
- **Mitigation**: the dependency is pinned to an exact published version rather than a range, and the read goes through the DI service rather than the entity, so a column rename is absorbed where possible. The terms gate is fail-open with a recorded bypass (see above), so a broken read degrades to a traced gap rather than blocked intake. Q2 asks maintainers directly for the stabilisation plan and the pre-1.0 compatibility guarantee.
- **Residual risk**: Real until `forms` reaches a stable release, and **that release is now the precondition for the implementation PR** (Q2): maintainers will cut `0.1.0` and declare `subject_type`, `subject_id`, `consent_field_key`, `clause_sha256` and the status set STABLE in `BACKWARD_COMPATIBILITY.md`. Until it lands, the fallback stays what the mitigation describes — an exact pin plus the service-level read — rather than a module-owned consent log, which would buy a stable contract at the price of a second GDPR surface.

#### Migration interrupted midway
- **Scenario**: The migration adding this module's four tables fails partway.
- **Severity**: Low
- **Affected area**: installation
- **Mitigation**: Purely additive DDL, re-runnable, and no existing table is altered.
- **Residual risk**: None.

### Operational Risks

#### Storage growth from transitions
- **Scenario**: `CaseTransition` grows without bound.
- **Severity**: Low
- **Affected area**: storage
- **Mitigation**: Rows are small and bounded by case count — single-digit rows per case.
- **Residual risk**: None material.

## Final Compliance Report — 2026-08-06

### AGENTS.md Files Reviewed
- `AGENTS.md` (root, official-modules)
- `.ai/specs/AGENTS.md`
- `.ai/skills/spec-writing/SKILL.md` and its `references/spec-template.md`, `references/spec-checklist.md`, `references/compliance-review.md`
- `packages/forms/AGENTS.md`

### Compliance Matrix

| Rule Source | Rule | Status | Notes |
|-------------|------|--------|-------|
| root AGENTS.md | Every module is an external extension; MUST NOT modify core packages | Compliant | New package only; core is consumed, never edited |
| root AGENTS.md | No cross-module `@ManyToOne` ORM relationships | Compliant | All cross-module links are plain id columns |
| root AGENTS.md | MUST filter every query by `organization_id` | Compliant | Scope is a required argument of every read, including the identifier lookup; asserted by a two-tenant integration fixture |
| root AGENTS.md | Table names plural snake_case | Compliant | `patient_cases_patients`, `patient_cases_cases`, … |
| root AGENTS.md | Standard columns `id`, `organization_id`, `tenant_id`, `created_at`, `updated_at` | Compliant | Plus `deleted_at`, `is_active` |
| root AGENTS.md | Feature ID `<moduleId>.<action>` | Compliant | `patient_cases.view` / `.create` / `.edit` / `.delete` / `.view_sensitive` / `.view_measurements` |
| root AGENTS.md | Event ID `<moduleId>.<entity>.<past_tense>` | Compliant | `patient_cases.case.status_changed`, `patient_cases.case.consent_check_bypassed`, … |
| root AGENTS.md | MUST declare `defaultRoleFeatures` for every feature in `acl.ts` | Compliant | Declared in `setup.ts`; `view_sensitive` granted to admin and superadmin only |
| root AGENTS.md | API routes MUST export `openApi` and `metadata` | Compliant | Stated per route in API Contracts |
| root AGENTS.md | MUST use `makeCrudRoute` with `indexer: { entityType }` | Compliant | All list/CRUD routes |
| root AGENTS.md | Write operations MUST use the Command pattern | Compliant | Commands enumerated under Architecture |
| root AGENTS.md | MUST validate all inputs with zod in `data/validators.ts`; no `any` | Compliant | Types derived via `z.infer` |
| root AGENTS.md | MUST use `findWithDecryption` / `findOneWithDecryption` if PII exists | Compliant | Stated in Data Models → Encryption |
| root AGENTS.md | NEVER hand-write migrations | Compliant | Generated via `yarn mercato db:generate` |
| root AGENTS.md | No hardcoded user-facing strings | Compliant | i18n section enumerates key namespaces |
| root AGENTS.md | No raw `fetch`; use `apiCall`/`apiCallOrThrow` | Compliant | UI section |
| root AGENTS.md | `pageSize` ≤ 100; dialogs support `Cmd/Ctrl+Enter` and `Escape` | Compliant | UI section |
| root AGENTS.md | API route path `/api/<module>/<resource>` | Compliant | `/api/patient_cases/...` |
| root AGENTS.md | Package kebab-case, module ID snake_case | Compliant | `patient-cases` / `patient_cases` |
| `.ai/specs/AGENTS.md` | Spec includes TLDR, Overview, Problem Statement, Proposed Solution, Architecture, Data Models, API Contracts, Risks & Impact Review, Final Compliance Report, Changelog | Compliant | All present |
| `.ai/specs/AGENTS.md` | Risks document scenario, severity, affected area, mitigation, residual risk | Compliant | Risk Register format used throughout |
| spec-writing SKILL.md | Community modules MUST use UMES extension points | Compliant | Subscribers, enrichers and widget injection enumerated; the absence of interceptors is stated as a decision |
| spec-writing SKILL.md | Open Questions gate — stop before Research/Design until answered | Compliant (gate closed) | Design was published ahead of the answers so maintainers had something to judge, and no package was scaffolded until Q2–Q5 came back on 2026-08-26. See Non-Compliant Items for the shape of that deviation |
| root AGENTS.md | Keep specs implementation-accurate | Compliant | Q3 and Q5 changed the design; both are carried into the body (Encryption → *Art. 9 identifiers stay out of the search index*, Data Models → *Case*) rather than left as answers in a question list |

### Internal Consistency Check

| Check | Status | Notes |
|-------|--------|-------|
| Data models match API contracts | Pass | Every request field maps to a declared column; no endpoint references a field the model lacks |
| API contracts match UI/UX section | Pass | Lookup and transition endpoints each back a described screen |
| Risks cover all write operations | Pass | Patient create, case create, case transition and booking attach each appear in the register |
| Commands defined for all mutations | Pass | Four commands enumerated under Architecture |
| Cache strategy covers all read APIs | Pass | No read in this document is cached beyond the query index; the cached availability read belongs to SPEC-009 |

### Non-Compliant Items

- **Rule**: "STOP after presenting the skeleton. Do not proceed to Research until all questions are answered. This is a hard gate."
- **Source**: `.ai/skills/spec-writing/SKILL.md`
- **Gap**: This spec carried Open Questions **and** completed Research, Design and an Implementation Plan at the point it was opened for review, where the skill expects the gate to hold at the skeleton.
- **Resolution**: The deviation was deliberate — an external contributor cannot resolve Q1–Q5 without maintainer input, and a bare skeleton would not have given maintainers enough to judge the collision question. The gate was honoured where it mattered: **no package was scaffolded and no code contributed until the answers landed on 2026-08-26.** In hindsight the deviation earned its keep: Q3's answer inverted a design decision, which a skeleton would not have surfaced until implementation. The gate is now closed and no longer blocks anything.

### Verdict

- **Compliant.** Q1 moved to SPEC-009 with the appointment layer; Q2–Q5 were answered on 2026-08-26 and their consequences are carried into the body. Implementation is unblocked, with one remaining external precondition that is not this document's to satisfy: a stable `@open-mercato/forms` `0.1.0` (Q2), tracked under Migration & Compatibility and in the Risk Register.

## Changelog

### [2026-09-03]
- **Closed the Open Questions gate.** Q2–Q5 came back from maintainers on 2026-08-26; each question now carries its answer, and the two answers that changed the design are carried into the body rather than left in the question list.
- **Q3 inverted a design decision and the body now says so.** Art. 9 identifiers are excluded from the search source entirely — not just from documents sent to an external engine — because `search_tokens` stores an unkeyed `sha256` per token with partials on by default, which makes an indexed surname a recoverable copy of the name sitting next to the encrypted column. Added the module-owned `search.ts` field policy, the manifest row for it, the risk-register entry, and the product cost this carries: patients are not fuzzy-searchable, lookup is identifier-only.
- **Q5's boundary moved into the body** (Data Models → *Case*), so it survives implementation: measurements, specification, schedule and status are order data; diagnoses and treatment notes belong to a separate module referencing `Case` by id, and no field here may be repurposed to hold them.
- **Q2 recorded as a release precondition** rather than an open question: a stable `@open-mercato/forms` `0.1.0` with the consent contract declared STABLE gates the implementation PR, not this one. Risk register and Migration & Compatibility updated accordingly.
- Q4 confirmed as a module concern; the reduced projection and the `patient_cases.view_measurements` split stay exactly as specified.
- **Removed `.ai/specs/assets/spec-005/`** and pointed the two embeds at the pull-request attachments. `.ai/specs/` is text-only: outside `apps/sandbox` this repository tracks no binaries, it is consumed as a submodule, and git keeps every rerender of a mock forever without diffing it.
- **Renamed the file to `2026-08-06-patient-cases-module.md`** and dropped the number from the title, per the new convention — specs are no longer numbered, because the number is claimed at merge and a race is built into that. The collision with #21 disappears without either side giving up a number. This document was circulated as SPEC-005 in PR #32.
- Corrected two references left stale by the SPEC-009 split: the encryption note named `visit` and `time-block` entities this document no longer owns, and the migration risk counted seven tables where four remain.
- Final Compliance Report updated: the gate row and the verdict now read as closed, and the deviation is recorded with what it bought — Q3's answer inverted a decision that a bare skeleton would not have surfaced until implementation.

### [2026-08-21]
- Recorded what consuming `forms` actually costs: it is an official module of this repository rather than part of `@open-mercato/core`, and it publishes only `0.0.0` pre-releases today. Added the risk entry, sharpened Q2 into the two questions only maintainers can answer (acceptable peer dependency? stabilisation plan and pre-1.0 contract guarantee?), and noted the fallback if the answer is no.
- Added storing measurements as `forms` submissions to Alternatives — deferred rather than rejected, with the reason.
- Stated and enforced the rule that a reservation belongs to exactly one case: `booking_ref` is unique per organisation rather than per case. A visit exists to answer what it is for, and one appointment with two meanings makes the schedule unreadable at the desk. Bilateral work is one case with `sides = 'both'`.
- Stated the reduced field set explicitly (first name, last name, height, weight) and split measurements out behind their own `patient_cases.view_measurements` grant, so shop-floor access to a body profile is a per-tenant decision rather than a side effect of board access.
- Replaced the assumed reuse of `@open-mercato/ui/backend/schedule` with what its `ScheduleItem` actually offers: three kinds (the free / booked / blocked triple, already modelled), no `checked_in` or `no_show` status, a closed `member | resource` subject, and no buffer representation — so what must be contributed upstream is named rather than discovered later.
- Closed the gap the split left behind: the booking series is now a modelled thing (`CaseBooking`), not an implied one. The case owns which reservations belong to it and their `/1`, `/2` position, assigned in this module's transaction with a unique index as the arbiter; the appointment layer owns the reservation and stores nothing about cases. Nothing about a reservation is copied, so there is no second source of truth for its time.
- Grounded the design against what core gained after 0.6.6: the CRM calendar at `/backend/calendar` is documented as what it is (a read view over `CustomerInteraction`, with advisory client-side conflicts) and rejected as a booking store in Alternatives, while its view layer is explicitly reused — this module renders through `@open-mercato/ui/backend/schedule` rather than adding a third calendar to the repository.
- Recorded that two booking-layer proposals are in flight (SPEC-008 / PR #33 and SPEC-009) and that this document depends on neither, plus the six requirements this vertical has against whichever wins.
- **Split into two specifications.** The appointment layer (`VisitType`, `Visit`, `VisitParticipant`, `TimeBlock`, the availability service, the conflict check and the calendar) moved to **SPEC-009**, together with the open question about where it belongs. This document keeps the patient record and the case lifecycle, depends on no unanswered question about the appointment layer, and can be reviewed and built on its own. The seam between the two is stated explicitly under Architecture. Q2–Q5 keep their numbers so the existing review conversation keeps its references.
- Second pass after a self-review of the first: corrected the optimistic-lock conflict body to the platform's own (`record_modified` / `optimistic_lock_conflict`), added the `lookupHashCandidates` read path and the rehash migration for tenants that gain a pepper later, named the `audit_logs` services (`accessLogService`, `actionLogService`), fixed the reprojection command to a single module CLI token, and added the lock-conflict i18n key.
- Responded to the specification review. API paths corrected to `/api/patient_cases/...` (route paths are built from the module id verbatim; backend page paths are not and stay kebab-case).
- Q3 narrowed: `query_index` builds search tokens from decrypted documents, so token search over encryption-mapped fields already works; what remains open is external engines and whether tokens derived from Art. 9 names should exist at all. Problem Statement defect #3 restated as a historical observation.
- Identifier hashing hardened: lookup pepper as a deployment precondition, refusal to write hashes without one, and context-scoped digests.
- `national_id_hash` uniqueness rescoped from tenant to organization, matching the scope of every read.
- Consent write side specified (who creates the subject-bound submission), read path named (`formsConsentRecordService`), `forms.view` added to role grants, and the fail-open bypass now recorded per case with an audit event.
- Added Retention, Erasure and Access Audit; restated case/visit entities as carrying no *direct identifiers* rather than no personal data.
- Added optimistic-locking contract, per-phase acceptance criteria, the rationale for projecting staff absence into `TimeBlock` plus a reprojection command, and renamed `visit.no_show` to `visit.marked_no_show`.

### [2026-08-09]
- Added three illustrative mocks under `assets/spec-005/` (case timeline, visit calendar, production board), rendered with synthetic data and a generic made-to-measure product.

### [2026-08-06]
- Initial specification.
- Dropped a previously planned module-owned `PatientConsent` entity after reviewing `packages/forms`: `FormConsentRecord` is already subject-agnostic, PII-free and clause-hash-versioned, so consent is consumed from `@open-mercato/forms` with `subject_type = 'patient_cases.patient'` rather than duplicated (raised as Q2).
- Market review against HL7 FHIR, OpenMRS, OpenEMR and Cal.com recorded under Overview.
