# SPEC-008 — The reservations module for Open Mercato: contribution proposal

## PART I: BUSINESS

### 1. Why this module

We need a booking engine for our own application that contains: bookings of a specific resource within a time window, conflict detection, and a schedule. Open Mercato has no such functionality today, and any customer who books something over time needs it, whatever the industry.

Most of the logic is not specific to our application or to one industry, which makes it a natural core module for Open Mercato. We would rather build it generic from the start and have products configure and extend it than build it twice. Open Mercato gets the missing piece plus a reference implementation, and the next customer with booking needs inherits a working engine.

### 2. What the module delivers

One question drives the whole module: **book this resource for this target in this window, and warn me if something overlaps.** Concretely:

- **Bookings that tie a resource to a target over time.** The missing piece today. A booking carries its own semantics: status, duration, expected start date, and an unplaced state.
- **One place that knows what is busy.** Busy time lives in the module's reservation table. Other modules read it through the module's read service and events, without touching the booking domain and without a second copy in the planner.
- **Conflict detection.** Two bookings of the same subject overlapping, or a booking landing inside an unavailability window. Flagged on the timeline and emitted as an event for alerts.
- **Early warning on coverage gaps.** "This target loses its resource in X days." The threshold is configurable.
- **A view of what is free.** The schedule already shows every other subject of the same type in that window, so the dispatcher can see the alternatives without a feature that recommends them.
- **A resource-lane timeline.** One row per subject, bookings as bars, conflicts marked.
- **A working calendar per organization.** Duration counted in working days, with days off and public holidays applied.

### 3. Where it applies

The same mechanism covers:

- **equipment**: an excavator, a forklift, an ultrasound machine, event gear,
- **space**: a meeting room, a workstation, a service bay,
- **appointments and services**: a customer visit, a service slot.

Each product supplies only its own domain: what a target is, which fields it carries, which alerts matter. Bookings, conflicts, the timeline and busy time come from the core. Building the next booking product on Open Mercato then costs product work, not platform work.

### 4. MVP scope

#### 4.1 In scope

- **Availability, schedule, conflicts.** The core of the module: the reservation entity, conflict detection, and early warning on coverage gaps. Warning lead time is configurable, in days.
- **A working calendar per organization.** Configurable weekly days off plus named holidays. The engine counts duration in working days but does not enforce them: work on a day off is allowed, the arithmetic just reflects reality. One calendar per organization, no per-subject exceptions yet.
- **A booking target.** Lightweight and generic, extended by the product with custom fields.
- **A resource-lane timeline.** One row per subject, at daily granularity.

Configuration stops at three things: the warning lead time, the calendar's days off and holidays, and the organization's timezone (7.5). There is no rules engine behind any of it.

#### 4.2 Out of scope for the MVP

- **A rules engine.** Conditions and actions configurable per customer without code. Only the settings listed in 4.1 are configurable here.
- **Qualification matching.** Permission gaps, matching a subject against what a target requires.
- **Requests and two-way assignment.** Working from the target inward, with an approval flow. The MVP works from the resource outward.
- **Cascading reschedules.** Push and pull, shifting a chain of bookings.
- **Capacity.** Rooms, pools and seats, where a conflict means bookings exceeding capacity. Here a conflict is a plain overlap, and the model leaves room for capacity later.
- **An hourly timeline.** The UI and the working-hours arithmetic are not there yet. Moving to hours needs no data change, because the model already stores full timestamps.
- **Calendar exceptions per subject or target.** One calendar per organization for now.

One thing worth separating from cascading reschedules: **seeing what is free stays in the MVP.** When a date conflicts or a target has no cover, the schedule still shows every other subject of that type, and the dispatcher decides. That falls out of the availability view itself. It is neither a recommendation feature nor a cascade, and a cascade shifts an entire chain of bookings, which is post-MVP.

## PART II: TECHNICAL

### 5. What the module builds on

The module adds a booking layer on top of three existing Open Mercato modules rather than building a foundation.

- **resources** owns the registry of resources and instances. This answers what we book. A hard dependency, and we are not writing our own registry.
- **planner** owns availability and unavailability windows, plus plannerAvailabilityService to compute availability over time. This answers when a subject is available at all.
- **events** and **notifications** deliver alerts. The module only emits typed events, a detected conflict for instance, and existing infrastructure delivers the notification.

RBAC, dictionaries, search and audit come from the platform and count as given.

