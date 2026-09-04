# Reservations module for Open Mercato

This is a new version of the proposal. It replaces the previous specification and answers the
review.

**In short.** The module adds reservations: who is busy, when, and for what. It finds
reservations that overlap and reservations that fall into unavailability. It warns when a
reservation without dates gets close to its start day. It shows everything on a timeline with
one row per subject. It stands on the existing registries of resources and people, and on the
availability schedules. To the schedules it adds one read method.

---

## 1. Why this module

Open Mercato has no place today that answers the question "is this resource busy?". There is a
calendar of customer meetings in `customers`. An entry there can point to a resource. But it is a
record of a meeting, not of occupancy. It does not know about unavailability. It does not detect
that two meetings take the same resource. Anyone who needs occupancy writes it alone, from
scratch. The reservations module does not replace that calendar. If a product wants to see a
meeting on the occupancy timeline, it creates a reservation for it.

A reservation is one sentence: "{subject} is busy from Tuesday to Friday, for {target}".

A subject is the thing that becomes busy. A target is the reason we reserve. On a construction
site the subject is an excavator and the target is the site. In a clinic the subject is a doctor
and the target is a patient. In a rental company the subject is equipment and the target is a
customer.

Three things are needed: a place to store this fact, a warning when two reservations overlap,
and a timeline that shows everything.

None of this depends on the industry. Only **what** is a subject and a target changes. The
mechanism stays the same.

That is why this should be an Open Mercato module, not one more feature locked inside our
application. The product adds its part: what can be reserved, which fields it carries, which
warnings it cares about. Reservations, conflicts, the timeline and occupancy come from the module.

## 2. What the module gives

**Reservations.** An entry: "this subject is busy in this time window, for this target". A
reservation carries its own data: status, how many working days it takes, when it is expected. It
can also exist without dates — as a commitment that has not landed on the timeline yet.

**One place that knows what is busy.** Occupancy lives in the reservations table and nowhere
else. Other modules ask for it through the module's service instead of keeping their own copy.

**Conflict detection.** Two reservations of the same subject that overlap, or a reservation that
falls into an unavailability window. A conflict is visible on the timeline and goes out as an
event to alerts.

**Early warning about a coverage gap.** A reservation waits without dates, and only X working
days are left until the day it must start. The module says so before it is too late. The
threshold is a setting, not a constant in code.

**View of what is free.** The timeline shows all other subjects of the same category in the same
window, so the dispatcher sees alternatives. This is not a suggestion engine and not automatic
assignment — a person decides.

**Timeline with one row per subject.** One row is one subject, reservations are bars, conflicts
are marked.

**Working calendar of the organization.** Duration is counted in working days, with free
weekdays and holidays. The calendar blocks nothing — work on Saturday is allowed, the arithmetic
only reflects reality.

## 3. Where it applies

The same mechanism serves three kinds of subjects:

**Equipment** — excavator, forklift, ultrasound machine, event equipment.
**Space** — meeting room, workstation, service bay.
**People** — a doctor at a visit, a technician on a job, a crew on a site.

The module does not know what a subject is. It sees an identifier, time windows, and nothing
more. The product adds the meaning: what is a target, which fields it carries, which warnings it
cares about.

Thanks to this, building the next reservation product on Open Mercato costs work on the product,
not on the platform.

## 4. Scope of the first version

### What is in the first version

**Reservations, conflicts, warnings.** The core of the module: storing reservations, detecting
collisions, warning about a coming coverage gap. How many days ahead to warn — a setting.

**Working calendar of the organization.** Free weekdays and a list of holidays. The engine counts
in working days but forbids nothing: work on Saturday is allowed, the arithmetic only reflects
reality. One calendar per organization, no exceptions for single subjects.

**Reservation target.** Light and generic, extended with product fields.

**Timeline with one row per subject.** Day scale.

Five things can be configured:

1. how many days ahead to warn about a coming coverage gap,
2. free weekdays,
3. list of holidays,
4. time zone of the organization,
5. whether a conflict should warn or block the write — by default, and, when needed, differently
   for chosen subject categories.

There is no rules engine behind this.

### What is not in the first version

These are not rejected forever — just not now. The data model leaves room for them, so adding
them later does not need a rebuild.

**A rules engine** — configuring conditions and actions per client, without code.

**Qualification matching** — checking whether a subject meets the target's requirements.

**Requests and assignment from the target side** — with an approval flow. The first version goes
from the subject, not from the target.

**Cascading moves** — moving one reservation does not move the chain of the next ones.

**Capacity** — one thing taking several reservations at once, up to a limit of seats. Here a room
is taken by the first reservation, and every next one is a conflict. Seat limits come later.

**An hourly axis** — the day scale is enough. Moving to hours needs no data change, because we
store dates to the second anyway.

**Calendar exceptions for a single subject or target** — for now one calendar per organization.

**Minute-level granularity, buffers between reservations, non-attendance as its own terminal
state, and availability computed from work rules** — these are requirements from a separate
appointments document. All of them can be added without a model change, so they wait for the
next version.

One thing that is easy to confuse with cascading moves: **the view of free subjects stays in the
first version.** When a date collides or a target is left without a subject, the timeline still
shows all other subjects of the same category — and a person decides. This comes from the
timeline read filtered by category (section 12), not from a separate suggestion feature.

## 5. What the module stands on

The module does not build everything from scratch. It adds a reservations layer on top of what
Open Mercato already has.

**`resources` — registry of things.** Equipment, rooms, vehicles. We do not write our own
registry. Required.

**`planner` — unavailability.** One table of rules for all subjects, told apart by a type column:
person or resource. Required — and it comes anyway together with `resources`, which needs it.

**`staff` — registry of people.** Required. Besides the registry of people it gives two things.
An approved leave request becomes unavailability in `planner` by itself, so a doctor on leave
disappears from the available ones with no work on our side. And it gives a service without
which `planner` refuses every rule write. The access check for rule writes in `planner` always
asks for that service, and only `staff` registers it — without `staff` you cannot enter even an
excavator inspection, although the permission itself belongs to planner.

