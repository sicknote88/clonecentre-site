#!/usr/bin/env python3
"""Split smartlead_eligible_leads.csv into offer-specific segments.

Segments (one Smartlead campaign each):
  A_trades        -> ANSAIR, missed calls while on a job
  B_local_service -> ANSAIR, routine bookings/enquiries
  C_professional  -> HyperChat, website enquiries
Held back (not a good fit for the phone/chat pitch, or a different pitch):
  D_tech_creative, E_other_b2b

Usage: segment_smartlead_leads.py [input.csv] [output_dir]
"""
import csv
import re
import sys
from collections import Counter
from pathlib import Path

SRC = Path(sys.argv[1] if len(sys.argv) > 1 else
           "/Volumes/nothing_2_c_2/tradebot-ai/output/smartlead_eligible_leads.csv")
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else SRC.parent / "segments")

# Words that mean "sells/makes things" rather than "does the job". Checked first for A.
NOT_A_SERVICE = re.compile(
    r"retailer|supplier|spares|manufactur|stockholder|merchant|wholesale|equipment|"
    r"engineering|designers|shopping|materials|products|dust sheets|stencils|"
    r"fixings|hoses|valves|drainage suppliers|plumbing supplies|surveyors|drain surveyors",
    re.I)

TECH = re.compile(
    r"\bIT\b|software|web |web$|website|app dev|seo|internet marketing|digital|computer|telecom|"
    r"broadband|phone systems|e-?commerce|graphic|design$|^design|3d vis|advertising|public relations|"
    r"promotional|video|media|direct mail|telemarketing|database|hosting|erp|recruitment software|"
    r"technology|cad|autocad|game design|information services|dedicated servers|optical fibre|"
    r"sound design|photo retouching|eLearning|publish|telephone answering|transcription", re.I)

A_TRADES = re.compile(
    r"electric(ian|al contractors|al services|al inspect|gates)|roof|plumb(er|ers)$|boiler (install|repair|servic|hire)|"
    r"heating engineer|gas engineer|air condition|scaffold|builder|bricklay|carpent|joinery|plaster|"
    r"painters|tilers|floor(ing| sanding| screed)|carpet fitters|kitchen fitters|bathroom designers|"
    r"accessible bathrooms|damp|blocked drains|drain unblocking|water pipe|locksmith|garage doors|garage conv|"
    r"glaz|window|conservator|loft|home extension|fencing|driveway|landscape|garden|tree surgeon|"
    r"pest control|wasp|skip hire|house clearance|removals|man and van|cleaners|contract office cleaning|"
    r"oven cleaners|gutter|block paving|chandelier|beam cleaning|stone cleaners|blast cleaning|"
    r"security services|burglar alarm|cctv|fire alarm|roller shutters|awnings|blinds|curtain fitter|"
    r"demolition|groundwork|handyman|maintenance|building services|cladding|asbestos services|sash|"
    r"granite worktops|solar|aerial installers|home installations|home automation|access equipment|"
    r"mini digger|hire centre|waste disposal|waste and recycling|plasterers|ceiling|chimney|"
    r"stainles|office refurbishment|shop fitting|repointing|building estimates|construction|"
    r"portable appliance|pat testing|electrical inspecting|fire safety|fire and flood|vehicle security|"
    r"construction|metal buildings|garage conversions|sign makers|signwriters|led signs", re.I)

B_LOCAL = re.compile(
    r"care services|foster|childcare|physio|chiropod|acupunct|massage|counsell|aromather|therap|"
    r"beauty|hair and|laser hair|aesthetic|cosmetic|liposuction|dental|optician|veterinar|pet boarding|"
    r"dog walk|animal day|funeral|driving lessons|mot centres|car repairs|car body|mobile mechanic|"
    r"tyre services|car detailing|paintless|garages$|windscreen|car hire|coach hire|chauffeur|taxis|"
    r"private hire|caterers|wedding|party|photo booth|marquee|bouncy|balloon|disco|dj|event organis|"
    r"florist|private tutors|tutoring|pilates|fitness$|dancing|travel agent|holidays|travel and tourism|"
    r"serviced apartments|key cutting|clock|hire$|photograph|piano|guitar repairs|antique furniture restoration|"
    r"french polishing|ironing|linen and laundry|exhibition services|audio visual hire|health$|healing|"
    r"nutrition|speech training|first aid training|dyslexia|child behaviour|psycholog", re.I)

