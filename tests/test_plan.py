"""Offline tests: the Claude call is replaced by canned answers, so no key or network is needed."""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

os.environ["HF_HIDE_EMPLOYER"] = "1"  # the scrub tests check the optional hide mode
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from plan import __main__ as cli, common, llm, scoring, step3_needs, step4_interview, step5_actions  # noqa: E402

HERE = os.path.dirname(__file__)
SAMPLE = os.path.join(HERE, "..", "examples", "research_sample.json")
STEPS12_EMPTY = json.loads('{"goal": {"target_name": "Boris Jabes", "deadline": "2026-11-20", "meet": "reply, call or in-person meeting"}, "target_id": {"name": "Boris Jabes"}, "ambiguous_target": false, "candidates": [], "offer_inventory": [{"offer": "Japan market access", "useful_to": "US founders"}, {"offer": "GTM at Microsoft Japan", "useful_to": "Founders selling into large companies"}], "findings": [], "booking_pages": [], "events": [], "email_guess": {"skipped": true, "reason": "no HUNTER_API_KEY and no company domain", "confidence": "low", "method": "none", "evidence_urls": []}, "summary": {"counts_by_dimension": {}, "x_profile": {"skipped": true, "reason": "no X handle for target"}, "instagram": null, "web": null, "podcasts": null, "precedents": null, "mentions": {"web": null, "x": null}}, "events_log": []}')
PROFILE = {"name": "Yu", "background": ["4 years at Microsoft Japan"], "offer_inventory_draft": [{"offer": "Japan market access", "useful_to": "US founders"}]}

SEEN_PROMPTS = []


def fake_call_json(system, user, schema, max_tokens=16000):
    SEEN_PROMPTS.append(system + user)
    keys = set(schema["properties"])
    if "needs" in keys:
        return {"persona": "Data infra founder turned YC partner.",
                "needs": [
                    {"type": "idea", "hypothesis": "Wants strong AI infra founders", "evidence": ["f1", "f999"], "counter_signal": "none", "confidence": 0.8},
                    {"type": "bogus", "hypothesis": "x", "evidence": [], "counter_signal": "", "confidence": 0.5},
                    {"type": "network", "hypothesis": "Wants data teams", "evidence": ["f2"], "counter_signal": "", "confidence": 1.7}],
                "availability": {"timezone_guess": "Taipei tonight", "booking_page_url": "", "windows": [{"when": "tonight", "why": "office hours", "evidence": ["f4", "zz"]}], "summary": "At the event tonight"},
                "gift_ideas": [{"item": "book", "cost_jpy": -5, "note": "n", "evidence": []}]}
    if "questions" in keys:
        return {"questions": [{"question": f"Q{i}?", "why": "w", "need_id": "n1", "evidence": ["f4"], "answer_chips": ["Yes", "No"]} for i in range(5)]}
    if "matches" in keys:
        return {"offer_inventory": [{"offer": "Ex-Microsoft GTM know-how", "proof_url": "", "strength": 9, "source": "profile"}],
                "matches": [{"need_id": "n1", "offer": "Japan access", "match": 0.7, "reason": "r"}, {"need_id": "nX", "offer": "o", "match": 1, "reason": ""}]}
    if "actions" in keys:
        return {"actions": [
                    {"type": "event", "title": "Talk to him at the hackathon tonight", "how": ["go"], "channel_url": "https://luma.com/compiled-poy7",
                     "base_rate": 0.9, "m_relevance": 3, "m_timing": 1.5, "m_warmth": 1, "m_channel": 1.2, "reasons": {"base_rate": "", "m_relevance": "", "m_timing": "", "m_warmth": "", "m_channel": ""},
                     "cost_jpy": 0, "hours": 2, "days_to_outcome": 0, "evidence": ["f4"], "need_id": "n1", "draft": "Hi Boris, I spent 4 years at Microsoft."},
                    {"type": "cold_email", "title": "Cold email", "how": [], "channel_url": "", "base_rate": 0.05, "m_relevance": 2, "m_timing": 1.5, "m_warmth": 5, "m_channel": 1.5,
                     "reasons": {}, "cost_jpy": 0, "hours": 0.5, "days_to_outcome": 3, "evidence": ["nope"], "need_id": "n9", "draft": ""},
                    {"type": "paid_intro", "title": "Paid intro", "how": [], "channel_url": "", "base_rate": 0.3, "m_relevance": 1, "m_timing": 1, "m_warmth": 1, "m_channel": 1,
                     "reasons": {}, "cost_jpy": 50000, "hours": 1, "days_to_outcome": 0, "evidence": ["f1"], "need_id": "", "draft": ""},
                    {"type": "teleport", "title": "x", "evidence": []}],
                "sequence": [{"action_index": 0, "when": "now"}, {"action_index": 3, "when": "never"}, {"action_index": 1, "when": "after"}],
                "summary": "Go to the event."}
    raise AssertionError(f"unexpected schema {keys}")


