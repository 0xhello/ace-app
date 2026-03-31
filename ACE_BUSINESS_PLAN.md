# ACE — Business Plan & Brand Strategy
*Version 1.0 — March 2026*

---

## The Market Opportunity

Online sports betting is a $49.7B market in 2026, growing to $92B by 2031 (13% CAGR).
The US alone is the largest single market, still in early innings of legalization.

**The gap:** Tens of millions of people now bet legally. Most of them are losing money
not because they don't care — but because they don't have the right tools.
The sportsbooks have all the data. The bettors have nothing.

ACE fixes that.

---

## The Competitive Landscape

### Tier 1 — Established Players
| Product | Price | Strengths | Weaknesses |
|---|---|---|---|
| **Action Network** | $9-$60/mo | Brand, content, community | Feels like a news site, not a tool |
| **OddsJam** | $199/mo | Best arbitrage/+EV tools, real-time | Expensive, complex, sharp-user focused |
| **Rithmm** | $30-$100/mo | Clean AI picks UI, mobile app | No custom models, limited depth |
| **BetQL** | $10-$20/mo | Cheap entry point | Weak AI, clunky interface |
| **RotoGrinders** | Free-$30/mo | DFS crossover audience | Old UI, DFS-first not betting-first |

### Tier 2 — Newer AI Tools
| Product | Price | Notes |
|---|---|---|
| **Leans.AI** | $20-$50/mo | CLV-focused, sharp tools |
| **ParlaySavant** | ~$25/mo | Parlay optimization |
| **PropProfessor** | $35/mo | Props-only, strong ROI claims |

### What none of them do well
- **OddsJam** is the best tool but priced out of casual bettors ($199/mo)
- **Action Network** has audience but the product is basically a sports news site
- **Rithmm** has the right aesthetic but thin AI — it's a picks delivery app, not a research platform
- **Nobody** has built the Bloomberg terminal version — a real-time intelligence dashboard
  where you can research, compare, build, and act in one screen

---

## The ACE Positioning

**"The intelligence layer for sports bettors."**

Not a picks service. Not a news site. Not a sportsbook.

ACE is the **research platform** — the tool serious bettors use before they go bet
anywhere else. You come to ACE to understand the game, find the edge, build your
position. Then you go execute wherever the best price is.

Think:
- Bloomberg Terminal → for traders
- ACE → for bettors

---

## Target Customer

### Primary: The "Serious Casual" Bettor
- Bets $50-$500/week across NFL, NBA, MLB
- Has accounts at 2-3 books (DraftKings, FanDuel, BetMGM)
- Currently uses Action Network for news and maybe odds shopping on one site
- Feels like they're leaving money on the table but doesn't have the tools to know where
- **Willing to pay $20-$40/mo for a clear edge**
- Age: 22-38, mostly male, tech-comfortable

### Secondary: The Sharp / Semi-Pro
- Bets $1,000-$10,000/week, tracks CLV, understands +EV
- Currently uses OddsJam or builds their own tools
- Needs faster, cleaner, more customizable
- **Willing to pay $100-$200/mo for institutional-grade tools**

### The Bridge Opportunity
Most tools serve only one of these audiences. ACE bridges both:
- Casual gets a clean, beautiful, guided experience
- Sharp gets the data depth, model access, line movement tracking

---

## The ACE Product

### Core concept
One unified dashboard. No tabs, no separate pages for different data.
Everything visible at once — like a trading desk, not a website.

**Left panel (70%):** Live game feed
- Every game card shows: teams, live score, ML/spread/total side by side
- Best book highlighted per line
- AI confidence score on each side
- Line movement indicators (real-time)
- One click to add any line to parlay slip

**Right panel (30%):** Action panel
- Parlay slip — builds as you click games
- Auto-calculates combined odds, true probability, expected value
- "Best book" routing — tells you where to actually go place the bet

**Top rail:** Sport filters, search, AI picks banner

### Feature tiers

**Free tier:**
- Live odds from all books
- Basic line comparison
- Parlay builder (no AI)
- Delayed line movement (15 min)