### 6. Integrating with the planner

The planner's subjectType enum is closed (member | resource | ruleset), so the design question was whether a generic booking subject fits without changing it.

**It fits, and the enum stays as it is.**

- **Equipment** maps straight onto subjectType='resource', where an instance is a resources entity.
- **Anything that is neither a member nor a resource** goes in as subjectType='ruleset'. The subject gets its own PlannerAvailabilityRuleSet and rules point at its id. Ruleset works as a universal adapter, so any registry attaches without planner changes.
- **The organization's working calendar is not a planner ruleset.** Days off, holidays and the timezone are state on the module settings entity (7.4), and unavailability windows are derived from that state. Nothing is stored in the planner or in configs.

So widening the planner enum is not a prerequisite. The pattern runs against an unmodified planner, which keeps the contribution simple and takes the process risk off the table: no waiting for approval to change planner internals.

**The integration reads and never writes.** Writing into the planner would mean a dual write: no shared transaction across modules, and a partial failure could leave a booking that nobody sees as busy. The hook-in, resource or ruleset, exists only so the adapter can fetch a subject's unavailability windows and hand them to the conflict engine.

### 7. Core data model

**Platform conventions apply to every entity below:** id (uuid PK), `tenant_id` and `organization_id` with every query filtered by both, `created_at`, `updated_at`, and `deleted_at` for soft delete. All of them are user-editable, so `updated_at` doubles as the record version for optimistic locking, which Open Mercato enables by default (section 13), and list and detail responses return updatedAt. The module ships its own migrations and snapshot through the standard flow (yarn db:generate). The entities are new, so the migrations only create tables and there is no data migration path.

#### 7.1 reservation

A booking needs its own entity, because a planner window cannot carry its semantics.

| Column | Type | Null | Description |
| :---- | :---- | :---- | :---- |
| `subject_type` | text | NOT NULL | what is booked, matching the planner: `resource` \| `ruleset` |
| `subject_id` | uuid | NOT NULL | id of the resource or rule set |
| `subject_provider_key` | text | NOT NULL | which registry provider resolves the subject, for labels and view routing |
| `target_id` | uuid | NULL | FK id to a target, no ORM relation |
| `target_text` | text | NULL | free-text target with no target record; CHECK: exactly one of `target_id` and `target_text` |
| `start_at` / `end_at` | timestamptz | NULL | placement window, both set or both NULL (CHECK); NULL means unplaced, so still backlog |
| `status` | text | NOT NULL | enum: `planned` \| `active` \| `done` \| `cancelled` |
| `duration_working_days` | numeric(4,1) | NOT NULL | working days, in steps of 0.5 |
| `latest_start` | date | NULL | expected start date, which is how the UI labels it |
| note | text | NULL | free note |

**Indexes.** (`tenant_id`, `organization_id`) on every table. (`subject_type`, `subject_id`, `start_at`) for conflict engine reads. A partial index WHERE `start_at` IS NULL for the backlog. Windows are timestamptz from day one.

**Status transitions.** planned to active on start, active to done on completion, planned or active to cancelled, and done back to active to correct a mistake. Conflicts and busy time count planned and active only. A status change command performs the transition, and cancel gets an alias route. Whether a booking is placed is independent of its status.

**Unplaced bookings.** A booking can exist without a window. It is a commitment that has not landed on the timeline yet. This is part of the core contract, not a product detail.

**Where busy time lives.** Nothing is mirrored into the planner. The reservation table is the only source, and the module exposes it to others through a read service, reservationsBusynessService.getBusyWindows(subject, range, scope), plus events. If Open Mercato ever wants one place to ask about busy time, a provider registry on the availability service would fit: modules register window providers, the service aggregates. Each module keeps its own truth and nobody writes twice.

#### 7.2 `reservation_target`

A generic target answers what a booking is for, while the booking answers what and when. The target is where a product's domain attaches: extend it with custom fields such as priority or customer, and link it to your own Open Mercato entities by FK id, so any entity can hang off a booking without core changes. The core knows nothing about construction sites or meetings, only a named target with an optional window. One target entity therefore serves every booking product, and coverage warnings have something to measure, since coverage is per target.

| Column | Type | Null | Description |
| :---- | :---- | :---- | :---- |
| name | text | NOT NULL | target name |
| `starts_at` / `ends_at` | date | NULL | optional target window |
| `address_text` | text | NULL | address, stored as snapshot |

