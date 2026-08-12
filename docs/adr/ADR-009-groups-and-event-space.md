# ADR-009 — Groups and event space are not room-nights

**Status:** accepted · implemented

## Context

The extranet could sell a transient room-night the day it was built. It could
not sell either of the two things a hotel's commercial team actually spends its
week on: a group, and a salón.

Both look like they should fit the existing model, and neither does.

A group is not a booking with a bigger number. The inventory is **declared**
rather than observed, the price is **negotiated** rather than published, and
the terms include arithmetic — "una gratuidad por cada 20 habitaciones" — that
both sides have to be able to reproduce months later. A salón is not a room
type: it is sold by time or by head, its capacity depends on how the chairs are
arranged, and half its revenue is in the videobeam and the coffee break.

Forcing either through ARI would produce a rate per night for something nobody
rents per night, and would put commercial negotiation into an append-only
ledger designed for channel-manager feeds.

## Decision

**A new service, `groups` (port 3180), owning both domains.**

The split follows the same rule as every other service boundary here: failure
isolation and scaling curves. Group work is low volume, long-lived and
**deadline-driven** — its unit of time is the hour, not the millisecond. A
negotiation stuck for a day must never slow a search, and a search spike must
never delay the sweeper that expires a 24-hour offer.

### Inventory is declared, and has two constraints, not one

A block carries per-bedding maxima **and** a physical ceiling. These are
different numbers and conflating them is the classic group oversell: the same
twenty rooms can be made up twin *or* double, so a block of 20 legitimately
offers "up to 18 twin" and "up to 20 double" at the same time — while only
twenty rooms exist.

`blockCapacity` computes both. `canBlockTake` checks both, plus whether the
people actually fit in the beds, and reports **every** failure at once. An
agency that has to resubmit three times to learn three problems goes elsewhere.

Availability is **derived from the requests**, never stored as a counter. A
counter that has to be maintained is a counter that drifts, and a drifted group
counter is a double-sold block.

### The comp room is priced, not just counted

`computeGroupBenefits` grants one unit per N **paid** rooms — 21 rooms with a
1-per-20 rule earns one free room, not one and a fraction — and states which
basis it used. `PER_NIGHT` multiplies by nights; `PER_STAY` does not.

The number that matters is `netAdr`, and it is the one hotels most often miss:
**fifteen rooms at 100 with one free is not 100 a room.** The comp room occupies
room-nights that are never billed, so the same money spreads over more nights.
The engine computes both figures and shows the difference.

Both the shortfall and the floor total come off the raw money, never off the
rounded ADR. Deriving a shortfall from a two-decimal ADR loses cents per
room-night and turns an exact 1,000 into 999.90 — the kind of number a hotel
notices and stops trusting the tool over.

### The negotiation is append-only and on a clock

Rounds are rows, never edits: both sides must be able to show what was said and
when. The expiry is computed once from the hotel's own response window and
stored on the request, so the countdown the hotel sees and the deadline the
sweeper enforces are literally the same value.

**A live offer holds inventory.** Without that, two agencies negotiate over the
same twenty rooms and both are told yes.

The one subtlety worth recording: when re-checking capacity in order to
**accept** a request, that request's own hold must be excluded. Counting it
against itself means no group can ever be accepted once a block is tight — a
bug that hides completely while there is slack and appears the moment a second
group arrives. It was caught by running the smoke suite twice.

`evaluateBid` returns a **verdict, never a decision**. A hotel accepting below
its floor to fill a shoulder date is a legitimate commercial choice; the
engine's job is to make sure nobody makes it by accident, which is why the
shortfall is expressed in money. The single automatic path — auto-decline below
floor — is a rule the hotel switched on itself, is off by default, and is
recorded as `settledBy: policy:autoDeclineBelowFloor` rather than attributed to
a person.

### Notifications are recorded, never assumed

Email needs SMTP credentials. WhatsApp needs a Meta Business account, a
verified sender, and a **template approved by Meta** before one business-initiated
message may be sent outside a 24-hour window — an approval that takes days and
cannot be substituted with an API key.

Until those exist, a notification row is stored as `NOT_CONFIGURED` carrying the
exact outstanding requirement, and the console shows it. A stub that logs "sent"
and returns 200 is how a hotel discovers, three months in, that nobody was ever
receiving anything. Same discipline as the uncertified content sources.