C_PRO = re.compile(
    r"account|bookkeep|tax advice|payroll|law|legal|conveyanc|immigration|visa services|will writers|"
    r"insurance|mortgage|financ|equity release|bridging|loans|debt|asset management|investment|"
    r"estate management|property|land agent|surveyor|architect|planning consultants|recruit|\bhr\b|"
    r"hr consult|consult|business |company formation|patents|training|market research|translation|"
    r"language|interpretation|health and safety|fire risk|energy (consult|broker|management|assess)|"
    r"structural engineers|quantity surveyors|interim resource|procurement|insolvency|liquidation|"
    r"franchise|career|cv writers|virtual office|secretarial|pa services|compensation|accident investig|"
    r"private detective|drug testing|site investigations|environmental engineers|ecolog|access consultants|"
    r"disability access|houses for sale|commercial property|relocation|import agents|freight|shipping|"
    r"education services|au pairs|modeling agency|music management|business", re.I)


def classify(row):
    s = f"{row['category']} | {row['trade']}".strip()
    cat = row["category"] or ""
    if "air condition" in cat.lower():
        return "A_trades"
    if TECH.search(cat) and not re.search(r"training", cat, re.I):
        return "D_tech_creative"
    if C_PRO.search(cat) and not NOT_A_SERVICE.search(cat.replace("surveyors", "")) \
            or re.search(r"surveyor|architect|quantity", cat, re.I):
        # Pro-services beats trades for e.g. 'Building Surveyors', 'Planning Consultants'
        if not A_TRADES.search(cat) or re.search(r"surveyor|architect|consult|property|insurance", cat, re.I):
            return "C_professional"
    if A_TRADES.search(cat) and not NOT_A_SERVICE.search(cat):
        return "A_trades"
    if B_LOCAL.search(cat):
        return "B_local_service"
    if C_PRO.search(cat) and not NOT_A_SERVICE.search(cat):
        return "C_professional"
    return "E_other_b2b"


# Hand-checked corrections where the keyword rules above misfire. Keys are lowercased categories.
OVERRIDES = {}
for _seg, _cats in {
    "A_trades": [
        "bathroom designers", "bedroom installers", "electric gates", "artificial grass installers",
        "cooker repairs", "stonemasons", "flatpack furniture assembly", "garden designers",
        "landscape designers", "kitchen designers", "timber treatment", "home improvement",
        "drain surveyors", "asbestos surveyors", "property maintenance", "architectural restoration",
    ],
    "B_local_service": [
        "first aid training", "hgv driver training", "speech training", "computer training",
        "drug testing", "architectural photographer", "medical services", "pregnancy and birth",
        "cake makers and decorators", "catering trailers", "childrens parties", "bands and musicians",
        "tribute acts", "entertainment", "feng shui", "mountain guides", "adventure sports",
        "sandwich bars", "cottages", "recovery services", "home staging", "modeling agency",
        "music management", "au pairs",
    ],
    "C_professional": [
        "credit control outsourcing", "interpretation and translation", "architectural design",
        "marketing experts", "project management", "life coaching", "time management coaching",
        "interior designers", "business credit checking", "credit clear services",
    ],
    "E_other_b2b": [
        "stainless steel", "stainles steel worktops", "garden furniture", "home and garden",
        "metal buildings", "led signs", "sign makers", "signwriters", "plaster and cement mouldings",
        "garden buildings", "hire centre", "freight forwarding", "shipping", "shipping containers",
        "import agents", "business storage", "diy- (do it yourself)", "designer handbags",
        "funeral literature", "hair and beauty supplies", "aromatherapy oils", "nutritional supplements",
        "party supplies", "wedding rings", "wedding stationery", "animal health",
        "telephone answering service",  # direct competitor, not a prospect
    ],
}.items():
    for _c in _cats:
        OVERRIDES[_c] = _seg