Three core fields: a name, an optional window, and a **text address**. The address is a snapshot on purpose, so it stays as it was when the booking was made even if the source record changes later. No @ManyToOne to CustomerAddress; this is the FK id plus snapshot pattern, and Open Mercato has no generic address entity. In the MVP the address is typed by hand. Filling it from the customers module, picking a customer and copying their address onto the target with an optional `customer_id` for provenance, is additive and comes in a later iteration without changing the pattern. Coordinates and maps are out of scope.

#### 7.3 What a registry must provide to be bookable

Any registry can appear on the schedule as long as its entity provides:

- a stable id,
- multi-tenant scope, tenantId and organizationId on the subject and on its rules,
- a planner hook, subjectType and subjectId via resource or its own ruleset. The engine never reads the hook itself; the adapter does, to fetch unavailability windows,
- a category for grouping rows, as a DictionaryEntry with an icon and colour,
- an active or retired flag.

The engine knows nothing about equipment, rooms or appointments. The consumer **maps its entities onto the engine's generic input**, subjectType plus subjectId plus windows, instead of handing over a domain object. That is what makes the module reusable: the core sees a subject and windows, the product supplies the meaning.

#### 7.4 `reservations_settings`

The settings from 4.1 get their own entity, one row per organization, unique on (`tenant_id`, `organization_id`).

| Column | Type | Null | Description |
| :---- | :---- | :---- | :---- |
| `off_weekdays` | jsonb | NOT NULL | weekly days off, 0 to 6 |
| holidays | jsonb | NOT NULL | holiday dates |
| `coverage_warning_days` | int | NOT NULL | days of lead time on the coverage warning |
| timezone | text | NOT NULL | the organization's reference timezone, an IANA name |

The working calendar is state here. Unavailability windows derived from it are never persisted, because they are a function of that state.

#### 7.5 Timezones and DST

**Days resolve in the organization's timezone.** The timezone column on the settings entity holds it, as an IANA name, one row per organization. It is set on the settings screen next to days off and holidays, because it answers the same question: what counts as a day here.

**Not the viewer's timezone, and not UTC.** Use the viewer's and the same booking falls on different days for different people. UTC fails the same way: store 3 to 5 August at local midnight and it reads as 2 to 4 August outside UTC. We display the viewer's timezone when it differs, but it never decides where a booking sits.

**Storage.** `start_at` and `end_at` are moments, timestamptz in UTC. Day boundaries are computed in the organization's timezone, never as `${date}T00:00:00Z`, because a day in a real timezone does not always begin at the same UTC hour. The timezone name is data, not decoration; without it the boundary cannot be computed.

**Clock changes do not break day counting.** Duration is counted over calendar dates, not by adding 24 hours to a moment. A working day is a calendar day, so a 23 or 25 hour day changes nothing, and `duration_working_days` stays a count of days.

**Input and display.** place, move and resize accept a YYYY-MM-DD date and the server stamps the moment in the organization's timezone. The browser never decides. Date fields are labelled with that timezone, and hour fields will be too once the hourly scale lands. A bar sits on its own date, so the browser's timezone cannot shift it. Every displayed time carries a timezone label computed from that specific date, because Europe/Warsaw is GMT+1 in winter and GMT+2 in summer.

**Both DST edge cases are resolved in code.** Moving forward, the clock jumps 02:00 to 03:00 and 02:30 does not exist, so such an entry shifts forward. Moving back, the clock returns 03:00 to 02:00 and 02:30 happens twice, so we take the first. The choice cannot depend on the machine doing the arithmetic, or the server and the browser would store different moments for the same input.

**Only IANA names are accepted**, validated against the runtime. GMT+3 is rejected, because an offset alone says nothing about when the clock changes.

**Timezones never reach the engine.** A booking and an unavailability window arrive as the same kind of interval. The working calendar also works in dates, and the end of a range comes out as a date, not a moment. Timezones only matter at the edge, where a date becomes a moment.

**Planner data keeps the rule's timezone.** Unavailability rules are not ours and carry their own timezone per rule and per rule set, so the adapter (8.1) expands them in that timezone, not the organization's. It computes on its own side and changes nothing in the planner.