### Event space is priced by a fixed pipeline

```
SPACE → SETUP → EQUIPMENT → CATERING → TAX
```

Three decisions inside it:

- **Capacity is per layout, and a bad fit is refused.** The same room seats 120
  in auditorio and 28 en U. Quoting the U for 80 people would be discovered on
  the morning of the event, so it throws — naming the layout that *would* hold
  them.
- **The cheapest applicable unit wins, and the alternatives are shown.** A
  four-hour booking priced by the hour when a half-day rate is cheaper is how a
  hotel loses a quote it should have won.
- **Included items are listed at zero, not hidden.** The client should see what
  they are getting rather than guess.

An addon the space does not offer produces a warning, never a silent omission,
and tax comes from the property's own `TaxRule` rows rather than a constant.

### The assistant may dictate configuration, never commit money

Five new command kinds. `upsert_event_space` and `set_group_policy` are the
dictation path — reciting capacities and prices out loud is genuinely faster
than a form, and getting it wrong oversells nothing.

`respond_group_request` is in `ALWAYS_HIGH_RISK`: it commits rooms and a price
to a third party. It always stops for a human and always requires step-up. It
also has **no inverse** — the platform could flip a status column, but that
would not un-tell the agency, so the honest answer is a refusal naming what
actually can fix it.

### Permissions

`groups.write` (load inventory and benefits) is separate from
`groups.negotiate` (accept, counter, decline). Loading a block is not the same
authority as committing the hotel to a price — the same split as
`contracts.write` versus `contracts.publish`.

`AGENCY_ADMIN` holds `groups.negotiate` for its own side. That is scoped by
**organization, not by permission**: the buyer that raised a request cannot
answer it, and cannot see another agency's bids.

## Consequences

- A composed BFF view now uses `Promise.allSettled`. One dead upstream degrades
  a section and names it; it no longer blacks out a screen eight other services
  could have filled. The catalog remains fatal for the property workspace,
  because without it there is no property to render.
- The console caches successful GETs and serves the last known copy **with its
  age** when the platform is unreachable. Only transport failures and 5xx fall
  back — a 403 is the server answering and must reach the user unchanged. Writes
  never fall back: an action that did not reach the server must fail loudly.
### Accepting a group takes the rooms out of sale

An earlier revision of this ADR left the decrement to the hotel, on the grounds
that a block is a commercial decision and the ledger reflects the source. That
was wrong in practice: a block that exists only inside Wetriip is a block
Booking.com oversells on a Tuesday. **Accepting now decrements real
availability.**

- **Only ACCEPTED decrements.** A live negotiation holds rooms inside the block
  so two agencies cannot both be told yes, but must not touch real availability
   — an offer that lapses would have withheld rooms from sale for a day.
- **The write is MANAGED**, never EXTERNAL, so the channel manager's own feed
  stays intact and distinguishable. Rule 3, applied here.
- **It runs as the SYSTEM.** The decrement is the mechanical consequence of a
  commitment, not a discretionary write. Requiring `availability.write` to
  accept a group would let somebody commit rooms they cannot withdraw.
- **The nights are the occupied nights.** Check-in 10th, check-out 13th occupies
  the 10th, 11th and 12th. The departure date is somebody else's to sell.
- **Every rate plan on the room type is reduced**, because the rooms are one
  physical pool — which is how a channel manager mirrors availability.
- **It is pushed outward.** If the push fails our Effective ARI is still
  correct, so Wetriip will not oversell — but the OTAs see the old number, and
  that is an alarm, recorded and surfaced rather than swallowed.
- **A shortfall is counted, not floored in silence.** A block promising twenty
  against a night the channel manager published two for cannot absorb ten. The
  difference is reported: the hotel is committed to rooms its own feed does not
  show, and that is exactly the oversell this exists to prevent.
- **A group with no block cannot be accepted.** Without one there is no room
  type to take the beds from, and committing rooms nobody can withdraw is worse
  than refusing.

Accepting and decrementing live in two services and cannot be one transaction.
Rather than pretend, the request carries `inventoryStatus`: APPLIED with the
cell count, or FAILED with the reason — visible in the console, retryable by
hand, and retried by the sweeper. An accepted group whose rooms are still on
sale is the most dangerous state in this domain, and the console says so.