The module declares this dependency directly, so `staff` is enabled together with it. There is no
state where reservations work but writing unavailability fails because a module is missing. Who
has the right to write unavailability is a separate question of permissions (section 10).

**`events` and `notifications` — notifications.** The module only announces that something
happened. Delivery is done by the existing infrastructure.

**`scheduler` — job scheduler.** It starts the daily scan: the scan looks for reservations that
are running out of time and computes conflicts with unavailability written outside our screen
(section 9). The job queue itself is a platform library, not a module — it needs no enabling and
no declaration.

Permissions, dictionaries, search and the audit log come from the platform.

### What we must add to `planner`

Writing unavailability works fully today: `staff` creates rules by itself when a leave request is
approved. Reading is missing — `planner` exposes nothing that answers the question "when is this
subject unavailable". The only public function computes the opposite — when a subject is
available — and for equipment with no work schedule it returns nothing.

So the contribution adds one read method to `planner`: "give the unavailability windows for these
subjects in this date range". The change is additive only — it touches no data, changes no
behaviour of existing screens, and widens no type list.

The method takes a list of subjects. Each one is a type, an identifier, and — if the subject has
one — the identifier of its assigned schedule. Why this split: a rule can hang in two places, on
the subject itself or on a schedule. Which schedule a subject has is known only by its registry
(`resources` for equipment, `staff` for people), and those modules sit **above** planner —
planner cannot reach into them. So the caller passes the schedule, and the provider plugin
(section 6) reads it from its own registry. In return, planner decides the precedence between the
subject's own rules and the schedule, because that rule already exists there — today the
availability editor applies it. Skipping schedules would mean an inspection entered from the
resource card is invisible to us.

The second thing the method must do differently from the existing code: expand one-off rules.
Today's window expansion skips everything that does not repeat, and an approved leave is exactly
a set of one-off rules, one per day. Without this the most important case — a person on leave —
would give no window at all.

The result is flat windows: subject, from, to. The conflict engine does not know whether a window
came from a recurring rule, from a schedule or from a leave.

**This means the contribution spans two repositories:** the reservations module and the read
method in core. The module requires a core version that contains this method. The shape of the
method is a proposal to agree with the planner maintainers — above all, whether the caller
passes the schedule or planner should resolve it in another way.

Rejected paths, for the record: copying the rule expansion code to our side would mean two copies
of the same logic that drift apart. Reading through the search index is not fit for conflict
detection, because the index catches up with a delay. Our own unavailability table would mean a
doctor's leave entered in HR is invisible to the engine.

## 6. Where subjects come from

A subject rarely comes into being in the reservations module — the doctor is already in HR, the
excavator in the equipment registry. The module should see one list of things to reserve, no
matter where they come from.

### Own list of subjects

The module keeps its own list. A row holds only what is needed to reserve: where the subject
comes from, its identifier in that registry, a name to display, a category to group timeline
rows, and whether it is still in use. No personal data and no equipment details are here — the
truth stays with the provider.

Thanks to this, a reservation always points at one kind of row, and the engine, the timeline and
conflict detection do not branch on the subject type.

### Providers

A provider is a plugin that translates between the module and one registry. The module asks it
four questions:

- **create a new subject** — the plugin writes a record in its registry and returns the
  identifier,
- **what is its name and where is its card** — to show on the list and on the timeline,
- **when are these subjects unavailable in this date range** — one question about many subjects
  at once; the answer is flat windows for the conflict engine,
- **list what you have** — a paged list of records, from which an existing subject is picked.

The package ships two plugins: **`resources`** for equipment, rooms and vehicles, and **`staff`**
for people. The second one gives leaves for free, because an approved leave request becomes
unavailability by itself.

A product can add its own plugin if it keeps subjects elsewhere. A new kind of subject needs no
change in the screens or in the engine.

A plugin registers under a name — the same name that later sits in the "provider" column.
Registration goes through the plugin registry of the reservations module: the provider's module
puts its plugin there at startup, and the reservations module asks the registry for a plugin by
name or for the list of all of them. This is the same pattern Open Mercato uses to register
shipping carriers and currency rate sources — not a key in the dependency container, because one
key there holds one implementation, and there are many plugins. The name is short and stable:
`resources`, `staff`, and for foreign registries the identifier of their module. When a plugin is
missing because its module was disabled, the subjects of that provider stay visible, but
read-only.

Both built-in plugins answer the unavailability question the same way: they read from their own
registry which schedule each subject has, and they ask the read method in `planner` (section 5).
The question is part of the contract so that a foreign registry can answer differently — for
example from its own calendar.

### How it looks in the interface

There is one list of subjects — excavators, doctors and rooms side by side, with a column that
says what each one is.

When adding, there is one choice: person or non-person. A person goes to the HR registry, the
rest go to the resources registry. Each of the two forms has its own set of fields, managed by
the administrator separately — a doctor is described differently than an excavator.

The choice is made once and saved in the row. Later nobody guesses anything.

The second path is adding something that already exists. A company that kept equipment and
people before enabling reservations picks them from the provider's list and fills no form — only
our row is created. This is a normal case, not an exception.

### Writes to foreign registries

The module creates a record in the provider's registry when that is the only place where the
thing should exist. Without this it would not be self-sufficient: adding a doctor would need a
trip to another module.

What it never does: it never copies its own truth into foreign tables. Reservations, occupancy and
conflicts live only in the module. Writing in two places without a shared transaction risks a
reservation that exists while the other module does not see it.

Adding a subject is two writes in two modules, and there is no shared transaction over them. The
order is fixed: first the record in the provider's registry, then our row. If the second step
fails, a record stays in the registry with no entry on our side. We do not hide this: the user
sees an error, and the record can be attached by the second path — "add existing". Sending the
form again would create a second record at the provider, so after such an error the screen does
not repeat the write; it offers to attach the record that was already created. The pair
"provider + identifier" is unique among our rows, so one provider record cannot be attached
twice.

Creating a record in a foreign registry is subject to that module's permissions, not ours. Who
can add a subject depends on the permissions to the registry of people or resources.

### When the provider's module is disabled

