# ACE — Brand & Design Brief
*Version 1.0 — March 2026*

---

## The Brand Feeling

Before colors, fonts, or layouts — what should ACE *feel* like?

**References that get it right (not sports):**
- **Linear** — the most beautiful project management tool alive. Dark, fast, surgical.
- **Vercel dashboard** — clean, dense data, zero clutter, every pixel earns its spot
- **Raycast** — command palette energy, feels like a tool for people who know what they're doing
- **Robinhood (early)** — made finance feel premium and accessible at the same time

**References that get it wrong:**
- ESPN app — loud, ad-heavy, designed for passive consumption
- DraftKings/FanDuel apps — sportsbook UI, gambling-first, cheap colors
- Lovable/Bolt projects — obviously templated, same shadcn components everyone uses

**The ACE feeling in words:**
- Confident without being arrogant
- Dense with data but never overwhelming
- Fast — every interaction feels instant
- Like a tool built by people who actually bet, for people who actually bet
- The opposite of "here's your lucky pick of the day" energy

---

## Brand Identity

### Name
**ACE** — all caps, always. Never "Ace" or "ace."

### Tagline options (pick one or remix)
- *"The edge is in the data."*
- *"Know before you bet."*
- *"Research. Edge. Execute."*
- *"See what the books don't want you to."*
- *"The terminal for sports bettors."* ← my favorite

### Logo direction
Not a playing card. Not a sports icon. Not a bolt or lightning.

Option A — **Wordmark only**: ACE in a custom geometric sans. Clean, no icon needed.
The word itself is the logo. Think: INTER or VERCEL wordmarks.

Option B — **Monogram + Wordmark**: A custom "A" with a subtle upward tick
through the right leg — implies upward movement, an edge. Works as app icon.
Beside the full wordmark for desktop, standalone for mobile.

Option C — **Terminal cursor**: The word ACE followed by a blinking cursor block.
Nods to the terminal/data aesthetic without being too literal.

**My call: Option B** — versatile, iconic at small sizes, not gimmicky.

---

## Color System

```
Background         #09090b    Almost black, slight warm undertone
Surface            #111113    Card backgrounds
Surface raised     #18181b    Hover states, elevated cards
Border             #27272a    Subtle dividers
Border bright      #3f3f46    Active borders, focus rings

Text primary       #fafafa    Main content
Text secondary     #a1a1aa    Labels, secondary info
Text muted         #71717a    Timestamps, meta info
Text disabled      #52525b    Inactive states

Gold (brand)       #f59e0b    ACE brand color, CTAs, highlights
Gold soft          #fbbf24    Hover on gold elements
Gold dim           #78350f    Gold backgrounds (very subtle)

Green (positive)   #22c55e    Wins, positive movement, +EV
Green soft         #16a34a    Hover green states
Green bg           #052e16    Green tinted backgrounds

Red (negative)     #ef4444    Losses, negative movement, alerts
Red bg             #450a0a    Red tinted backgrounds

Blue (info)        #3b82f6    Links, info states, neutral picks
Blue bg            #172554    Blue tinted backgrounds

Odds green         #4ade80    Positive American odds (+150 etc)
Odds white         #fafafa    Negative American odds (-110 etc)
```

**Key rule:** No gradients on the main UI. Gradients only on landing page hero.
On the product itself — flat, dense, clean. Gradients = amateur.

---

## Typography