**Post-MVP: a timezone per target.** A timezone column on `reservation_target`, empty meaning the organization's. Dates are then entered in the target's timezone while the organization's stays with the working calendar, and a target's timezone is fixed once created, because stored moments are pinned to it. It pairs with per-target holiday lists (4.2), since at daily granularity a different holiday list gives the wrong date, not the wrong hour.

### 8. Conflict detection

**The conflict engine and the calendar arithmetic are pure functions.** They take plain values, booking windows, availability and unavailability windows, and days off, and they return data, a list of conflicts and a count of working days. No I/O, no writes, no framework, no database. The same code therefore runs on the server and in the browser, which is what makes a live conflict preview possible while dragging a bar. Framework-bound layers, writes, reads and the planner, wrap that core and never leak into it.

The engine never queries the planner.

- **What counts as a conflict.** Two bookings of the same subject overlapping in time, or a booking landing inside an unavailability window.
- **How it runs.** The adapter (8.1) expands the subject's **unavailability** rules for a range and passes the resulting intervals into the pure function, alongside the subject's other bookings. Deliberately not through getMergedAvailabilityWindows: that returns merged *availability*, and a subject with no availability rules, which is normal for equipment, would come back empty no matter what unavailability it has. The split is clean. **The planner owns availability windows; the engine answers whether bookings overlap or land in unavailability.** A thin adapter joins the two, and the core stays out of it.
- **What happens on a conflict.** It is always flagged, on the timeline and as an event, and it never blocks the save. The system advises, the person decides.
- **Concurrency.** Two placements of the same subject into overlapping windows both succeed and both get a warning afterwards. Neither is blocked, which is intended: a schedule conflict is something a person resolves, not a write error. Editing the same record concurrently is a different problem, and Open Mercato's optimistic locking handles it (section 13), returning 409 instead of silently overwriting.

**One correctness constraint.** Detection after a write must read committed database state, not the query engine index. The index converges asynchronously and may not yet hold the booking that triggered the check. Detection is therefore a separate reactive read, triggered by the place, move or resize event, not part of the write command. That read runs the pure function and returns conflicts, and the alert event goes out separately.

Capacity is deliberately absent (see 4.2).

#### 8.1 The planner adapter, shipped rather than suggested

Pairing a pure engine with the planner will repeat for every booking consumer, so the module ships the adapter, plannerAvailabilityAdapter, as a separate reusable block. It is the module's only real port. A consumer gets conflict detection on connection instead of writing planner integration from scratch, and the engine stays pure and testable without the planner.

What it does:

- **In:** a subject, subjectType and subjectId, plus a range. **Out:** unavailability intervals in the shape the engine expects.
- **Expands unavailability rules directly** for that range. For subjects hooked in as resource it asks both rule targets: rules on subjectType='resource', and rules on the resource's `availability_rule_set_id` when it is set. For subjects hooked in as ruleset it asks for rules on that rule set.
- **Respects each rule's timezone**, per rule and per rule set, as stored in the planner. The organization's timezone (7.5) defines a day; it does not override a rule.
- **Degrades softly.** The planner is resolved with tryResolve. Without it the adapter returns an empty list, so overlap conflicts keep working and unavailability conflicts do not. Neither the engine nor the timeline component touches the planner.

### 9. Timeline

@open-mercato/ui/backend/schedule already ships a complete ScheduleView on react-big-calendar, with day, week and month views. A booking timeline needs a **resource-lane** view, one row per subject, which ScheduleView does not offer and react-big-calendar does not model naturally. ScheduleItem also types subjectType as member | resource, so ruleset subjects would force us to widen a shared UI contract.

We therefore leave ScheduleView alone and build **a lightweight props-fed component** with no domain knowledge: it knows nothing about bookings, the planner or any module. One row per subject, bookings as bars, days off shaded, daily scale now and hourly later with no data change. The props contract does not depend on the rendering library. The vis-timeline adapter sits in a single file as a swap seam, and the library loads lazily following the lazy-heavy-libraries pattern. ScheduleView and its contracts stay untouched, so this contribution changes no shared UI contract.

**Three ways to consume it.** The pure blocks import on their own without activating the module: the conflict engine and calendar arithmetic, which run on server and client, and the props-fed timeline component. Above them the module ships a default board view that works on resources entities the moment it is activated, with rows per resource grouped by type and no code to write. Pick the level you need: the engine, the component, or the finished screen. A custom registry attaches at the view level by mapping its entities onto the generic input (7.3).

### 10. Module surface