The subject row stays, and the reservation history does not break. The subject stops being
available for new reservations, and its name comes from the last remembered state.

## 7. Data model

All tables of the module look alike. The primary key is a UUID. Every row belongs to an
organization and a tenant, and every query filters by both. There is also a creation date, a last
change date and a deletion field — we do not delete rows from the database, we mark them as
deleted. The last change date has one more role: the system uses it to detect that two people
edited the same record at the same time.

Table names start with the module name and are plural, as everywhere in Open Mercato:
`reservations_reservations`, `reservations_participants`, `reservations_targets`,
`reservations_settings`, `reservations_subjects`.

### 7.1 Reservation

| Column | What it holds |
|---|---|
| target | pointer to a target row; required |
| from / to | time window: the start of the first day and the start of the day after the last one, in the company's time zone; both empty means the reservation waits to be placed |
| status | planned, active, completed, cancelled |
| duration | in working days, in steps of half a day |
| expected start | the date by which the reservation must be on the timeline; always required |
| last reported warning | how many working days were left at the last signal, zero when the deadline has passed; empty when nothing was reported |
| note | free text |

**A reservation without dates is a normal state.** A commitment that has no window yet — in the
interface "unplaced". It is not broken and not wrong.

**Status is not the same as placement.** A reservation can be active and still unplaced, or only
planned but already on the timeline.

Statuses split into open (planned, active) and closed (completed, cancelled). Allowed
transitions:

```
planned    → active                     someone confirms the work has started
open       → completed | cancelled      closing is allowed from any open state
completed  → planned | active           undoing a mistake
cancelled  → nothing                    terminal state; a restart is a new reservation
```

Every other transition is rejected. Occupancy and conflicts count only open reservations.
Bringing a completed reservation back to open restores occupancy and follows the same rules as
placing (section 9).

A person or the product changes the status, never the passing of time. The module does not flip a
reservation to "active" at midnight on the start day — it could not do that for a reservation
without dates.

**Interval bounds.** An interval is closed on the left and open on the right: "to" is the start of
the day after the last working day. Two intervals conflict when one starts before the other ends
and ends after the other starts — touching intervals do not conflict. The same rule works for
reservations and for unavailability windows.

**Duration is the input, the end is computed.** When placing, the user gives the start day, and
the server computes the end from the duration and the working calendar. "Resizing" a bar changes
the duration, and the end is computed again. The end is never given directly, so the three fields
cannot drift apart.

**Half a day on a day scale.** A half extends the end by a full day: 2.5 days take three working
days on the timeline, and the last one is a half day. Conflicts count whole days — two half-day
reservations on the same day are a conflict, because on a day scale we cannot tell morning and
afternoon from morning and morning. So the half is information for planning and totals; it does
not decide occupancy. When we move to hours, this rule disappears by itself.

Three things are guarded by the database itself: the from/to pair is set fully or not at all, "to"
is after "from", and the duration is positive and goes in steps of half a day — the numeric type
alone would let one third through. We declare these constraints on the entity, not by hand in the
migration. A constraint added by hand does not reach the saved schema snapshot and leaves a drift
that nothing fixes later.

The expected start is not part of these constraints, because it is always required. The coverage
warning is counted from it, so a reservation without it would be invisible to alerts. A
reservation created directly on the timeline gets an expected start equal to its start date.

### 7.2 Reservation participants

| Column | What it holds |
|---|---|
| reservation | which one it belongs to |
| subject | pointer to a row in the subjects list (section 6) |
| role | performer, place, supporting equipment |

The role comes from a closed list. The first version always writes "performer". The same subject
cannot appear twice in one reservation — it would conflict with itself.

The reason: one reservation can take several things at once. A visit takes a doctor and a room, a
service job takes a bay and a technician. If the subject sat in a column of the reservation, the
only way out would be two separate reservations. Then cancelling one leaves the other busy,
because nothing ties them together.

**The first version always writes one participant.** There is no screen to add a second one. The
point is only that adding it later does not require splitting a column into a table and
rewriting every read, every conflict query and the whole timeline.

The engine counts occupancy separately for each participant. A reservation is in conflict if at
least one of its participants is.

### 7.3 Subjects

| Column | What it holds |
|---|---|
| provider | which registry the subject comes from |
| provider id | its key in that registry |
| name | a copy of the name, to show on the list and the timeline |
| category | to group timeline rows and for conflict policy exceptions (section 9) |
| in use | whether it can still be reserved |

The name is a copy, not the source. It refreshes when the provider reports a change; when the
provider's module is disabled, the last known one stays. No other data about the subject lives
here.

The pair "provider + identifier" is unique among non-deleted rows. When someone deletes a subject
and adds it again, the write code finds the deleted row and restores it instead of creating a
second one — the reservation history stays with the same row. The index alone does not force
this; it only does not block adding the same doctor again forever.

### 7.4 Target

| Column | What it holds |
|---|---|
| name | name of the target |

A target is someone or something that comes back. "Peter" stays in the database for good, and the
next reservations simply attach to him. A target has no dates — the reservation has dates.

If a target meant a single rental, a customer coming for the twentieth time would have twenty
entries. Nothing would tie them together, and a fix in the customer's data would mean twenty
fixes.

The core does not know what a target is. It holds only the name; phone, e-mail, address and
everything else is added by the product — as its own fields or as a link to its own entity: a
site, a patient, a customer. Changing them lives there too. None of these fields is in the core.

When creating a reservation, the target is picked only from a list, with a search box. A new
target cannot be typed in — otherwise the same person would enter the database in several
spellings, and the history would fall apart.

### 7.5 Module settings

One row per organization. It is created on the first read of the settings, with default values —
nobody has to create it by hand, and an organization added later gets it the same way as the first
one (section 14).

| Column | What it holds |
|---|---|
| free weekdays | which days do not count as working days |
| holidays | list of dates |
| warning threshold | how many working days before the expected start to warn |
| time zone | the organization's zone, as a name from the standard list |
| conflict policy | default mode `advisory` or `reject`, plus exceptions for chosen subject categories — two columns; at start `advisory` with no exceptions (section 9) |