class PlanTests(unittest.TestCase):
    def setUp(self):
        self._orig = llm.call_json
        llm.call_json = fake_call_json
        SEEN_PROMPTS.clear()
        common.EVENTS.clear()

    def tearDown(self):
        llm.call_json = self._orig

    def run_all(self, answers=("Yes", "", "No")):
        state = common.normalize_state(common.read_json(SAMPLE))
        with redirect_stdout(io.StringIO()):
            state = step3_needs.run(state, PROFILE)
            state = step4_interview.run(state, PROFILE, answers=list(answers))
            state = step5_actions.run(state, PROFILE)
        return state

    def test_step3_cleans_model_output(self):
        s = self.run_all()
        self.assertEqual([n["type"] for n in s["needs"]], ["network", "idea"])  # bogus dropped, sorted by confidence
        self.assertEqual(s["needs"][0]["confidence"], 1.0)  # clamped
        idea = next(n for n in s["needs"] if n["type"] == "idea")
        self.assertEqual(idea["evidence"], ["f1"])  # invented id f999 dropped
        self.assertEqual(s["availability"]["windows"][0]["evidence"], ["f4"])
        self.assertEqual(s["gift_ideas"][0]["cost_jpy"], 0)

    def test_step4_max_three_questions_and_matching(self):
        s = self.run_all()
        self.assertEqual(len(s["interview"]), 3)
        self.assertEqual([q["answer"] for q in s["interview"]], ["Yes", "", "No"])
        self.assertEqual(s["offer_inventory"][0]["strength"], 3)
        n1 = next(n for n in s["needs"] if n["id"] == "n1")
        self.assertEqual(n1["match"], 0.7)

    def test_step5_scoring_in_code(self):
        s = self.run_all()
        types = [a["type"] for a in s["actions"]]
        self.assertNotIn("teleport", types)
        ev = next(a for a in s["actions"] if a["type"] == "event")
        # base clamped to 0.25, relevance to 2.0: 0.25*2*1.5*1*1.2 = 0.9
        self.assertAlmostEqual(ev["p"], 0.9)
        ce = next(a for a in s["actions"] if a["type"] == "cold_email")
        # invented evidence removed -> no boosts: 0.05*1*1*1*1
        self.assertAlmostEqual(ce["p"], 0.05)
        self.assertFalse(ce["fits_deadline"])  # 3 days, deadline today
        pi = next(a for a in s["actions"] if a["type"] == "paid_intro")
        self.assertFalse(pi["fits_budget"])
        self.assertAlmostEqual(s["p_total"], 0.9)  # only the event fits deadline and budget
        self.assertEqual(s["actions"][0]["type"], "event")
        self.assertEqual([x["action_id"] for x in s["sequence"]], ["a1", next(a["id"] for a in s["actions"] if a["type"] == "cold_email")])
        self.assertEqual(ce["need_id"], "")

    def test_former_employer_never_reaches_model_or_output(self):
        s = self.run_all()
        for p in SEEN_PROMPTS:
            self.assertNotIn("microsoft", p.lower())
        self.assertFalse(common.contains_employer(s["actions"]))
        self.assertFalse(common.contains_employer(s["offer_inventory"]))

    def test_floor_is_one_percent(self):
        a = scoring.score_action({"type": "post_and_mention", "base_rate": 0.0001, "m_channel": 0.3, "evidence": ["f1"]})
        self.assertEqual(a["p"], 0.01)
        self.assertEqual(scoring.pct(0.004), "1%")

    def test_total_chance(self):
        acts = [{"p": 0.5}, {"p": 0.5}, {"p": 0.9, "fits_deadline": False}]
        self.assertAlmostEqual(scoring.total_chance(acts), 0.75)

    def test_cli_end_to_end_writes_files(self):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "plan.json")
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = cli.main([SAMPLE, "--out", out, "--answers", "Yes|No|Maybe", "--consent", "no"])
            self.assertEqual(rc, 0, buf.getvalue())
            with open(out, encoding="utf-8") as f:
                data = json.load(f)
            self.assertIn("p_total", data)
            self.assertTrue(data["events_log"])
            with open(os.path.join(d, "plan.md"), encoding="utf-8") as f:
                md = f.read()
            self.assertIn("Chance of reaching them", md)
            self.assertNotIn("Microsoft", md)

    def test_bom_and_missing_ids(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "r.json")
            with open(p, "w", encoding="utf-8-sig") as f:
                json.dump({"goal": {"target_name": "X"}, "findings": [{"claim": "a"}, {"claim": "b", "id": "q"}]}, f)
            s = common.normalize_state(common.read_json(p))
            self.assertEqual([f["id"] for f in s["findings"]], ["f1", "q"])
            self.assertEqual(s["goal"]["target"], "X")

    def test_days_until(self):
        self.assertTrue(0 < common.days_until("tonight") <= 1)  # time left today
        self.assertIsNone(common.days_until("someday"))
        self.assertLess(common.days_until("2000-01-01"), 0)  # passed deadline is negative
        self.assertIsInstance(common.days_until("2099-01-01T22:45:00+08:00"), float)