#### 10.1 API

| Surface | Mechanism |
| :---- | :---- |
| Target CRUD (`reservation_targets`) | makeCrudRoute, with indexer, optimistic locking and OpenAPI |
| Booking list, detail and field edits | makeCrudRoute |
| place / move / resize / change-status | commands via registerCommand with undo and redo; dedicated routes with mutation guards and enforceCommandOptimisticLock; cancel is an alias route onto change-status |
| GET timeline | a hand-built read endpoint returning subject rows from the provider, bookings, unavailability windows and calendar state (offWeekdays, holidays) in one response, paginated by subject row |
| GET subjects | provider enumeration, feeding the picker in the booking form |
| Backlog | a cheap separate read over the partial index |
| settings get and replace | a plain route plus a command |
| Busy time for other modules | reservationsBusynessService.getBusyWindows(subject, range, scope) via DI, the outward contract |

A booking that creates a schedule conflict is not an API error. The write succeeds with 2xx and detection follows (section 8).

#### 10.2 Events

Identifiers follow module.entity.action and are a frozen contract surface:

- entity CRUD events: created, updated, deleted
- reservations.reservation.placed, .moved, .resized, .cancelled, pushed to the browser over SSE so views refresh live
- reservations.conflict.detected, from post-write detection
- `reservations.coverage.gap_approaching`, from the coverage scan

The module declares its notification types and a subscriber delivers them through existing notifications infrastructure, deduplicated per grouping key: the subject for conflicts, the target for coverage gaps.

#### 10.3 ACL

Three features: reservations.view for reading views and the read API, `reservations.manage_reservations` for commands and CRUD on bookings and targets, `reservations.manage_settings` for settings. defaultRoleFeatures gives admin reservations.* and employee reservations.view, so an activated module works without anyone configuring permissions. Features are a contract surface and only grow.

### 11. Integration coverage

Following Open Mercato contribution rules, integration tests (`__integration__/TC-*.spec.ts`) ship in the same change as the module and stand on their own: fixtures built in setup, preferably through the API, cleaned up in teardown, with no reliance on demo data. This table is also the definition of done.

| Path | Coverage |
| :---- | :---- |
| Target and booking CRUD | create, read, update, delete within tenant and org scope; 409 on a stale `updated_at` |
| place / move / resize | happy path with `end_at` recomputed against the working calendar; 422 when placing a cancelled booking; 409 on a stale version |
| change-status and the cancel alias | permitted transitions; 422 on forbidden ones; the window released after done or cancelled, disappearing from conflicts and busy time |
| GET timeline | response shape, meaning subject rows, a conflict flag computed per read, and calendar state; pagination by row; the no-planner path, empty unavailability with overlaps still caught |
| GET subjects and backlog | paginated provider enumeration; the unplaced list |
| settings get and replace | writing and reading parameters; input validation |
| Event emission | reservations.conflict.detected after an overlapping placement; `reservations.coverage.gap_approaching` from the scan |
| UI: board | subject rows and booking bars render, conflicts are marked, the view refreshes on an SSE event |
| UI: booking form, targets, settings | create and edit a booking from the form; target CRUD through DataTable and CrudForm; save calendar settings and the warning threshold |

### 12. i18n, observability, rollout

- **i18n.** Every user-visible string goes through the module's locale files (en, pl, de, es), with nothing hardcoded, per platform rules. The timeline component takes all labels as props and translates nothing itself, so translation stays with the host and the component stays portable.
- **Observability.** Diagnostics go through the platform logger, createLogger with structured fields and env-driven levels. The operational signal is the module's typed events, placements, conflicts and coverage gaps, consumable by subscribers, SSE and existing notifications. The module adds no metrics infrastructure of its own.
- **Rollout.** The module is optional and additive, activated per application through the standard mechanism for official modules. Migrations only create new tables and touch nothing existing, so activation is safe on a running installation. Module setup seeds permissions and sample data. The planner dependency is soft with defined degradation, so activation order does not matter. Rolling back means deactivating: tables and data stay, and nothing elsewhere depends on them.

### 13. Dependencies and platform conventions

