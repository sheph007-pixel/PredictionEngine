// Kennion buyer pipeline — identity-only seed. Each entry is limited to
// verifiable public-record facts (name, website, HQ, revenue, headcount,
// offices, Business Insurance 2025 Top 100 rank). Anything subjective
// (`type`, `ownership`, `sponsor`, narrative notes, flags, thesis,
// probability) is user-driven: it enters the system via stage changes,
// chat-added noteLog entries, or library documents, and is never inferred
// from this file. Process state (stage, NDA / CIM / chemistry dates) is
// also user-managed; new buyers default to stage "outreach".

export const STAGES = [
  { id: "outreach",  label: "Outreach",     short: "OUT" },
  { id: "nda",       label: "NDA Signed",   short: "NDA" },
  { id: "chemistry", label: "Chemistry",    short: "CHM" },
  { id: "loi",       label: "LOI Received", short: "LOI" },
  { id: "closed",    label: "Closed",       short: "CLS" },
];

export const STAGE_INDEX = Object.fromEntries(STAGES.map((s, i) => [s.id, i]));

export const PROCESS_TASKS = [
  { id: "data",        label: "Gather Data",                    phase: "Preparation",        weeksFromStart: 0 },
  { id: "proforma",    label: "Pro Forma & Model",              phase: "Preparation",        weeksFromStart: 2 },
  { id: "cim_draft",   label: "Draft CIM",                      phase: "Preparation",        weeksFromStart: 3 },
  { id: "cim_final",   label: "Finalize CIM / Materials",       phase: "Preparation",        weeksFromStart: 4 },
  { id: "outreach",    label: "Reach out to Buyers / NDAs",     phase: "Marketing Phase 1",  weeksFromStart: 5 },
  { id: "cim_deliver", label: "Deliver CIM",                    phase: "Marketing Phase 1",  weeksFromStart: 6 },
  { id: "qa",          label: "Q&A Calls with Reagan",          phase: "Marketing Phase 2",  weeksFromStart: 8 },
  { id: "chemistry",   label: "Chemistry Meetings",             phase: "Marketing Phase 2",  weeksFromStart: 9 },
  { id: "lois",        label: "Receive Letters of Intent",      phase: "Marketing Phase 2",  weeksFromStart: 12 },
  { id: "select",      label: "Select Final Buyer",             phase: "Exclusivity",        weeksFromStart: 14 },
  { id: "loi_exec",    label: "Negotiate & Execute LOI",        phase: "Exclusivity",        weeksFromStart: 15 },
  { id: "diligence",   label: "Confirmatory Diligence / Legal", phase: "Exclusivity",        weeksFromStart: 17 },
  { id: "close",       label: "Closing and Funding",            phase: "Close",              weeksFromStart: 22 },
];

export const PHASES = ["Preparation", "Marketing Phase 1", "Marketing Phase 2", "Exclusivity", "Close"];

export const PHASE_DESCRIPTIONS = {
  "Preparation":       "Gather data · model · draft CIM",
  "Marketing Phase 1": "Outreach · NDAs · deliver CIM",
  "Marketing Phase 2": "Q&A calls · chemistry · first LOIs",
  "Exclusivity":       "Negotiate LOI · confirmatory diligence",
  "Close":             "Closing and funding",
};

export const PROCESS_DEFAULT = {
  currentTaskId: "cim_deliver",
  currentTaskDate: "2026-05-14",
};

const _IDENTITY = [
  { id: "hub",        name: "Hub International",   website: "https://www.hubinternational.com",   hq: "Chicago, IL",       revenue: "$4.8B",        headcount: "20,000",     offices: "570+" },
  { id: "alliant",    name: "Alliant",             website: "https://www.alliant.com",            hq: "Irvine, CA",        revenue: "$4.2B",        headcount: "14,000+",    offices: "100+",       top100_rank: 5  },
  { id: "baldwin",    name: "Baldwin Group / CAC", website: "https://www.baldwin.com",            hq: "Tampa, FL",         revenue: "$1.5B",        headcount: "5,020",      offices: "Public (BWIN)" },
  { id: "cb",         name: "Cottingham & Butler", website: "https://www.cottinghambutler.com",   hq: "Dubuque, IA",       revenue: "$1.2B",        headcount: "1,300+",     offices: "35",         top100_rank: 29 },
  { id: "onedigital", name: "OneDigital",          website: "https://www.onedigital.com",         hq: "Atlanta, GA",       revenue: "$870M",        headcount: "3,200-3,500",offices: "125",        top100_rank: 17 },
  { id: "ima",        name: "IMA Financial Group", website: "https://www.imacorp.com",            hq: "Denver, CO",        revenue: "~$750M",       headcount: "3,000",      offices: "Multiple",   top100_rank: 20 },
  { id: "higgi",      name: "Higginbotham",        website: "https://www.higginbotham.com",       hq: "Fort Worth, TX",    revenue: "$750M",        headcount: "3,000-4,000",offices: "140+" },
  { id: "br",         name: "Brown & Riding",      website: "https://www.brownandriding.com",     hq: "Sherman Oaks, CA",  revenue: "~$300M",       headcount: "400+",       offices: "National" },
  { id: "kelly",      name: "Kelly Benefits",      website: "https://www.kellybenefits.com",      hq: "Sparks, MD",        revenue: "$250M",        headcount: "280",        offices: "4" },
  { id: "cason",      name: "The Cason Group",     website: "https://www.thecasongroup.com/",     hq: "Columbia, SC",      revenue: "$168M",        headcount: "~233",       offices: "10" },
  { id: "oakbridge",  name: "Oakbridge",           website: "https://oakbridgeinsurance.com/",    hq: "Atlanta, GA",       revenue: "~$100-150M",   headcount: "313",        offices: "30",         top100_rank: 50 },
];

export const BUYERS = _IDENTITY.map(b => ({
  ...b,
  stage: "outreach",
  fit: { size: 0, benefits: 0, pe: 0, precedent: 0 },
  thesis: "",
  probability: 0,
  noteLog: [],
}));