COLUMNS = ["email", "company_name", "city", "category", "website", "phone", "inbox_type"]


EMAIL_RE = re.compile(r"^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$")
FREE = ("gmail.", "googlemail.", "hotmail.", "yahoo.", "outlook.", "live.", "icloud.", "aol.", "msn.",
        "btinternet.", "sky.com", "talktalk.", "protonmail.")
INCORPORATED = re.compile(r"\b(ltd|limited|llp|plc|cic)\b\.?\)?$", re.I)


ROLE_WORDS = ("info", "sales", "enquiries", "enquiry", "hello", "admin", "contact", "office", "support",
              "mail", "bookings", "quotes", "service", "enq", "contactus", "team", "theteam", "hi", "accounts",
              "helpdesk", "reception", "general", "customerservice")
JUNK_LOCAL = re.compile(r"^(filler|copyright|jobs|tenders|design|websites?|web|collections|orders|sale|news|"
                        r"careers|noreply|no-reply|webmaster|privacy|abuse|postmaster|example|test|name|email|your)$")
JUNK_DOMAIN = ("godaddy.com", "website.com", "example.com", "domain.com", "yourdomain", "sentry", "wixpress.com")


def glued_or_junk(email):
    """Scraper artefacts: 'pageinfo@', 'usinfo@', 'ltdsales@', 'filler@godaddy.com', 'sale@' SEO clones."""
    local, domain = email.split("@")
    if JUNK_LOCAL.match(local) or any(j in domain for j in JUNK_DOMAIN):
        return True
    for w in ROLE_WORDS:
        if local != w and local.endswith(w) and local[: -len(w)].isalpha() and len(local) - len(w) <= 6 \
                and local[: -len(w)] not in ROLE_WORDS:
            return True
    return False


SUPPLIER_NAME = re.compile(
    r"hardware|abrasives|plastics|paints|electronics|\bparts\b|timber|production|recycling|textiles|products|"
    r"brickworks|marble|surfaces|supply|supplies|wholesale|manufactur|engineering|industrial|components|"
    r"systems integration|mechatronic|coachworks|brakes", re.I)


def sendable(r):
    """B2B cold email is only clearly safe under PECR to incorporated bodies (corporate subscribers).
    Sole traders / partnerships, free-mail and malformed addresses are held for manual review."""
    domain = r["email"].split("@")[-1]
    return bool(EMAIL_RE.match(r["email"])) and not domain.startswith(FREE) \
        and not glued_or_junk(r["email"]) \
        and bool(INCORPORATED.search(r["company_name"].strip()))


def main():
    rows = list(csv.DictReader(SRC.open(newline="", encoding="utf-8")))
    seen, buckets, dupes = set(), {}, 0
    for r in rows:
        key = r["email"].strip().lower()
        if not key or key in seen:
            dupes += 1
            continue
        seen.add(key)
        r["email"] = key
        if not sendable(r):
            buckets.setdefault("HOLD_review", []).append(r)
            continue
        # Unknown category -> use the generic bucket for review rather than guess.
        seg = OVERRIDES.get(r["category"].strip().lower()) or classify(r)
        if seg in ("A_trades", "B_local_service", "C_professional") and SUPPLIER_NAME.search(r["company_name"]) \
                and seg != "C_professional":
            seg = "E_other_b2b"  # sells/makes things rather than answering job calls
        if not r["category"].strip():
            seg = "E_other_b2b"
        buckets.setdefault(seg, []).append(r)

    OUT.mkdir(parents=True, exist_ok=True)
    for seg, items in sorted(buckets.items()):
        with (OUT / f"{seg}.csv").open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction="ignore")
            w.writeheader()
            w.writerows(items)
        print(f"{seg:18s} {len(items):5d}  cities={dict(Counter(i['city'] for i in items))}")
    print("duplicates dropped:", dupes)


if __name__ == "__main__":
    main()