**Pro ($19/mo):**
- AI picks + confidence scores
- Real-time line movement
- Best book alerts
- +EV calculator
- Historical trends

**Sharp ($49/mo):**
- Custom AI model builder
- CLV tracking
- Arbitrage scanner
- API access
- Discord community

---

## Brand Direction

### Name: ACE
- Short, memorable, works everywhere
- Connotates expertise and edge (ace = advantage)
- Clean for a logo, strong for a domain

### Aesthetic
- **Dark, high-contrast, terminal-inspired** — not a colorful consumer app
- The UI should feel like a professional tool, not a toy
- Think: dark background (#0a0a0f), gold accents (#f59e0b), green for positive, red for alerts
- Typography: clean, monospaced numbers (odds), sans-serif everywhere else

### Tone of voice
- Direct. Confident. Never hype.
- We don't promise wins. We deliver information.
- "The edge is in the data. ACE surfaces it."
- Anti-marketing — never say "guaranteed picks" or "crush the books"

### Logo concept
- The word ACE in bold, clean lettering
- Small diamond/card suit detail (subtle, not cheesy)
- Or: the letter A with a subtle upward line through it (trending up)

---

## Revenue Model

### Year 1 targets
- 500 Pro users = $9,500/mo MRR = $114K ARR
- 50 Sharp users = $2,450/mo MRR = $29K ARR
- **Total Y1 target: ~$143K ARR**

### Year 2 targets
- 3,000 Pro + 300 Sharp = ~$72K MRR = $860K ARR

### Unit economics
- CAC target: $30-50 (content/SEO + social + affiliate)
- LTV target: $240-600 (12-month retention)
- LTV/CAC ratio: 5-12x (healthy SaaS)

### Growth channels
1. **SEO content** — "best odds for [team] tonight", "NBA line movement tracker"
2. **Twitter/X + Reddit** — r/sportsbook, r/EVbetting community presence
3. **Affiliate** — partner with sportsbooks for referral commissions when users click through
4. **YouTube** — "how I found +EV on this game" content

---

## The Affiliate Angle (Hidden Revenue Layer)

Every time a user clicks "Bet at FanDuel" or "Bet at DraftKings" from ACE, we can earn
an affiliate commission. Sportsbooks pay $50-$300 per depositing player.

This means ACE doesn't have to rely solely on subscriptions.
The free tier essentially becomes a lead generation machine.

**Estimated affiliate revenue at 500 MAU:** $2,000-5,000/mo additional
**At 5,000 MAU:** $20,000-50,000/mo additional

This is the real unlock — ACE could become profitable at a much smaller subscriber base
than traditional SaaS because the affiliate layer funds growth.

---

## Development Roadmap

### Phase 1 — Foundation (Now)
- ✅ Next.js frontend
- ✅ Backend API with live odds
- ✅ Deployed on Railway
- ⬜ Real game cards (ML + spread + total)
- ⬜ Parlay builder

### Phase 2 — Intelligence (Next 4 weeks)
- ⬜ AI picks engine (adapted from Polymarket bot)
- ⬜ Line movement detection and alerts
- ⬜ Best book routing
- ⬜ +EV calculator

### Phase 3 — Monetization (Week 8-12)
- ⬜ Auth (Clerk or Supabase)
- ⬜ Stripe subscription tiers
- ⬜ Affiliate link integration
- ⬜ Free vs Pro gating

### Phase 4 — Scale (Month 4+)
- ⬜ Mobile app (React Native)
- ⬜ Custom model builder
- ⬜ CLV tracking
- ⬜ Arbitrage scanner

---

## The Pitch (One Paragraph)

ACE is the intelligence platform for sports bettors. In a $50B market where sportsbooks
have all the data and bettors have nothing, ACE levels the playing field — giving any
bettor access to the same real-time odds data, AI-powered edge detection, and multi-book
comparison tools that sharp bettors pay thousands a month for, at a fraction of the price.
We make money three ways: subscriptions, affiliate commissions from sportsbook referrals,
and eventually API access for institutional clients. The market is massive, growing fast,
and the tools available today are either too expensive, too complex, or too shallow.
ACE is none of those things.
