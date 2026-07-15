#!/usr/bin/env python3
"""
Trinity Dialer — AMD accuracy harness.

Dials a CSV of phone numbers with KNOWN expected labels through Telnyx Call
Control v2, using the exact same `answering_machine_detection` parameter the
live dialer uses. Every dial carries client_state role='amdtest' so the Trinity
webhook records the verbatim AMD result to the calls table and hangs the leg up
immediately (no agent, no conference — agents are entirely out of the loop).

After dialing, it polls Supabase for each call's amd_result + answer/ended
timestamps and prints a per-label accuracy table plus detection-latency
mean / p50 / p95. Nothing here writes application state beyond the throwaway
amdtest calls.

CSV format (header row required):
    phone,expected
    +14155551234,human
    +14155559999,machine
`expected` is normalised: human_residence/human_business/human -> human;
machine/fax/voicemail/vm -> machine. Rows with any other label are scored as
"unknown expected" and excluded from accuracy (still shown in the raw table).

Telnyx AMD result values (verbatim, from the Call Control v2 docs):
    premium detection.ended : human_residence | human_business | machine |
                              silence | fax_detected | not_sure
    standard detection.ended: human | machine | not_sure

Usage:
    export TELNYX_API_KEY=KEY...
    export TELNYX_CONNECTION_ID=...            # the Call Control app id
    export SUPABASE_KEY=sb_secret_...          # PostgREST service key
    # optional:
    export SUPABASE_HOST=eeyblcqghibycgslnxix.supabase.co
    export WH_TOKEN=trinity-2026
    export WEBHOOK_BASE=https://trinity-dialer.onrender.com
    export AMD_TEST_FROM=+1XXXXXXXXXX          # caller id (must be on the conn)

    python amd_test.py --mode premium --csv numbers.csv --repeat 2 --delay 6

Notes:
  * Requires the server's /webhooks/telnyx (role='amdtest' branch) deployed.
  * Concurrency is intentionally low (sequential with --delay) to stay well
    under carrier/AMD rate limits and to keep the test itself from abandoning.
"""
import argparse
import base64
import csv
import json
import os
import sys
import time
import uuid
import urllib.parse
import urllib.request

TELNYX_BASE = "https://api.telnyx.com/v2"

HUMAN_RESULTS = {"human", "human_residence", "human_business"}
MACHINE_RESULTS = {"machine", "fax_detected"}


def amd_class(result):
    if result in HUMAN_RESULTS:
        return "human"
    if result in MACHINE_RESULTS:
        return "machine"
    return "ambiguous"  # silence / not_sure / unknown


def norm_expected(label):
    l = (label or "").strip().lower()
    if l in ("human", "human_residence", "human_business", "person", "live"):
        return "human"
    if l in ("machine", "voicemail", "vm", "fax", "fax_detected", "answering_machine", "amd"):
        return "machine"
    return None