The working calendar is state here. The free-day windows that follow from it are not stored
anywhere, because they can be computed from these settings.

**Changing settings does not recompute stored reservations.** The end of a reservation is computed
when it is placed or resized, and it stays; a new holiday does not move bars already on the
timeline — the dispatcher sees a bar on a free day and decides whether to move it. Changing the
time zone does not move stored instants; the new day boundary applies from the next write.
Changing the warning threshold takes effect from the next scan, and the counter on the reservation
serves only to filter out repeats — after a threshold change the scan may emit one extra signal,
and that is fine.

This is the only table without a deletion field. One deleted row would block creating new
settings for that organization forever, because the pair "organization + tenant" must be unique.

## 8. Working calendar and time zones

### We keep the working calendar on our side

Free weekdays, holidays and the time zone are module settings (7.5). The zone sits on the same
screen as free days and holidays, because it answers the same question: what does "a day" mean in
this company. All dates in the module — on the timeline, in lists and in forms — are shown and
stored according to it.

They are not rules in `planner` and not an entry in the platform configuration. The reason:
`planner` holds rules pinned to a specific subject, and the working calendar is not about any
subject — it is about the whole company.

We do not store free days anywhere separately. They can always be computed from these settings.

### The company's zone decides which day it is

Not the zone of the person who looks, and not UTC.

If the viewer's zone decided, the same reservation would fall on different days for different
people. UTC fails the same way: "from 3 to 5 August, from local midnight" read in UTC gives 2–4
August. We show the viewer's zone when it differs from the company's, but it never moves a
reservation.

### What sits in the database

We store exact instants, saved in UTC. The start and end of a day are computed in the company's
zone, not at UTC midnight — in a real zone the day does not always start at the same hour.

Duration is counted by calendar dates, not by adding twenty-four hours. A working day is a
calendar day, so a day of 23 or 25 hours breaks nothing.

### Entering and showing

In timeline operations the user gives a date, and the server computes the instant in the
company's zone. The browser decides nothing. Next to every shown date you can see which zone it
is in — the same zone is one hour off UTC at one time of year and two hours at another.

Clock changes are settled in code. In spring 02:30 does not exist, so such an entry is moved
forward. In autumn 02:30 happens twice, so we take the first one. The machine that happens to do
the computing must not decide this, because the server and the browser would store two different
instants for the same entry.

We accept only zone names from the standard list and check them on write. A bare offset like
"GMT+3" is rejected — it says nothing about when the clock changes.

### Zones do not reach the engine

The conflict engine gets time intervals and nothing more. A reservation and an unavailability
window look the same to it. Working-day arithmetic also works on dates alone. The zone matters
only at the edge, where a date turns into an instant.

### We read unavailability windows the same way planner does

An unavailability rule has a time zone field in the database. Nobody uses it: the code that turns
a rule into concrete days counts in UTC, and repetition steps by exact 24 hours and 7 days. So at
a clock change such a rule shifts by one hour against local time.

If we computed these rules on our side using the stored zone, our timeline would show different
days for the same rule than the planner screens. We choose consistency: we read windows exactly
as planner does, in UTC, and we say so openly, instead of promising zone support that the stored
data cannot deliver.

Fixing this on the planner side would change the behaviour of a working module and raises a
separate question about rules already stored. It is out of scope for this work.

There is one side effect we must handle on our side. An all-day window stored as a UTC day does
not match a day in the company's zone — in Poland in summer it is off by two hours. If we
compared to the second, a Tuesday reservation would get a conflict with a Monday leave.

So on the day scale we compare days, not instants. The days of a planner window are the UTC dates
from its start to its end (end exclusive), with no conversion through the company's zone — that
conversion is exactly what would push a Monday leave onto Tuesday as well. A window shorter than a
day counts as its whole day. A reservation conflicts with a window when one of its days is a day
of the window.

Example: a Monday leave sits in the database as Monday 00:00 UTC to Tuesday 00:00 UTC. In Poland
in summer that is Monday 02:00 to Tuesday 02:00, but the day of the window stays Monday alone, so
a reservation from Tuesday does not conflict. When we move to the hourly scale, this rule needs a
second look, and we will return to it then.

## 9. Conflicts and coverage warnings

### What a conflict is

Two reservations of the same subject that overlap in time, or a reservation that falls into its
unavailability window. Planned and active reservations count — completed and cancelled ones free
the slot.

A conflict concerns a pair, and detection is symmetric — it does not matter which was written
second. The write outcome is not symmetric: in reject mode the one who writes later loses.

### A pure function computes it

The engine gets lists of intervals and returns a list of conflicts. No database, no framework.
The same code runs on the server and in the browser, so a conflict is visible already while
dragging a bar on the timeline, before the write.

### Two paths

```
read     the view recomputes conflicts every time the timeline is shown
push     after a write an event goes out; alerts and notifications are made from it
```

The push path is triggered by every write on our side that changes occupancy: placing, moving,
resizing, and bringing a closed reservation back to open. Each one recomputes the subjects of
that reservation.

Unavailability windows are written by other modules — HR when a leave is approved, an employee on
their own screen, and also our own form, which sends the write straight to planner (section 10).
None of these writes passes through our server, and only some of them announce themselves with
an event. So the source of truth about conflicts with unavailability is the daily scan described
below: it computes them from scratch for the coming period and reports the ones that were not
there before. Rule-change events — where planner sends them — only speed things up: we subscribe
to them and recompute at once, but nothing depends on whether they arrived. Which write paths
announce themselves with an event is something we will settle in code, not in this document.
After a window is written from our screen, the browser asks our conflict read for that subject,
so the dispatcher sees the effect at once, without waiting for the scan.

### When we compute

It depends on the mode (below). In `advisory` mode — after the write commits, in the same request;
the result comes back in the response, because the screen has to show what happened anyway. In
`reject` mode we check the overlap of reservations **before** the commit, in the same transaction
as the write — after the commit there would be nothing left to refuse. Conflicts with
unavailability are computed in both modes after the commit and returned in the response, because
they never block.