if __name__ == "__main__":
    unittest.main()


class RobustnessTests(unittest.TestCase):
    """Cases found by the review agent; each pins a root-cause fix."""

    def setUp(self):
        self._orig = llm.call_json
        llm.call_json = fake_call_json
        common.EVENTS.clear()

    def tearDown(self):
        llm.call_json = self._orig

    def test_odd_input_types_do_not_crash(self):
        s = common.normalize_state({"goal": "meet Boris", "target_id": "boris", "events_log": None,
                                    "findings": [{"claim": "a", "confidence": "high"}, {"claim": "b", "confidence": "80%"}, "junk"]})
        self.assertEqual(s["goal"]["target_name"], "meet Boris")
        self.assertEqual([f["confidence"] for f in s["findings"]], [0.0, 0.8])
        self.assertEqual(s["events_log"], [])
        common.findings_for_prompt(s)

    def test_answers_and_offers_are_scrubbed(self):
        state = common.normalize_state(common.read_json(SAMPLE))
        state["offer_inventory"] = [{"offer": "GTM at Microsoft Japan"}]
        state = common.normalize_state(state)
        self.assertFalse(common.contains_employer(state))
        with redirect_stdout(io.StringIO()):
            state = step3_needs.run(state, PROFILE)
            state = step4_interview.run(state, PROFILE, answers=["I was at Microsoft Japan", "日本マイクロソフトにいた", ""])
        self.assertFalse(common.contains_employer(state["interview"]))

    def test_budget_as_string_is_enforced(self):
        state = common.normalize_state(common.read_json(SAMPLE))
        state["goal"]["budget_jpy"] = "30,000"
        with redirect_stdout(io.StringIO()):
            state = step5_actions.run(step3_needs.run(state, PROFILE), PROFILE)
        pi = next(a for a in state["actions"] if a["type"] == "paid_intro")
        self.assertFalse(pi["fits_budget"])

    def test_zero_total_shows_zero(self):
        self.assertEqual(scoring.pct(0), "0%")

    def test_passed_deadline_counts_nothing(self):
        a = scoring.score_action({"type": "event", "evidence": ["f1"], "days_to_outcome": 0}, days_left=-1)
        self.assertFalse(a["fits_deadline"])

    def test_real_steps12_output_runs(self):
        # Inline copy of an empty Steps 0-2 run (findings: []), with an employer-naming offer the output must scrub.
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "research.json")
            with open(p, "w", encoding="utf-8") as f:
                json.dump(STEPS12_EMPTY, f)
            out = os.path.join(d, "plan.json")
            with redirect_stdout(io.StringIO()):
                rc = cli.main([p, "--out", out, "--no-interview", "--consent", "no"])
            self.assertEqual(rc, 0)
            with open(out, encoding="utf-8") as f:
                self.assertFalse(common.contains_employer(json.load(f)))

    def test_error_keeps_partial_output(self):
        def boom(*a, **k):
            raise llm.LLMError("HTTP 401: bad key")
        llm.call_json = boom
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "plan.json")
            with redirect_stdout(io.StringIO()):
                rc = cli.main([SAMPLE, "--out", out, "--no-interview", "--consent", "no"])
            self.assertEqual(rc, 2)
            self.assertTrue(os.path.isfile(out))