def http_json(method, url, headers, body=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, raw


def enc_client_state(obj):
    # Mirrors server.js enc(): base64(JSON). dec() parses it back on the webhook.
    return base64.b64encode(json.dumps(obj).encode()).decode()


def main():
    ap = argparse.ArgumentParser(description="Trinity AMD accuracy harness")
    ap.add_argument("--mode", required=True, choices=["premium", "detect", "detect_beep", "disabled"],
                    help="answering_machine_detection value to test")
    ap.add_argument("--csv", required=True, help="CSV with columns: phone,expected")
    ap.add_argument("--repeat", type=int, default=1, help="dials per number (default 1)")
    ap.add_argument("--delay", type=float, default=6.0, help="seconds between dials (default 6)")
    ap.add_argument("--from", dest="from_num", default=os.environ.get("AMD_TEST_FROM"),
                    help="caller id (defaults to $AMD_TEST_FROM)")
    ap.add_argument("--wait", type=int, default=90, help="max seconds to wait for results after dialing")
    ap.add_argument("--ring", type=int, default=30, help="ring timeout_secs per dial")
    args = ap.parse_args()

    api_key = os.environ.get("TELNYX_API_KEY")
    conn_id = os.environ.get("TELNYX_CONNECTION_ID")
    sb_host = os.environ.get("SUPABASE_HOST", "eeyblcqghibycgslnxix.supabase.co")
    sb_key = os.environ.get("SUPABASE_KEY")
    wh_token = os.environ.get("WH_TOKEN", "trinity-2026")
    wh_base = os.environ.get("WEBHOOK_BASE", "https://trinity-dialer.onrender.com").rstrip("/")
    if not api_key or not conn_id:
        sys.exit("set TELNYX_API_KEY and TELNYX_CONNECTION_ID")
    if not sb_key:
        sys.exit("set SUPABASE_KEY (needed to read back amd results)")
    if not args.from_num:
        sys.exit("pass --from or set AMD_TEST_FROM (a caller id on the connection)")

    webhook_url = f"{wh_base}/webhooks/telnyx?token={urllib.parse.quote(wh_token)}"
    tx_headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    sb_base = f"https://{sb_host}/rest/v1"
    sb_headers = {"apikey": sb_key, "Authorization": f"Bearer {sb_key}"}

    # Load targets.
    targets = []
    with open(args.csv, newline="") as f:
        for row in csv.DictReader(f):
            phone = (row.get("phone") or row.get("number") or "").strip()
            if not phone:
                continue
            targets.append((phone, (row.get("expected") or "").strip()))
    if not targets:
        sys.exit("no phone numbers in CSV")

    print(f"[amd-test] mode={args.mode} numbers={len(targets)} repeat={args.repeat} "
          f"-> {len(targets) * args.repeat} dials; webhook={wh_base}")

    # ccid -> attempt record
    attempts = {}
    for phone, expected in targets:
        for _ in range(args.repeat):
            cid = str(uuid.uuid4())
            cs = enc_client_state({"role": "amdtest", "cid": cid, "amd": args.mode, "campaignId": None})
            body = {
                "connection_id": conn_id,
                "to": phone,
                "from": args.from_num,
                "timeout_secs": args.ring,
                "answering_machine_detection": args.mode,
                "webhook_url": webhook_url,
                "client_state": cs,
            }
            status, resp = http_json("POST", f"{TELNYX_BASE}/calls", tx_headers, body)
            if status not in (200, 201) or not isinstance(resp, dict):
                print(f"  ! dial failed {phone}: {status} {resp}")
                time.sleep(args.delay)
                continue
            ccid = (resp.get("data") or {}).get("call_control_id")
            if ccid:
                attempts[ccid] = {"cid": cid, "phone": phone, "expected": expected,
                                  "result": None, "answered_at": None, "amd_ended_at": None}
                print(f"  -> dialing {phone} expect={expected or '?'} ccid=...{ccid[-8:]}")
            time.sleep(args.delay)

    if not attempts:
        sys.exit("no calls were placed")

    # Poll Supabase calls table for amd_result per ccid until all resolve / timeout.
    ccids = list(attempts.keys())
    deadline = time.time() + args.wait
    print(f"[amd-test] waiting up to {args.wait}s for {len(ccids)} results...")
    while time.time() < deadline:
        missing = [c for c in ccids if attempts[c]["result"] is None]
        if not missing:
            break
        # PostgREST in.(...) filter; chunk to keep the URL sane.
        for i in range(0, len(missing), 50):
            chunk = missing[i:i + 50]
            inlist = ",".join(f'"{c}"' for c in chunk)
            q = (f"telnyx_call_control_id=in.({inlist})"
                 f"&select=telnyx_call_control_id,amd_result,answered_at,amd_ended_at")
            status, rows = http_json("GET", f"{sb_base}/calls?{q}", sb_headers)
            if status == 200 and isinstance(rows, list):
                for r in rows:
                    cc = r.get("telnyx_call_control_id")
                    a = attempts.get(cc)
                    if a and r.get("amd_result"):
                        a["result"] = r["amd_result"]
                        a["answered_at"] = r.get("answered_at")
                        a["amd_ended_at"] = r.get("amd_ended_at")
        time.sleep(5)

    # Score.
    def iso_ms(s):
        if not s:
            return None
        try:
            from datetime import datetime
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000
        except Exception:
            return None

    total = len(attempts)
    got = [a for a in attempts.values() if a["result"]]
    by_expected = {}   # expected -> {correct, scored, results:{}, latencies:[]}
    latencies = []
    for a in attempts.values():
        exp = norm_expected(a["expected"])
        res = a["result"]
        la = iso_ms(a["answered_at"])
        le = iso_ms(a["amd_ended_at"])
        if la is not None and le is not None and le >= la:
            a["latency_ms"] = round(le - la)
            latencies.append(a["latency_ms"])
        else:
            a["latency_ms"] = None
        bucket = by_expected.setdefault(exp or "unknown",
                                        {"correct": 0, "scored": 0, "results": {}, "lat": []})
        if res:
            bucket["results"][res] = bucket["results"].get(res, 0) + 1
            if a["latency_ms"] is not None:
                bucket["lat"].append(a["latency_ms"])
        if exp and res:
            cls = amd_class(res)
            # ambiguous (silence/not_sure) counts as neither correct nor wrong bucket-wise,
            # but is scored against expected: treat ambiguous as a miss for accuracy.
            bucket["scored"] += 1
            if cls == exp:
                bucket["correct"] += 1

    def pct(n, d):
        return round(100.0 * n / d, 1) if d else 0.0

    def quant(xs, q):
        if not xs:
            return None
        s = sorted(xs)
        return s[min(len(s) - 1, int(q * (len(s) - 1)))]

    print("\n===== AMD ACCURACY REPORT =====")
    print(f"mode={args.mode}  dials={total}  results_received={len(got)}  "
          f"({pct(len(got), total)}% of dials returned an AMD result)\n")
    print(f"{'expected':>10} | {'scored':>6} | {'correct':>7} | {'acc%':>6} | result distribution")
    print("-" * 78)
    for exp in ("human", "machine", "unknown"):
        b = by_expected.get(exp)
        if not b:
            continue
        dist = ", ".join(f"{k}:{v}" for k, v in sorted(b["results"].items(), key=lambda x: -x[1]))
        print(f"{exp:>10} | {b['scored']:>6} | {b['correct']:>7} | {pct(b['correct'], b['scored']):>6} | {dist}")

    tot_scored = sum(b["scored"] for b in by_expected.values())
    tot_correct = sum(b["correct"] for b in by_expected.values())
    print("-" * 78)
    print(f"{'OVERALL':>10} | {tot_scored:>6} | {tot_correct:>7} | {pct(tot_correct, tot_scored):>6} |")

    print("\n----- detection latency (answered_at -> amd_ended_at) -----")
    if latencies:
        print(f"  n={len(latencies)}  mean={round(sum(latencies)/len(latencies))}ms  "
              f"p50={quant(latencies,0.5)}ms  p95={quant(latencies,0.95)}ms  "
              f"min={min(latencies)}ms  max={max(latencies)}ms")
    else:
        print("  no latency samples (need both answered_at and amd_ended_at)")

    unresolved = total - len(got)
    if unresolved:
        print(f"\n  note: {unresolved} dial(s) never returned an AMD result "
              f"(no-answer / busy / ring timeout / webhook not deployed).")


if __name__ == "__main__":
    main()