Not in the background on an event — background delivery can be delayed and retried, so there is
no certainty that anyone computed that conflict.

We compute on the committed state of the database, not on the search index. The index catches up
with a delay and may not know a reservation from a second ago.

### Warn or reject

An organization setting, not a rule in code.

```
advisory   the write goes through, the conflict is shown and reported    ← default
reject     a write that creates a conflict fails
```

**Rejection applies only to two reservations overlapping.** A conflict with an unavailability
window always warns, in both directions — a reservation is not lost because of an inspection, and
an inspection is not lost because of a reservation. A breakdown does not ask about the schedule.

When dispatching equipment a person decides, hence `advisory` as the default. When booking visits
a second person for the same slot must be refused, hence the second mode.

The mode has two levels: a default for the organization and exceptions for chosen subject
categories. A clinic sets `advisory` as the default and `reject` for the "doctor" category — two
visits with the same doctor fail, two jobs for the same portable ultrasound only warn. When a
reservation has several participants from different categories, the stricter mode applies.
Splitting by reservation type, not subject, does not change the data model and can come later.

### The lock under reject

A check before the write is not enough on its own: two parallel writes check "free?" before
either commits, and both pass.

So under `reject` the check and the write go in one transaction, preceded by a lock on the
subject. When a reservation has several participants, we take the locks in a fixed order, by
subject identifier — otherwise two parallel writes could block each other. An exclusion
constraint at the database level would handle this without a lock, but it needs a database
extension that no module migration in Open Mercato has created so far — that is a platform
decision, not a module one.

### Coverage gap warning

A reservation can exist without dates — it is a commitment that has no window yet. When few
working days are left until the expected start and the reservation is still unplaced, the module
emits a signal "in X days". The settings say what X should be.

This applies only to planned and active reservations. A cancelled or completed one needs no
subject, so it does not warn.

It is a warning, not an action. It blocks nothing and assigns nothing by itself.

A deadline that has already passed is a separate state. "In −2 days" means nothing; the
reservation is then overdue, and that is how we show it. The day counter stops at zero, so an
overdue reservation gets one signal — when it becomes overdue — and the scan does not repeat it
until someone places or closes the reservation. Placing clears the "last reported warning"
column.

A pure function computes this: it gets the expected start, today's date, the working calendar and
the threshold, and returns the number of working days to the deadline. The calendar comes in as
input data, not as a dependency — so the same function runs on the server and in the browser.

The warning has two paths, like a conflict:

```
read     the screen computes "in how many days" every time it is shown
push     once a day the scan emits an event for those that entered the threshold
```

For conflicts the scan replaces the events that planner does not send. For coverage gaps it is
the only possible trigger: the reservation lies untouched, and the deadline comes closer by
itself. On Monday six working days are left, on Tuesday five, and it is Tuesday that has to emit
the signal, although nothing happened in the system.

The scan does one more thing: it turns the counter for someone who has had the screen open since
yesterday. The event goes to the browser, so "in 3 days" becomes "in 2 days" without a refresh.

It is started by the platform's job scheduler: one system-level entry, shared by the whole
installation, puts a job on the queue, and the module's background worker walks through all
organizations one by one. One entry instead of one per organization — then an organization added
later has nothing to be forgotten, and the scheduler has a limit of active entries per tenant. The
scan itself computes within one organization, because the working calendar, the threshold and the
time zone are its settings. The entry fires every hour, and an organization is processed when a
new day has just begun in its zone — the day turns over in the organization's zone, not the
server's, otherwise a company in the east would get its signal a day late.

The scan does not emit signals blindly. It computes the state for today and compares it with the
"last reported warning" column on the reservation. The signal goes out only when the number of
days has changed, and the same column is then overwritten. Otherwise the same warning would go
out five days in a row.

For conflicts we keep no state. The event carries a grouping key, and the notifications layer
merges repeats (section 12).

The same run computes conflicts with unavailability for the coming period and reports those that
the previous run did not see — no matter whether an event about the window change arrived.

There is one rule and it is computed in one place: the same code feeds the screen and the scan.

## 10. Unavailability

### Where it lives

In `planner`, in one table of rules for all subjects — person and resource. The reservations
module creates no unavailability table of its own and copies nothing from there.

This is different from the working calendar: the calendar says when the whole company works,
unavailability concerns one subject.

### Who writes it

```
HR, approved leave            the rule is created by itself, with no part from our module
the employee on their own     the "my availability" screen in the HR module
our screen                    service, inspection, equipment breakdown
```

The third path is ours: the module has its own unavailability form, because otherwise it would
not be self-sufficient — entering an excavator inspection would need a trip to another module.
The write goes to the same table in `planner`, where unavailability lives. We do not create a
second place for the same information.

We learn about writes outside our screen from the scan, and — where planner sends an event — at
once (section 9).

Writing unavailability is subject to the permissions of the availability schedules, not ours. In
practice this means a person with the right to manage other people's availability writes it — on
our side the administrator. A view-only role cannot do it, even with the right to manage
reservations.

The write itself does not pass through our server. The form is ours, but the browser sends it
straight to the existing rule write endpoint. This way the same access check as always applies,
and we add nothing to core beyond the read method. The opposite version — a write through our
server — would require repeating planner's permission check on our side, and we do not want to
copy it.

The consequence for conflicts: our server does not see this write, so it cannot return conflicts
in its response. After a successful write the browser asks our conflict read for that subject and
range — a second request, the same screen. The notification about such a conflict is emitted by
the scan (section 9).

### How we read it

Through the provider plugins (section 6): for each provider one question about all its subjects
in the date range. The built-in plugins ask the read method added to `planner` (section 5),
adding the subject's schedule from their own registry. We ask in bulk — one display of the
timeline is dozens of rows, so asking about each one separately would be a waste.

We read windows as UTC time, for the reasons described in section 8.

### What happens to it next

The intervals go to the conflict engine next to the reservations. A reservation that falls into
an unavailability window is a conflict — always reported, never blocking, in both directions: on a
reservation write in the response, on a window write in the second request from the screen, and
in the scan (section 9).