class CopilotReviewTests(unittest.TestCase):
    """Cases from the GPT 6.1 review; each pins a root-cause fix."""

    def test_timeout_not_retried(self):  # a retry doubled the stall on Step 3 (live run)
        calls = []
        orig_open, orig_sleep = llm.urllib.request.urlopen, llm.time.sleep
        def slow(*a, **k):
            calls.append(1)
            raise TimeoutError("timed out")
        llm.urllib.request.urlopen, llm.time.sleep = slow, lambda s: None
        os.environ["ANTHROPIC_API_KEY"] = os.environ.get("ANTHROPIC_API_KEY") or "test"
        try:
            with self.assertRaises(llm.LLMError):
                llm._post({})
        finally:
            llm.urllib.request.urlopen, llm.time.sleep = orig_open, orig_sleep
        self.assertEqual(len(calls), 1)

    def test_settings_read_at_call_time(self):
        self.assertEqual(llm._effort(), "low")  # default: fast enough that Step 3 doesn't stall
        os.environ["HF_EFFORT"] = "high"
        try:
            self.assertEqual(llm._effort(), "high")
        finally:
            del os.environ["HF_EFFORT"]

    def test_utf16_files(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "r.json")
            with open(p, "w", encoding="utf-16") as f:
                f.write('{"goal": {"target_name": "B"}}')
            self.assertEqual(common.read_json(p)["goal"]["target_name"], "B")

    def test_malformed_model_output_is_an_error(self):
        schema = step5_actions.SCHEMA
        for bad in (None, {}, [], {"actions": 1, "sequence": [], "summary": ""}):
            with self.assertRaises(llm.LLMError):
                llm._checked(bad, schema)

    def test_budget_is_cumulative(self):
        acts = [scoring.score_action({"type": "paid_consult", "base_rate": 0.6, "cost_jpy": 30000, "evidence": ["f1"]}, 5, 30000),
                scoring.score_action({"type": "paid_consult", "base_rate": 0.6, "cost_jpy": 30000, "evidence": ["f1"]}, 5, 30000)]
        self.assertAlmostEqual(scoring.total_chance(acts, 30000), 0.6)
        self.assertEqual(sorted(a["in_total"] for a in acts), [False, True])

    def test_no_half_day_allowance(self):
        a = scoring.score_action({"type": "event", "evidence": ["f1"], "days_to_outcome": 0.4}, days_left=0.1)
        self.assertFalse(a["fits_deadline"])

    def test_non_finite_numbers(self):
        for x in ("NaN", "inf", float("nan"), float("inf"), 10 ** 400):
            self.assertEqual(common.num(x), 0.0)

    def test_keys_scrubbed_urls_kept(self):
        out = common.scrub({"Microsoft note": "https://devblogs.microsoft.com/x", "t": "at Microsoft"})
        self.assertEqual(out["a global big-tech company note"], "https://devblogs.microsoft.com/x")
        self.assertNotIn("Microsoft", out["t"])

    def test_out_md_does_not_overwrite_json(self):
        llm_orig = llm.call_json
        llm.call_json = fake_call_json
        try:
            with tempfile.TemporaryDirectory() as d:
                out = os.path.join(d, "result.md")
                with redirect_stdout(io.StringIO()):
                    cli.main([SAMPLE, "--out", out, "--no-interview", "--consent", "no"])
                with open(out, encoding="utf-8") as f:
                    json.load(f)
                self.assertTrue(os.path.isfile(os.path.join(d, "result.report.md")))
        finally:
            llm.call_json = llm_orig


