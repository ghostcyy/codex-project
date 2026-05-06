import type { DeckIR } from "../../ir";

export const sampleDeckIr: DeckIR = {
  intent: {
    topic: "Cloud server applications and future infrastructure",
    language: "en",
    audience: "executives",
    tone: "analytical",
    format: "briefing",
    hardConstraints: {
      slideCount: 4,
      narrativeChars: 1500,
      requiredSections: ["Applications", "Future outlook"]
    },
    preferences: {
      aestheticHints: ["clean enterprise", "technical but accessible"],
      forbiddenThemes: ["terminal-cyber"],
      domainTerminology: ["elastic compute", "edge inference", "availability zone"],
      knowledgeCutoffWarning: true
    },
    derivedSlideCount: 4,
    derivedNarrativeChars: 1500
  },
  evidence: {
    facts: [
      {
        claim: "Cloud servers abstract compute resources so teams can provision capacity faster than traditional hardware procurement.",
        confidence: "high",
        sources: [
          {
            url: "https://example.com/cloud-computing-overview",
            title: "Cloud computing overview",
            type: "web"
          }
        ],
        citationKey: "cloud-servers"
      },
      {
        claim: "Future cloud infrastructure will increasingly combine centralized regions with edge locations for latency-sensitive workloads.",
        confidence: "medium",
        sources: [
          {
            url: "https://example.com/edge-cloud-future",
            title: "Edge cloud future",
            type: "web"
          }
        ],
        citationKey: "edge-cloud"
      }
    ],
    dataPoints: [
      {
        metric: "Provisioning speed",
        value: "minutes instead of weeks",
        source: "Cloud computing overview",
        citationKey: "provisioning-speed"
      }
    ],
    candidateVisuals: [
      {
        kind: "icon",
        description: "Layered cloud infrastructure icon set",
        relevanceScore: 0.84
      }
    ],
    terminology: [
      {
        term: "Elastic compute",
        definition: "Compute capacity that can expand or contract based on demand.",
        usage: "technical"
      }
    ],
    narrativeAngles: [
      {
        angle: "Cloud as operating leverage",
        tradeoffs: "The story is executive-friendly, but it must avoid oversimplifying security and cost governance."
      }
    ],
    knownGaps: ["Specific market forecasts should be refreshed before external publication."]
  },
  narrative: {
    arc: "problem-solution",
    slides: [
      {
        index: 1,
        role: "cover",
        beat: "Frame cloud servers as a strategic infrastructure layer.",
        contentBrief: {
          headline: "Cloud Servers as the New Operating Layer",
          subhead: "Applications today, infrastructure tomorrow",
          supportingPoints: ["Cloud infrastructure has moved from cost center to product accelerator."],
          evidenceRefs: ["cloud-servers"],
          keyMetrics: ["Provisioning speed"]
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 240
      },
      {
        index: 2,
        role: "toc",
        beat: "Preview the briefing structure.",
        contentBrief: {
          headline: "Three questions for leaders",
          supportingPoints: ["Where cloud helps now", "What changes next", "How to prepare"],
          evidenceRefs: ["cloud-servers"]
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 240
      },
      {
        index: 3,
        role: "analysis",
        beat: "Explain why cloud servers reshape delivery economics.",
        contentBrief: {
          headline: "Applications expand from hosting to intelligent operations",
          supportingPoints: [
            "Elastic compute shortens the path from idea to production.",
            "Managed platforms shift teams toward service reliability and data workflows."
          ],
          evidenceRefs: ["cloud-servers", "edge-cloud"]
        },
        densityBudget: "balanced",
        estimatedNarrativeChars: 680
      },
      {
        index: 4,
        role: "cta",
        beat: "Close with a practical next step.",
        contentBrief: {
          headline: "Build the roadmap around workload fit",
          supportingPoints: ["Start with latency, data gravity, security posture, and operating model."],
          evidenceRefs: ["edge-cloud"]
        },
        densityBudget: "sparse",
        estimatedNarrativeChars: 360
      }
    ],
    totalEstimatedChars: 1520,
    transitions: [
      {
        fromSlide: 1,
        toSlide: 2,
        bridge: "After framing the strategic shift, move into the questions that structure the briefing."
      },
      {
        fromSlide: 2,
        toSlide: 3,
        bridge: "The first question is where cloud servers already create leverage."
      },
      {
        fromSlide: 3,
        toSlide: 4,
        bridge: "The implication is not to migrate everything, but to match workloads to cloud strengths."
      }
    ]
  },
  design: {
    themeId: "engineering-whiteprint",
    themeTokens: {
      palette: {
        bg: "#f8fafc",
        surface: "#ffffff",
        surface2: "#eaf2f8",
        accent: "#0f766e",
        accent2: "#2563eb",
        accent3: "#f59e0b",
        text1: "#0f172a",
        text2: "#475569",
        border: "#cbd5e1",
        good: "#16a34a",
        warn: "#d97706",
        bad: "#dc2626"
      },
      typography: {
        fontDisplay: "Sora",
        fontBody: "Manrope",
        fontMono: "IBM Plex Mono",
        scaleRatio: 1.18,
        baseSize: 18
      },
      geometry: {
        radiusSm: 8,
        radiusMd: 18,
        radiusLg: 32,
        gapSm: 12,
        gapMd: 24,
        gapLg: 40
      },
      elevation: {
        shadowSm: "0 4px 16px rgba(15, 23, 42, 0.08)",
        shadowMd: "0 14px 32px rgba(15, 23, 42, 0.12)",
        shadowLg: "0 24px 64px rgba(15, 23, 42, 0.16)"
      },
      motion: {
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        durationFast: 160,
        durationBase: 420,
        durationSlow: 900
      }
    },
    donorTemplateId: "tech-sharing",
    donorContract: {
      id: "tech-sharing",
      decorativeClasses: ["ts-grid", "ts-glow"],
      coverOnlyClasses: ["ts-hero-orbit"],
      bodyAllowedClasses: ["ts-panel", "ts-kicker", "ts-card"],
      dnaSignature: {
        titleTreatment: "precise technical heading with restrained accent",
        cardTreatment: "white panel with thin engineering border",
        kickerTreatment: "small uppercase technical label",
        accentRule: "one teal accent per slide",
        density: "balanced"
      },
      forbiddenTextPatterns: ["Halo v2", "fin", "cta final"]
    },
    deckClass: "tpl-tech-sharing",
    contrastReport: {
      passed: true,
      minContrastRatio: 7.8,
      issues: []
    },
    animationBudget: {
      allowedAnims: ["fade-up", "stagger-list", "none"],
      allowedFx: ["soft-glow", "none"],
      maxAccentSlides: 2,
      fxAllowedRoles: ["cover", "cta"]
    },
    accentPolicy: "static",
    audienceFitReport: {
      score: 0.92,
      reasons: ["Enterprise palette fits executive briefing.", "Technical donor style matches cloud infrastructure topic."]
    }
  },
  layoutPlan: [
    {
      slideIndex: 1,
      layoutId: "cover",
      capacityCheck: { passed: true, details: "Sparse cover content fits." },
      variancePosition: 0
    },
    {
      slideIndex: 2,
      layoutId: "toc",
      capacityCheck: { passed: true, details: "Three agenda items fit." },
      variancePosition: 1
    },
    {
      slideIndex: 3,
      layoutId: "two-column",
      capacityCheck: { passed: true, details: "Two explanation columns fit balanced density." },
      variancePosition: 2
    },
    {
      slideIndex: 4,
      layoutId: "cta",
      capacityCheck: { passed: true, details: "Short closing action fits." },
      variancePosition: 3
    }
  ],
  slots: [
    {
      slideIndex: 1,
      kind: "cover",
      title: "Cloud Servers as the New Operating Layer",
      kicker: "Executive Briefing",
      subtitle: "Applications today, infrastructure tomorrow",
      meta: ["4 slides", "Strategic overview"],
      citationKeys: ["cloud-servers"]
    },
    {
      slideIndex: 2,
      kind: "toc",
      title: "Three questions for leaders",
      kicker: "Agenda",
      items: [
        { label: "Where cloud helps now", description: "Delivery speed and operating leverage" },
        { label: "What changes next", description: "Edge, AI, and distributed services" },
        { label: "How to prepare", description: "Workload-fit roadmap" }
      ],
      citationKeys: ["cloud-servers"]
    },
    {
      slideIndex: 3,
      kind: "two-column",
      title: "Applications expand from hosting to intelligent operations",
      kicker: "Current applications",
      leftTitle: "Immediate value",
      leftBody: "Cloud servers reduce provisioning delays and let teams test, deploy, and scale services without waiting for hardware cycles.",
      rightTitle: "Future shift",
      rightBody: "The next phase blends core cloud regions with edge nodes so intelligent services can run closer to users and devices.",
      bullets: ["Elastic compute", "Managed reliability", "Edge inference"],
      citationKeys: ["cloud-servers", "edge-cloud"]
    },
    {
      slideIndex: 4,
      kind: "cta",
      title: "Build the roadmap around workload fit",
      kicker: "Next step",
      headline: "Move deliberately, not universally",
      action: "Rank workloads by latency, data gravity, risk, and operating maturity.",
      supportingText: "The strongest cloud strategy is selective: match the workload to the platform instead of forcing one platform onto every workload.",
      citationKeys: ["edge-cloud"]
    }
  ],
  assets: {},
  choreography: [
    {
      slideIndex: 1,
      entrance: "fade-up",
      builds: [],
      fx: "soft-glow"
    },
    {
      slideIndex: 2,
      entrance: "fade-up",
      builds: [{ target: "toc-item", anim: "stagger-list", delay: 80 }],
      fx: "none"
    },
    {
      slideIndex: 3,
      entrance: "fade-up",
      builds: [{ target: "card", anim: "stagger-list", delay: 100 }],
      fx: "none"
    },
    {
      slideIndex: 4,
      entrance: "fade-up",
      builds: [],
      fx: "soft-glow"
    }
  ],
  meta: {
    irVersion: "v1",
    revisionRound: 0,
    qualityScores: {
      factual: 0.82,
      narrative: 0.86,
      visual: 0.9,
      density: 0.88,
      accessibility: 0.94,
      overall: 0.88
    },
    generatedAt: "2026-04-28T00:00:00.000-07:00",
    checkpoints: [
      {
        stage: "stage-0:fixture",
        status: "completed",
        startedAt: "2026-04-28T00:00:00.000-07:00",
        completedAt: "2026-04-28T00:00:01.000-07:00",
        summary: "Hand-authored DeckIR fixture for schema verification."
      }
    ]
  }
};
