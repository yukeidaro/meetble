"""Likelihood math for Step 5. The LLM never outputs a %; it outputs a base rate and four
multipliers with reasons, and this module computes the % so numbers are stable and explainable."""

# base-rate range per action type (spec section 5; placeholders to tune)
BASE_RANGE = {
    "referral": (0.30, 0.50),
    "booking_page": (0.40, 0.70),
    "event": (0.10, 0.25),
    "office_delivery": (0.05, 0.15),
    "cold_email": (0.01, 0.10),
    "cold_dm": (0.01, 0.10),
    "paid_consult": (0.60, 0.90),
    "paid_intro": (0.20, 0.40),
    "network_first": (0.05, 0.15),
    "post_and_mention": (0.01, 0.05),
}
ACTION_TYPES = list(BASE_RANGE)

MULT_RANGE = {
    "m_relevance": (0.5, 2.0),  # offer fits their need (Step 3 x Step 4)
    "m_timing": (0.8, 1.5),     # tied to something from the last 7 days (Step 2)
    "m_warmth": (1.0, 5.0),     # mutual contact, shared background, precedent
    "m_channel": (0.3, 1.5),    # they invite contact there vs never use it
}
P_FLOOR, P_CEIL = 0.01, 0.95


def clamp(x, lo, hi):
    from .common import num
    return max(lo, min(hi, num(x, lo)))


def score_action(a, days_left=None, budget_jpy=None):
    """Normalise one action in place and compute a['p'] (0-1). Returns a."""
    lo, hi = BASE_RANGE[a["type"]]
    a["base_rate"] = clamp(a.get("base_rate"), lo, hi)
    for k, (mlo, mhi) in MULT_RANGE.items():
        a[k] = clamp(a.get(k, 1.0), mlo, mhi)
    # A boost needs evidence: without any cited finding, no multiplier may exceed 1.0.
    if not a.get("evidence"):
        for k in MULT_RANGE:
            a[k] = min(a[k], 1.0)
        a.setdefault("flags", []).append("no evidence: boosts removed")
    raw = a["base_rate"] * a["m_relevance"] * a["m_timing"] * a["m_warmth"] * a["m_channel"]
    a["p"] = round(clamp(raw, P_FLOOR, P_CEIL), 4)
    a["cost_jpy"] = max(0, int(clamp(a.get("cost_jpy"), 0, 1e9)))
    a["hours"] = round(clamp(a.get("hours"), 0, 1000), 1)
    a["days_to_outcome"] = round(clamp(a.get("days_to_outcome"), 0, 365), 1)
    a["fits_deadline"] = days_left is None or (days_left >= 0 and a["days_to_outcome"] <= max(days_left, 0.5))
    a["fits_budget"] = budget_jpy is None or a["cost_jpy"] <= budget_jpy
    return a


def total_chance(actions):
    """Chance at least one action works by the deadline: 1 - prod(1 - p_i), over actions that fit."""
    miss = 1.0
    for a in actions:
        if a.get("fits_deadline", True) and a.get("fits_budget", True):
            miss *= 1.0 - a["p"]
    return round(1.0 - miss, 4)


def pct(p, floor=True):
    """Action % never shows below 1% (the brief: "even at 1%"); a total of exactly 0 shows 0%."""
    v = p * 100
    if v <= 0:
        return "0%"
    return f"{v:.0f}%" if v >= 1 else "1%"