class BookingLiveTests(unittest.TestCase):
    def setUp(self):
        self._orig = llm.call_json
        common.EVENTS.clear()

    def tearDown(self):
        llm.call_json = self._orig

    def _run(self, booking_pages):
        def fake(system, user, schema, max_tokens=16000):
            if "actions" in schema["properties"]:
                return {"actions": [{"type": "booking_page", "title": "Book his Calendly", "how": [], "channel_url": "https://calendly.com/x",
                                     "base_rate": 0.7, "m_relevance": 1.5, "m_timing": 1, "m_warmth": 1, "m_channel": 1.5, "reasons": {},
                                     "cost_jpy": 0, "hours": 1, "days_to_outcome": 0, "evidence": ["f1"], "need_id": "", "draft": ""}],
                        "sequence": [], "summary": ""}
            return fake_call_json(system, user, schema, max_tokens)
        llm.call_json = fake
        state = common.normalize_state(common.read_json(SAMPLE))
        state["booking_pages"] = booking_pages
        with redirect_stdout(io.StringIO()):
            return step5_actions.run(step3_needs.run(state, PROFILE), PROFILE)

    def test_unverified_booking_page_is_capped(self):
        s = self._run([{"url": "https://calendly.com/x", "platform": "calendly", "verified_name": True}])
        self.assertLessEqual(s["actions"][0]["p"], 0.15)  # only route: 15% cap
        self.assertIn("unverified", s["actions"][0]["title"])

    def test_live_booking_page_keeps_score(self):
        s = self._run([{"url": "https://calendly.com/x", "live": True}])
        self.assertGreater(s["actions"][0]["p"], 0.5)

    def test_profile_active_but_no_slots_is_capped(self):
        s = self._run([{"url": "https://calendly.com/x", "live": False, "profile_active": True, "active": True,
                        "event_types": ["Personal"], "live_check": "api", "slots_confirmed": False}])
        a = [x for x in s["actions"] if "calendly" in x["channel_url"]][0]
        self.assertLessEqual(a["p"], 0.15)

    def test_booking_url_under_other_type_is_capped(self):
        orig = llm.call_json
        def fake(system, user, schema, max_tokens=16000):
            out = orig(system, user, schema, max_tokens)
            if "actions" in schema["properties"]:
                out["actions"][0]["type"] = "cold_dm"
            return out
        llm.call_json = fake
        try:
            s = self._run([{"url": "https://calendly.com/x", "live": False}])
        finally:
            llm.call_json = orig
        a = [x for x in s["actions"] if "calendly" in x["channel_url"]][0]
        self.assertLessEqual(a["p"], 0.15)


class EmployerShownByDefaultTests(unittest.TestCase):
    def test_default_keeps_employer(self):
        os.environ.pop("HF_HIDE_EMPLOYER", None)
        try:
            self.assertEqual(common.scrub("4 years at Microsoft Japan"), "4 years at Microsoft Japan")
            self.assertIn("past employer may be named", common.SHARED_RULES)
        finally:
            os.environ["HF_HIDE_EMPLOYER"] = "1"


class EmploymentStatusTests(unittest.TestCase):
    def test_status_words_flagged(self):
        self.assertEqual(common.employment_status_words("fellow Microsoft alum here, ex-Microsoft founder"), ["Microsoft alum", "ex-Microsoft"])
        self.assertEqual(common.employment_status_words("I spent 4 years in Azure GTM at Microsoft."), [])


class ConsentTests(unittest.TestCase):
    def tearDown(self):
        common.CONSENT.clear()
        common.CONSENT["given"] = False

    def test_rules_follow_consent(self):
        self.assertIn("never call the user ex-", common.rules())
        common.CONSENT["given"] = True
        self.assertIn("consented", common.rules())
        self.assertIn("only as the profile states it", common.rules())

    def test_cli_consent_flag_recorded(self):
        orig = llm.call_json
        llm.call_json = fake_call_json
        try:
            with tempfile.TemporaryDirectory() as d:
                out = os.path.join(d, "plan.json")
                with redirect_stdout(io.StringIO()):
                    cli.main([SAMPLE, "--out", out, "--no-interview", "--consent", "yes"])
                with open(out, encoding="utf-8") as f:
                    self.assertTrue(json.load(f)["consent"]["given"])
        finally:
            llm.call_json = orig


class ConsentStatusTests(unittest.TestCase):
    def tearDown(self):
        common.CONSENT.clear()
        common.CONSENT["given"] = False

    def test_consent_without_status_still_guards_status(self):
        common.CONSENT.update(given=True, status_known=False)
        self.assertIn("does not say whether", common.rules())
        self.assertEqual(common.employment_status_words("your piece on leaving Microsoft for a startup"), ["leaving Microsoft"])
        self.assertFalse(common.profile_states_status({"name": "Yu"}))
        self.assertTrue(common.profile_states_status({"employment_status": "left in 2026"}))

    def test_consent_with_status_is_open(self):
        common.CONSENT.update(given=True, status_known=True)
        self.assertNotIn("does not say whether", common.rules())
