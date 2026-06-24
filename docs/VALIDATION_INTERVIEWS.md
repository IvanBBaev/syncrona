# Validation interviews (BA1)

> The single highest-leverage missing thing: **evidence anyone wants this enough
> to switch.** The roadmap is currently self-derived. Run 5–8 interviews before
> investing more build or marketing. This is a script you (the owner) run — it
> cannot be implemented in code.

## Goal

Test four hypotheses, in order of importance:
1. **Problem is real & painful** — Studio/manual change movement genuinely hurts.
2. **Current alternative is weak** — what they use today and why it frustrates.
3. **Willingness to switch** — would they adopt a CLI/local-first workflow.
4. **Must-have gates** — auth (OAuth/SSO), support, compatibility — dealbreakers.

(Bonus: willingness to pay, for the business-model decision in BA5.)

## Who to recruit (5–8)

- **3–4 ServiceNow SIs / consultancies** (the beachhead — P3).
- **2–3 internal platform devs/leads** building multiple scoped apps (P1/P2).
- Reach via the ServiceNow Developer Community, LinkedIn, r/servicenow.

## Rules

- **Discovery, not pitch.** Ask about their world; do **not** demo until the end.
- Ask about **past behavior**, not hypotheticals ("walk me through the last time
  you moved a change" beats "would you use X?").
- Shut up and listen. Record (with consent) or take verbatim notes.
- ~30 minutes.

## Script

**Warm-up**
1. Tell me about your team and how many scoped apps you work on.

**Problem discovery (hypothesis 1)**
2. Walk me through the last time you edited and moved a scoped-app change from
   dev to a higher environment. What did each step look like?
3. Where did that hurt most? What wastes the most time or causes the most rework?
4. How do you do code review and version control for scoped code today?

**Current alternative (hypothesis 2)**
5. What tools do you use for this now — Studio's Git, update sets, scripts,
   Sincronia, something else? What do you like / hate about it?

**Switching & must-haves (hypotheses 3 & 4)**
6. If you could edit ServiceNow code locally in VS Code with Git, build, and CI —
   what would have to be true for you to actually adopt it on a real project?
7. On authentication: does Basic auth work in your org, or is **OAuth/SSO a hard
   requirement**? What about storing credentials?
8. Who decides on dev tooling in your team, and what would block adoption
   (security review, support/SLA, ServiceNow version, procurement)?

**AI/MCP (the wedge — gauge, don't oversell)**
9. If an AI assistant could see your scope's metadata, dependencies, and impact
   before a change — is that interesting, a gimmick, or a security non-starter?
   Where would your data-governance team push back?

**Willingness to pay (BA5)**
10. If a tool reliably saved your team [their stated pain] — is that something a
    team like yours would pay for (support/enterprise), or only adopt if free?

**Close**
11. Who else should I talk to? Would you try an early version and give feedback?

## Logging results (so it informs the roadmap)

For each interview capture: persona, top pain (verbatim), current alternative,
the #1 must-have, OAuth/SSO required (Y/N), AI reaction, WTP signal, would-pilot
(Y/N). After 5–8, look for the **pattern** — a repeated pain + repeated must-have
is your validated wedge; tie the roadmap and `BUSINESS_ANALYSIS.md` §3 value
hypotheses to it.

## Decision gate

- **≥5 of 8 describe the pain unprompted AND would pilot** → proceed to soft
  launch (`docs/GO_TO_MARKET.md`).
- **Mixed/weak** → the problem may not be acute enough; reconsider scope or
  audience before more build/marketing.
- **OAuth/SSO is unanimous** → it stays a Must regardless of other signals.
