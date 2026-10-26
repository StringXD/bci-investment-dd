# bci-investment-dd

**A due-diligence framework for brain-computer interface (BCI) investments** — executable, recomputable, calibratable.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)](#engineering-conventions)
[![Version](https://img.shields.io/badge/version-0.1.0-informational.svg)](CHANGELOG.md)

> The full document set is in Chinese; this file is the English overview. Contributions of English translations are welcome.

## Why this exists

BCI in 2026 shows two opposite facts at once: capital and policy are concentrating fast, and most deals cannot be measured with the same ruler.

The failure mode is rarely "I don't believe in the sector". It is **using the wrong ruler**:

- An implantable Class III device and a consumer EEG headband differ in development cycle, capital intensity, defensibility and exit path. The former can be discussed as a milestone-discounted option; the latter can only be valued on revenue, non-recurring-adjusted profit, market share and repurchase. **Pricing a consumer-grade asset with hard-tech option logic is the most expensive mistake in this sector.**
- One-way monitoring devices (acquisition only, no real-time decoding and feedback) are frequently marketed as BCI platforms. Regulators have drawn this line explicitly; diligence must settle it first.
- A long-cycle asset matched with a short-duration fund is often misread as "wrong project". The same deal can deserve a different verdict under a different capital mandate.

This framework turns those three problems into a **gate**, then narrows with nine dimensions, 109 check items and 44 red flags. Scoring, runway, milestone positioning, valuation deviation and cap-table dilution are computed by two deterministic scripts — no mental arithmetic, reproducible conclusions.

## Design

```
Gate (5 questions)
  └─ asset class? closed loop? stage? evidence coverage? entity: prototype / product / commodity?
        │ terminate → no conclusion, or quick-screen only
        ▼ proceed
   structured JSON  ──►  dd_score.mjs   ──► gate verdict · milestone L0-L6 · 9-dim weighted score
                     │                     red-flag veto · runway · valuation deviation · verdict
                     └─►  ownership.mjs  ──► fully-diluted cap table · university IP chain
                                            nominee restoration · platform voting leverage
                                            redemption pressure · control stability
                                              └──► report template ──► review
```

| Layer | Content | Location |
|---|---|---|
| Gate | 5 questions decide whether to proceed and which ruler applies | [`references/00-gate.md`](references/00-gate.md) |
| Assessment | 9 dimensions, 109 check items, each with a source tag | [`references/01`](references/01-asset-class.md) – [`09`](references/09-team-org.md) |
| Red lines | 44 red flags, 15 of which are outright vetoes | [`references/red-flags.md`](references/red-flags.md) |
| Computation | scoring, runway, milestones, valuation deviation, cap table | [`scripts/`](scripts) |

## Quick start

Zero dependencies, Node ≥ 18.

```bash
git clone https://github.com/<your-org>/bci-investment-dd.git
cd bci-investment-dd

# self-documenting examples (deliberately seeded with warnings)
node scripts/dd_score.mjs --example
node scripts/ownership.mjs --example

# your own data
node scripts/dd_score.mjs examples/01-implant-class3.json
node scripts/ownership.mjs examples/03-cap-table.json
```

Output is Markdown. Sections `一` to `七` map one-to-one to the report template; the final section is always `## 警告` (warnings), listing every missing input with subject names and concrete values.

## The nine dimensions

| # | Dimension | Items | Focus |
|---|---|---|---|
| D1 | Asset class and valuation paradigm | 13 | narrative vs revenue line; wrong valuation family |
| D2 | Clinical need and indication value | 10 | risk-benefit vs lower-risk alternatives |
| D3 | Technical reality and engineering | 14 | online closed loop, cross-subject generalization, six-component completeness |
| D4 | Registration path and clinical evidence | 14 | classification, type testing timing, controlled design, endpoints |
| D5 | Commercialization and payment | 12 | who pays, how much, is it repeatable |
| D6 | Financial quality and runway | 11 | operating revenue after stripping grants and related parties |
| D7 | Capital structure, terms and exit | 11 | hard listing thresholds, redemption pressure, down-round risk |
| D8 | Legal, IP, data and control | 12 | IP chain of title, informed consent, marketing compliance |
| D9 | Organization, founder and ecosystem position | 12 | key-person dependency, missing clinical/regulatory/sales roles |

Milestones run `L0 proof of concept → L1 type testing → L2 large-animal safety → L3 exploratory clinical → L4 multicenter confirmatory → L5 regulatory review → L6 registration and market access`. Class II rehab and consumer-grade assets follow branch paths that skip animal studies and confirmatory trials — the asset-class split, expressed as process.

## Engineering conventions

- **Zero dependencies.** Node standard library only. No network, no file writes, stdout only.
- **Compute what you can.** Missing input produces a warning, never an exception. Problems are collected into the final section with subject names and values.
- **Section numbers are a contract.** Scripts emit sections `一`–`七` plus a final `## 警告`; the report template follows the same numbering.
- **Parameters are assumptions, not facts.** Weights, stage factors, multiple bands and milestone durations are constant tables. Calibrate them to your own fund mandate and declare the version in the report.
- **No mental arithmetic.** Every number in the report is copied verbatim from script output.

## Regulatory facts used

All regulatory and standard references are registered in [`references/sources.md`](references/sources.md) with publication date, access date and source tier. Examples:

| Fact | Tier |
|---|---|
| BCI medical devices must meet four core characteristics simultaneously; one-way acquisition or stimulation is excluded (NMPA Notice 2026 No. 24) | Primary |
| Classification codes 12-00 / 09-00 / 19-00, and the AI boundary for Class II rehabilitation | Primary |
| YY/T 2029—2026, EEG dataset quality requirements for AI algorithms (effective 2027-09-01) | Primary |
| STAR Market Listing Rule 2.1.2(5): expected market cap ≥ RMB 4bn; one core product cleared for Phase II | Primary |
| HKEX Chapter 18A: market cap ≥ HKD 1.5bn at listing; core product past concept stage | Primary |

## Scope and disclaimer

- Outputs are **diligence process indicators and deviation flags**. They are not a valuation conclusion, not investment advice, and not legal, regulatory or accounting advice.
- Weights, thresholds and multiple bands are methodological parameters; calibrate before use. Milestone durations are industry ranges, not schedule commitments for any specific company.
- Control-stability projections are linear dilution approximations and do not replace line-by-line review of constitutional documents by counsel.
- Where regulatory requirements are concerned, the currently effective statutes, guidance and review requirements prevail.
- All sample data is fictional and must not be used as a comparable transaction or valuation reference.

## License

[MIT](LICENSE)