- **Dependency direction.** reservations reads from the planner and never writes, through tryResolve, degrading to an empty unavailability list when the planner is absent so overlap conflicts still work. The module performs no writes into the planner and no cross-module writes at all.
- **Optimistic locking.** All three entities, booking, target and settings, use Open Mercato's standard `updated_at` mechanism, enabled by default. The client returns the version it knows in a header, a mismatch yields a structured 409, and the UI shows the standard record conflict bar. makeCrudRoute provides this on the CRUD path automatically, and the domain commands, place, move, resize and cancel, enforce the same check through enforceCommandOptimisticLock. This guards against overwriting someone else's edit of the same record. Placing two different bookings into the same window is not a write error; it is a schedule conflict, detected afterwards (section 8).
- **No ORM relations across modules.** Links to resources and planner are FK by id. defineLink appears only where the query engine has to join across a module boundary in one query, such as filtering or sorting bookings by subject columns.
- **Writes through commands**, side effects after flush, CRUD through makeCrudRoute with the indexer, zod validation, and every query filtered by organizationId and tenantId, per Open Mercato architectural rules.

The write and read layer, commands, CRUD, validation and indexing, sits **outside the pure core** and follows the conventions of whatever deploys it. The core, engine plus calendar arithmetic, knows nothing about routes or commands. That is what lets the core travel unchanged while the transport layer is fitted locally.

### 14. Changelog

#### Version 2, against the version of 15 July 2026

The July version proposed a direction. This one is ready to implement: it adds the data model, the module surface, permissions, events and a definition of done. Changes in order of weight.

- **Planner writes are gone.** The previous version mirrored each busy window into the planner as a rule (`plannerRuleId`) and called the planner the single source of truth, which meant writing to two modules without a shared transaction. The integration is now read-only, with no cross-module writes. The module's reservation table holds the truth and exposes it through `reservationsBusynessService` and typed events. Sections 6, 8 and 13.
- **Entities renamed.** `assignment` to `reservation`, `assignment_target` to `reservation_target`, tables in plural snake case. The glossary that separated a booking from a permission assignment is no longer needed.
- **The data model is spelled out.** Column tables with types, nullability and indexes, the status state machine, and constraints enforced in the database: exactly one of `target_id` and `target_text`, and `start_at` with `end_at` either both set or both empty. Duration in working days in steps of 0.5. One new column, `subject_provider_key`.
- **Timezones and DST, new section 7.5.** Days resolve in the organization's timezone, not the viewer's and not UTC, with the reasoning for rejecting both. Planner data keeps each rule's own timezone.
- **Module settings, new section 7.4.** A `reservations_settings` entity, one row per organization: weekly days off, holidays, the warning threshold, the timezone. The working calendar is state there and unavailability windows are derived rather than stored. Previously the calendar was a planner ruleset with its id in `configs`.
- **The planner adapter ships with the module.** Previously an idea for the platform core, now section 8.1 and part of the package, with defined input, output, per-rule timezone handling and degradation. It expands unavailability rules directly instead of calling `getMergedAvailabilityWindows`, because merged availability returns nothing for a subject that has no availability rules, which is the normal case for equipment.
- **The timeline question is settled.** `ScheduleView` is not reused. The timeline is a lightweight props-fed component with a `vis-timeline` adapter in one file, lazily loaded. `ScheduleItem` and every other shared UI contract stay untouched, so the contribution widens nothing.
- **The module surface is documented, new section 10.** An API table split into CRUD, commands and reads; event identifiers as a frozen `module.entity.action` surface; ACL with three features and default role assignments.
- **Integration coverage, new section 11.** A table of API and UI paths with the tests covering them, doubling as the definition of done.
- **i18n, observability and rollout, new section 12.** Locale files, labels as props, the platform logger, activation per application, migrations that only add tables, rollback by deactivation.
- **Multitenancy, migrations and locking are stated.** `tenant_id` and `organization_id` on every entity with every query filtered by both, soft delete, `updated_at` as the record version, own migrations and snapshot. Locking now covers the domain commands, not just CRUD.
- **Concurrency is spelled out.** Two parallel bookings in overlapping windows both succeed and both get a warning, because a schedule conflict is for a person to resolve. Locking protects a record from concurrent edits, not the schedule from overlaps.
- **Three consumption levels.** The engine and the timeline component import on their own without activating the module, and above them a default board view runs on `resources` entities with no code.
- **Free-text targets.** A booking can point at a target record or simply name one, with no record created.
- **Scope narrowed.** Section 3 no longer lists shift staffing, which needs a registry of people the core does not provide. The start field reads "expected start date" in the UI over the `latest_start` column.