On the timeline, windows are shown as the background of the subject's row, so the dispatcher
knows why a slot is marked.

## 11. Timeline

### Why not the ready component

`@open-mercato/ui` has a ready calendar view for day, week and month, built on a calendar library
that is already a dependency of that package. It does not fit here for two reasons.

**It lacks what a reservation timeline needs:**

```
one row per subject across many days   the base of the view; the calendar library can
                                       show resources only as columns within one day
dragging and resizing existing bars    the dispatcher moves and extends existing bars
smooth zooming of the scale            from a few days to a few months
staying smooth with thousands of bars
```

**It counts days in the browser's zone.** Expansion of recurring entries uses local date methods,
so "every Monday" means Monday for whoever is looking. This contradicts the rule from section 8
that the company's zone decides the day: two people in different zones would see the same entry
on different days. Reconciling this would mean rewriting that code.

So we do not touch the ready view or any shared contract — it stays as it is.

### What we build

A light component fed by properties, with no knowledge of the domain. It knows nothing about
reservations, subjects or any module: it gets rows, bars, days to grey out, and labels.

One row is one subject, reservations are bars, conflicts are marked, free days in the background.
Day scale now, hourly later — with no data change, because we store dates as instants anyway.

### `vis-timeline` as a conscious decision

Drawing is based on `vis-timeline`. It is a new production dependency, and we choose it
consciously, because it gives everything from the list above out of the box, including the hourly
scale that we will need after the first version. We checked the alternative: adding a row layout,
dragging of existing bars and zooming next to the calendar library from `ui` is a timeline engine
written from scratch — more code than the whole component on `vis-timeline`.

Two safeguards:

**Loaded lazily** — the library code is downloaded only when the timeline screen is opened, so it
does not weigh on the rest of the application. This is the same rule that core guards with a test
for its own heavy libraries; on our side a test in the module package guards it.

**Closed in one file** — the component gets its data through properties and does not know what
draws it. Swapping the library is replacing one file, not rewriting the view.

### On duplicating logic

The `customers` module has three pure functions that at first sight overlap with what a
reservation timeline needs: detecting overlapping entries, packing them into columns, and
snapping to a grid while dragging. We checked each one.

```
packing into columns     about columns within one day in a day calendar
                         here every subject has its own row — does not apply

snapping to a grid       computes position within a day, in browser time
                         our scale is daily, and we avoid browser time

overlap detection        the shared core is about twenty lines
                         the rest assumes a conflict is a shared user
                         and knows nothing about unavailability windows
```

So we write our own overlap detection — the fourth in the platform, but it is about twenty lines
of a pure function that, besides reservations, knows unavailability windows and does not assume
that a conflict is a shared user. Extracting the shared core into `shared` and wiring the
`customers` calendar to it makes sense to us — as a separate change in core, with its tests, not
as a condition of this contribution, which already spans two repositories.

### Three levels of use

```
engine and calendar arithmetic   pure functions, imported without enabling the module
timeline component               fed by properties, no knowledge of the domain
ready board screen               works on the resources registry as soon as the module is on
```

The consumer takes the level it needs.

## 12. Module surface

### What the module exposes

```
targets                      plain write and read through the route factory
subjects                     read and list through the factory; adding goes through the
                             provider plugin, because the record is created in its registry
                             (section 6)
reservations                 list, details, editing single fields
place / move / resize / change status
                             undoable commands; cancel is an alias of a status change
timeline read                one request: subject rows, reservation bars, unavailability
                             windows and calendar state; paged by rows, filtered by subject
                             category
conflict read                conflicts of subjects in a date range; the screen calls it after
                             a window write
"unplaced" list              a separate, cheap read of reservations without dates
settings                     read and write
occupancy for other modules  a service available through dependency injection (below)
unavailability               no write endpoint of its own — the form sends the request to the
                             existing availability schedules endpoint
```

The timeline read is one request on purpose: the screen needs all four things at once, and four
separate queries would give flicker and four different moments in time. The category filter gives
the view of free subjects from section 2: the same rows, and you can see which ones have no bar in
a given window.

### Occupancy service

The only server-side entry for other modules. Question: a list of subjects and a date range.
Answer: for each subject a list of busy intervals, each with the identifier of the reservation and
the target. It counts only open reservations. It does not add unavailability — that is different
information, asked from the provider plugins (section 6). It answers in bulk, without paging; the
date range limits the size of the answer.

### Undo

Commands are undone by the platform's command mechanism: each one saves the state before the
change and can restore it. Undo is a write like any other — in reject mode it goes through the
same overlap check, so it will not restore a conflict that a normal write would not let through.

### Write and conflict

In advisory mode a write that creates a conflict **is not an error**. It succeeds, and the list of
conflicts comes back in the response.

In reject mode the write fails and returns an error with the reason — which subject and which slot
collide — so the screen can show it instead of saying "could not save".

### Things that are easy to forget

Every route exports a description for the API documentation — those from the factory and those
written by hand. Without it, the route is not in the documentation.

The last change date does not appear in list responses by itself — it has to be listed explicitly
among the returned fields.

For locking under concurrent edits we use the variant with guards, which the platform points to
for new call sites. The coverage test in core rejects new direct uses of the older variant unless
they are on the allow-list — we do not want to end up there.

### Events

Names are a contract and do not change after release. Pattern: module, entity, action in the past
tense.

```
reservations.reservation.created / .updated / .deleted
reservations.reservation.placed / .moved / .resized / .cancelled
reservations.conflict.detected
reservations.coverage_gap.detected
```

Events about reservation changes also go to the browser, so open screens refresh by themselves,
without a reload.

The module declares its own notification types, and the platform's infrastructure delivers them.
The types are `reservations.conflict` and `reservations.coverage_gap`. Background jobs go through
the `reservations-scan` queue. Notifications are merged by a grouping key: conflicts by subject,
gaps by target — so the dispatcher does not get ten notifications about the same excavator.

### Permissions

Three: view, manage reservations, manage settings. Their identifiers are `reservations.view`,
`reservations.manage_reservations` and `reservations.manage_settings`. The occupancy service for
other modules is called `reservationsOccupancyService`.