### Display / Hero
**Geist** (Vercel's font) or **Cal Sans** — geometric, modern, slightly techy
Used for: headlines, hero text, large numbers

### Body / UI
**Inter** — the industry standard for dense UI. Nothing else comes close.
Used for: all body text, labels, descriptions

### Numbers / Odds
**Geist Mono** or **JetBrains Mono** — monospaced so odds columns align perfectly
Used for: all odds, scores, percentages, stats
This is critical — monospaced numbers in a betting tool is non-negotiable.

### Scale
```
xs:   11px / 0.6875rem
sm:   12px / 0.75rem
base: 14px / 0.875rem   ← default UI text (smaller than most sites, denser)
md:   16px / 1rem
lg:   18px / 1.125rem
xl:   24px / 1.5rem
2xl:  32px / 2rem
3xl:  48px / 3rem
```

---

## UI Component Language

### Cards
- Tight border radius: `8px` on most cards, `12px` on feature cards
- Border: 1px solid `#27272a` default, `#3f3f46` on hover
- NO box shadows on dark backgrounds — they look wrong. Use borders only.
- Background: `#111113`, slightly lighter than the page bg

### Odds Buttons (the core interaction)
These need to be perfect — users click these constantly.
- Default: `bg-#18181b`, border `#27272a`, text `#fafafa`
- Hover: border brightens to `#3f3f46`, bg lightens slightly
- Selected (added to parlay): `bg-gold/15`, border `#f59e0b`, text gold
- AI pick: small Sparkles icon in top-right corner of button
- Positive odds: number in `#4ade80` (green)
- Negative odds: number in `#fafafa` (white)

### Live indicator
Blinking red dot + "LIVE" text. The dot pulses slowly, not frantically.
Never just text. Always the dot.

### AI Confidence badge
Small pill: `bg-gold/10`, border `gold/30`, text gold
`✦ 84%` — the ✦ (sparkle/star) is the AI indicator throughout

### Line movement arrows
Up: `↑` in green — odds moved in your favor
Down: `↓` in red — line moved against
Stable: no indicator (not `→`, just absence)

### Buttons
Primary: `bg-gold`, `text-black`, font-semibold — reserved for the ONE main CTA
Secondary: `border-1 border-#3f3f46`, `text-fafafa`, `bg-transparent`
Ghost: no border, hover shows subtle bg
Never rounded-full pill buttons in the product UI (only on landing page marketing)

---

## Site Architecture / Web Map

```
ACE
├── / (Landing page)
│   ├── Hero — "The terminal for sports bettors"
│   ├── Product demo GIF/video
│   ├── Feature highlights
│   ├── Social proof (user count, picks accuracy)
│   ├── Pricing
│   └── CTA → Sign up free
│
├── /dashboard (Main app — the whole product)
│   ├── Sidebar (persistent, collapsible on mobile)
│   │   ├── ACE logo
│   │   ├── Games (home)
│   │   ├── AI Picks
│   │   ├── Watchlist
│   │   ├── Parlay Builder
│   │   ├── ── (divider)
│   │   ├── Settings
│   │   └── Upgrade badge (free tier)
│   │
│   ├── /dashboard (Games feed — the default view)
│   │   ├── Sport filter tabs (NFL · NBA · MLB · NHL · NCAAB · All)
│   │   ├── Time filter (All · Live · Today · Tomorrow)
│   │   ├── Live games section
│   │   └── Upcoming games section
│   │
│   ├── /dashboard/picks (AI Picks feed)
│   │   ├── Top picks banner
│   │   ├── Filter by sport / confidence / bet type
│   │   └── Pick cards (full reasoning, model confidence)
│   │
│   ├── /dashboard/game/:id (Game detail page)
│   │   ├── Game header (teams, score, time)
│   │   ├── Odds comparison table (all books, all markets)
│   │   ├── Line movement chart
│   │   ├── AI analysis card
│   │   └── Related picks
│   │
│   ├── /dashboard/parlay (Parlay builder)
│   │   ├── Leg list (games added)
│   │   ├── Combined odds calculator
│   │   ├── Expected value display
│   │   ├── Best book routing
│   │   └── Export / share slip
│   │
│   ├── /dashboard/watchlist (Saved games)
│   │   └── Tracked games with alerts
│   │
│   └── /dashboard/settings
│       ├── Account
│       ├── Notifications (line movement alerts)
│       ├── Preferred books
│       └── Subscription
│
└── /api (Backend — not a user-facing page)
```

---

## The Dashboard Layout (The Most Important Screen)

This is 80% of the product. Get this right.

```
┌────────────────────────────────────────────────────────────────┐
│ SIDEBAR (56px collapsed / 220px expanded)                      │
│ ┌──────────┐ ┌──────────────────────────────┐ ┌────────────┐  │
│ │          │ │  MAIN FEED                   │ │  SLIP      │  │
│ │  A       │ │                              │ │            │  │
│ │  C       │ │  [NBA] [NFL] [MLB] [NHL] [+] │ │  0 legs    │  │
│ │  E       │ │  [All] [Live ●] [Today]      │ │            │  │
│ │  ──      │ │                              │ │  Add legs  │  │
│ │  Games   │ │  ● LIVE (2)                  │ │  by click- │  │
│ │  Picks   │ │  ┌─ GameCard ─────────────┐  │ │  ing odds  │  │
│ │  Watch   │ │  │ OKC vs LAL  ● 2nd 8:32 │  │ │  buttons   │  │
│ │  Parlay  │ │  │ OKC  -250  -6.5  O224  │  │ │  ──────    │  │
│ │  ──      │ │  │ LAL  +195  +6.5  U224  │  │ │            │  │
│ │  Settings│ │  └────────────────────────┘  │ │            │  │
│ │          │ │  ┌─ GameCard ─────────────┐  │ │            │  │
│ │  Pro ✦   │ │  │ BOS vs MIA  7:30 PM    │  │ │            │  │
│ └──────────┘ │  │ BOS  -140  -3.5  O218  │  │ └────────────┘  │
│              │  │ MIA  +120  +3.5  U218  │  │                 │
│              │  └────────────────────────┘  │                 │
│              └──────────────────────────────┘                 │
└────────────────────────────────────────────────────────────────┘
```

### Game card anatomy (the core unit)
```
┌─────────────────────────────────────────────────────┐
│ NBA  ·  7:30 PM ET  ·  FanDuel Center  ·  9 books   │  ← meta row
│                                                      │
│ 🔵 Boston Celtics      -140  [-3.5]  [O 218.5]      │  ← away team row
│ 🔴 Miami Heat          +120  [+3.5]  [U 218.5]      │  ← home team row
│                                                      │
│ ✦ AI: BOS ML · 78% confidence     Best: DK -138     │  ← AI + best book
└─────────────────────────────────────────────────────┘
```

Each bracketed `[odds]` is a clickable button that adds to parlay slip.
The best book indicator sits quietly in the bottom right.
AI pick row only shows if model has a pick (>65% confidence).

---

## Animation & Motion Principles

**Fast by default:**
- Page transitions: 150ms fade — not a slide, just a fade
- Hover states: instant (0ms) or 50ms max
- Parlay slip open/close: 200ms ease-out
- Loading skeletons: always shimmer, never spinner

**Never:**
- Bouncy spring animations (looks like a toy)
- Slide-in page transitions (feels slow)
- Full-page loading screens
- Skeleton loaders that pulse too aggressively

**Signature motion — odds update:**
When an odds value changes (line moves), the number does a
subtle flash: white → green or red for 600ms, then back to normal.
This tells the user something changed without requiring a notification.

---

## Landing Page Design

### Hero section
Full dark background. Large centered headline in Geist:

```
The terminal for
sports bettors.
```

Sub: "Real-time odds from 40+ books. AI-powered edge detection.
One screen. Zero noise."

CTA: Single gold button → "Start for free"
Below: Small text "No credit card required · Free tier includes live odds"

### Product screenshot / demo
Below the hero: A real screenshot of the dashboard (not a mockup).
The product IS the marketing. Make it look impressive and let it speak.
Optionally: animated GIF showing live odds updating.

### Three feature blocks (icon + headline + one line)
- **Live odds from 40+ books** → "See every line, find the best price instantly"
- **AI picks with reasoning** → "Not just a pick — the model shows its work"
- **One-click parlay builder** → "Build your slip while you research"

### Social proof bar
"14,000 bets tracked · 68% model accuracy · $2.1M in value surfaced"
(real numbers as we build them)

### Pricing section
Three cards: Free / Pro $19 / Sharp $49
Clean, no tricks.

---

## What We're NOT Building

Say this clearly so we never drift:

- No green felt casino aesthetic
- No "🔥 HOT PICK" language
- No countdown timers creating fake urgency
- No dark patterns on the free tier
- No "crush the books" or "go 10-0" marketing
- No neon colors
- No confetti animations when you win
- No sportsbook-style UI with tabs for every bet type

ACE is a research tool. It respects the user's intelligence.
The design reflects that.

---

## First Build Priority

If we're building the MVP UI, this is the order:

1. **Game card component** — get this perfect first, everything else is secondary
2. **Odds button interaction** → parlay slip connection
3. **Dashboard layout** — sidebar + feed + slip panel
4. **AI confidence badge** — placeholder values first, real model later
5. **Landing page** — last, after the product looks good enough to screenshot