After the module is enabled, the administrator gets all three, and a regular employee gets view —
the module works at once, without granting permissions by hand; in an existing installation after
a one-time sync of role permissions (section 14).

One permission from outside the module is added to this: writing unavailability windows requires
the right to manage availability in the schedules. It belongs to `planner`, not to us, and its
check works only with the service from the HR module (section 5).

## 13. Tests as the definition of done

Integration tests come in the same change as the code. Each one sets up its own data, preferably
through the API, and cleans up after itself. None relies on demo data.

This table is also the definition of done: until a row has coverage, the module is not finished.

| Area | What must be covered |
|---|---|
| targets and subjects | write and read within organization bounds; rejection on a stale record version; deleting and re-adding the same subject returns to the same row |
| providers | creating a subject through each plugin; attaching a record that already exists in the registry; a subject from a disabled provider module does not disappear from history and takes no new reservations |
| read method in planner | windows from the subject's own rules; windows from the schedule's rules when the subject has none of its own; own rules switch the schedule off; one-off rules (leave) give windows; empty result for a subject with no rules |
| place / move / resize | end computed from duration and the working calendar, including 2.5 days = three days; rejection for a closed reservation; rejection on a stale version; placing clears the warning counter |
| status change | every pair from the transition matrix: allowed ones pass, disallowed ones are rejected; closed ones free the slot; bringing a completed reservation back to open recomputes conflicts and can fail in reject mode |
| participants | conflict counted separately for each participant; the same subject twice in one reservation is rejected |
| interval bounds | touching reservations do not conflict; overlapping by one day conflicts; "to" before "from" rejected by the database |
| conflicts, advisory mode | the write passes, conflicts come back in the response |
| conflicts, reject mode | a second write for the same slot fails, and the error names the subject and the slot; two parallel writes — only one succeeds |
| conflict policy | default mode from settings; a per-category exception wins; a reservation with participants from different categories gets the stricter mode; changing the setting changes the write behaviour |
| conflict with unavailability | always warns, never blocks; on a reservation write it comes back in the response; a window written directly in planner is visible in the conflict read and detected by the scan |
| day of a planner window | a Monday leave stored as a UTC day does not conflict with a reservation from Tuesday in a UTC+2 zone; it conflicts with a reservation that covers Monday |
| timeline read | response shape: rows, bars, windows, calendar state; paging by rows; category filter; conflict computed on read; only subjects of the own organization |
| "unplaced" list | reservations without dates, paged, own organization only |
| settings | the row is created on first read with defaults; write and read; rejection of an invalid time zone; another organization's settings are not visible |
| time zones | day resolved in the company's zone, not the browser's; both clock-change cases |
| coverage gap, read | working days counted from the calendar (free days, holidays); a passed deadline gives the "overdue" state and zero days; the same result on the server and in the browser |
| reconciliation scan | signal when the day count entered the threshold; a second run the same day emits no second one; an overdue reservation signals once; an organization is processed when the day began in its zone; a conflict from a window with no event is detected |
| events | each of the eight events emitted by the right write; reservation events reach the browser |
| notifications | two conflicts of the same excavator merged into one notification; gaps merged by target |
| permissions | a view role does not write; manage reservations without the planner right does not write a window; the administrator does |
| board screen | rows and bars draw, conflicts are marked, the view refreshes after an event; the timeline library loads only on this screen |
| forms | creating a reservation, saving a target, saving settings; the unavailability form sends the request to the planner endpoint and, after success, calls the conflict read (a contract test, not a pass through our server) |

## 14. Translations, logs, deployment

### Translations

Every string the user sees sits in the module's translation files, in all languages required by
the platform's translation sync check — today that is English, Polish, Spanish, German and
Korean. No labels are hard-coded in the code.

The timeline component translates nothing by itself. It gets ready strings from outside, so the
screen that embeds it does the translating — through the platform's translation mechanism, like
every other screen. Thanks to this, the component can be taken into another product without
changes.

### Logs

We log with the platform's tool, in fields, not in glued sentences. How much to log is set in the
environment.

What happens in the module is best seen through its events: what was placed, where a conflict
came up, where a coverage gap is coming. They can be listened to with a subscription, sent to the
browser or turned into a notification. The module adds no counters or charts of its own.

### Where the module lives

It is an official module, enabled separately in each application — not part of the platform
core. Reservations are a layer above the resources registry, HR and the availability schedules,
not a foundation they stand on.

One thing needs a separate answer because of this. The platform has four tests that guard whether
entities and commands handle concurrent edits correctly. They scan only the core repository, so a
module in a separate repository escapes them. So we move their equivalents into our package and
run them on our side. The same thing is guarded, only in a different place.

Beyond that, the module meets what the repository requires from every new module: lazy loading of
heavy libraries, design system lint rules at error level, the indexer marker on every factory
route, mutation guards on hand-written routes, the schema snapshot in the same commit as the
migration. The list is in the PR description, not here.

### Enabling and disabling

The module's migrations only create new tables and touch nothing that is already in the database
— so enabling it on a running installation is safe. Permissions for the default roles and demo
data are created by the module setup that the platform runs when a tenant is created. For an
installation that already exists, the platform commands for seeding defaults and syncing role
permissions do the same — we list them in the enabling instructions.

Two things without which the module stays silent need no step at all: the settings row is created
on the first read (section 7.5), and the daily scan has one system-level entry in the job
scheduler and walks through the organizations by itself (section 9). An organization added after
the module is enabled is handled the same way as the first one.

Disabling is deactivation. Tables and data stay, and nothing outside the module depends on them.

One reservation: the module requires a core version that already has the read method for
unavailability windows (section 5). We declare this as a peer dependency of the package, and in
addition we check at module startup whether the method is available — without it the module
reports a configuration error instead of pretending there is no unavailability. Enabling the
module alone will not stop this; compilation stops it, and in a running installation the startup
check does. Release order: first core with the method, then the module pointing at that version.

The write check for unavailability windows in planner works only with the service from the HR
module (section 5), so HR is declared as a dependency and is enabled together with reservations.
An installation that reserves only equipment gets it too — it looks like excess, but without it
nobody can enter an inspection or a breakdown.

There are four dependencies in total: the resources registry, the availability schedules, HR and
the job scheduler. We declare two directly — HR and the job scheduler; the resources registry and
the availability schedules come with HR, because HR itself requires them. The job queue is a
platform library, not a module, so it is not on this list. Enabling reservations on a clean
installation pulls in all four. This is a conscious cost: without registries there is nothing to
reserve, without schedules there is no unavailability, without the scheduler there are no
coverage warnings.

## 15. Dependencies and conventions

### Which direction we reach

The module reads from the availability schedules and from the subject registries. It writes there
only when it creates a thing that should live in that place: a person in HR, equipment in the
resources registry, an unavailability window in the schedules. It never copies its own truth
there — reservations, occupancy and conflicts stay with the module.

### No table relations across module boundaries

For foreign records we keep only the identifier, without joining tables through the relation
mechanism. When a query must reach across a module boundary — for example to sort reservations by
subject name — the join is given in that specific query, not declared once for good. When a
foreign record must be read by identifier — for example a subject's schedule — the provider
plugin does it through that module's entry point, not with a query to its table.

### Writes

Every change goes through a command. What happens after it — sending an event, clearing the cache
— fires only after the write commits, never during it.

Input is validated with a schema, and every query filters by organization and tenant.

### The core does not know where data comes from

The conflict engine and the working-day arithmetic know nothing about routes, commands or the
database. The write and read layer sits above them and follows the rules of the project it lives
in.

So the core moves without changes, and only what surrounds it is adapted.

## 16. What changed and what we do not know yet

### Changes since the reviewed version

Heaviest first.

**People are a full subject.** The previous version cut them from the scope, arguing that the
platform has no registry of people. There is one — the HR module. When adding a subject, there is
a choice: person or non-person, and it decides where the record lands and which form the user
sees.

**The module keeps its own list of subjects.** A new section describes how a subject gets into
the module from any registry, what a provider must be able to do, and what happens when its
module is disabled. The previous version had a column for this but no mechanism. Providers
register through a plugin registry of the module, not through a key in the dependency container.

**A reservation can take several things at once.** The subject moved from a column to a separate
participants table. The first version always writes one, but adding a second one needs no
rebuild.

**A conflict can be rejected.** The behaviour is a setting: advisory or reject, advisory by
default. The mode has a default for the organization and exceptions for chosen subject
categories; with several participants the stricter one applies. Rejection applies only to
overlapping reservations; a conflict with unavailability always only warns.

**Conflict detection moved from the background to the response of a reservation write.** Under
advisory it is computed after the commit, under reject the overlap check runs before the commit,
in the transaction. A window write is handled by a separate conflict read called from the screen,
and by the scan.

**The daily scan is the source of truth for unavailability changes.** Rule-change events, where
planner sends them, only speed things up. The document does not claim which write paths send
them.

**The target is a permanent entity.** No dates, picked only from a list, no free typing. Address is
no longer a core field.

**We add a read method for unavailability windows to planner.** The previous version promised
that the module works on an untouched planner — that sentence is gone, because the mechanism it
relied on does not exist. The caller passes the subject's schedule; planner decides the precedence
between own rules and the schedule and expands one-off rules. The shape of the method is a
proposal to agree with the planner maintainers.

**We take unavailability windows as ready instants** and do not convert them through the zone
stored on the rule — the platform does not use it either. On the day scale the day of a window is
the UTC date of its start, with a numeric example.

**The model is pinned down:** half-open intervals, touching ones do not conflict; duration is the
input and the end is computed; half a day extends the end by a full day and conflicts count whole
days; a closed matrix of status transitions; the warning counter stops at zero; bringing a closed
reservation back to open recomputes conflicts; changing settings does not recompute stored
reservations.

**Table names got the module prefix**, and constraints on two columns are declared on the entity
instead of added in the migration.

**Settings are created on first read, and the scan has one system-level scheduler entry.** No
per-organization setup step.

**The reason for our own timeline was replaced with the real one**: no rows per subject, no
dragging and resizing of existing bars, and counting days in the browser's zone. The library
choice is declared openly, with the alternative we checked.

**Our own overlap detection now, a shared core in `shared` as a separate change.** The `customers`
functions were checked one by one; the shared part is about twenty lines.

**The module is official, not core** — with a commitment to move into our package the four tests
that guard concurrent edits in core.

**The core version requirement is a peer dependency plus a startup check.** Release order: core
first, then the module.

**The module creates no subjects of type "rule set".** Every subject of ours is a person or a
resource. Schedules stay on the read side: the method in planner gets the subject's schedule from
the caller and adds its rules by itself (section 5).

**Added:** the occupancy service contract, undo of commands, the conflict read, the timeline
filter by category, and the missing test rows. Translations cover five languages.

### Risks

| Risk | What we do about it |
|---|---|
| the module requires a core version with the unavailability read method | peer dependency of the package and a check at module startup; release order: core first, then the module |
| the planner maintainers change the shape of the proposed method | only the two built-in plugins call it; a signature change is a change in two files, the engine and the timeline see no difference |
| the platform description in this document may go out of date | we limit it to rules and behaviour, with no function names or line numbers; state checked against release 0.7.0 |
| a conflict from a leave entered outside our screen shows up in notifications only after the scan, up to a day later | events, where they exist, shorten this to seconds; the timeline computes conflicts on every read, so the screen shows them at once |
| a mismatch between our company zone and UTC counting on the schedules side | the boundary is described: the zone works on our side, external windows are treated as ready instants, the day of a window is the UTC date of its start |
| a new dependency for drawing the timeline | loaded lazily, closed in one file, replaceable without touching the view |
| our own list of subjects must keep up with the source registry | the row holds only a pointer and a display name; when the provider module is unavailable, history stays untouched |
| reject mode relies on locks on subjects | the lock is held only for one transaction and covers single subjects, not the whole table; with several participants we take them in a fixed order, so two parallel writes do not block each other |
