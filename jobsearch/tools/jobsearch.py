#!/usr/bin/env python3
"""Job-search toolkit CLI: application tracker, resume renderer, form cheat sheet.

Deterministic companion to the /job-* slash commands in .claude/commands/.
All data lives inside the jobsearch/ directory; paths resolve from any cwd.

Subcommands:
  add      Add an application to the tracker
  set      Update an application's status / url / folder (logs history)
  note     Append a note to an application's history
  list     Show the pipeline (active apps by default)
  show     Show one application in full, including history
  next     Suggest what needs action (apply, follow up, prep)
  sheet    Print a copy-paste cheat sheet for filling application forms
  render   Render a resume YAML to print-ready HTML + ATS plain text
"""

import argparse
import html as htmllib
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip3 install pyyaml")

ROOT = Path(__file__).resolve().parent.parent
TRACKER_PATH = ROOT / "tracker.json"
PROFILE_PATH = ROOT / "profile" / "profile.yaml"
ANSWERS_PATH = ROOT / "profile" / "answers.yaml"
JOBS_DIR = ROOT / "jobs"
OUT_DIR = ROOT / "out"

STATUSES = ("found", "tailored", "applied", "interview", "offer", "rejected", "archived")
ACTIVE_STATUSES = ("found", "tailored", "applied", "interview", "offer")
FOLLOWUP_AFTER_DAYS = 7
TEMPLATE_MARKER = "STATUS: TEMPLATE"


# ---------------------------------------------------------------- tracker ---

def load_tracker():
    if TRACKER_PATH.exists():
        return json.loads(TRACKER_PATH.read_text())
    return {"next_id": 1, "applications": []}


def save_tracker(tracker):
    TRACKER_PATH.write_text(json.dumps(tracker, indent=2, ensure_ascii=False) + "\n")


def today():
    return date.today().isoformat()


def find_app(tracker, app_id):
    for app in tracker["applications"]:
        if app["id"] == app_id:
            return app
    sys.exit(f"No application with id {app_id}. Run `list --all` to see ids.")


def log_history(app, status, note=""):
    app["history"].append({"date": today(), "status": status, "note": note})
    app["updated"] = today()


def cmd_add(args):
    tracker = load_tracker()
    app = {
        "id": tracker["next_id"],
        "company": args.company,
        "role": args.role,
        "url": args.url or "",
        "folder": args.folder or "",
        "status": args.status,
        "created": today(),
        "updated": today(),
        "history": [],
    }
    log_history(app, args.status, args.note or "added")
    tracker["next_id"] += 1
    tracker["applications"].append(app)
    save_tracker(tracker)
    print(f"Added #{app['id']}: {app['company']} — {app['role']} [{app['status']}]")


def cmd_set(args):
    tracker = load_tracker()
    app = find_app(tracker, args.id)
    if args.status:
        app["status"] = args.status
    if args.url:
        app["url"] = args.url
    if args.folder:
        app["folder"] = args.folder
    log_history(app, app["status"], args.note or "")
    save_tracker(tracker)
    print(f"#{app['id']} {app['company']} — {app['role']} is now [{app['status']}]")


def cmd_note(args):
    tracker = load_tracker()
    app = find_app(tracker, args.id)
    log_history(app, app["status"], args.text)
    save_tracker(tracker)
    print(f"Noted on #{app['id']} {app['company']}: {args.text}")


def _table(rows, headers):
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    print(line)
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))


def cmd_list(args):
    tracker = load_tracker()
    apps = tracker["applications"]
    if args.status:
        apps = [a for a in apps if a["status"] == args.status]
    elif not args.all:
        apps = [a for a in apps if a["status"] in ACTIVE_STATUSES]
    if not apps:
        print("No applications to show. Add one with: add <company> <role>")
        return
    apps = sorted(apps, key=lambda a: a["updated"], reverse=True)
    _table(
        [(a["id"], a["company"], a["role"], a["status"], a["updated"]) for a in apps],
        ["ID", "COMPANY", "ROLE", "STATUS", "UPDATED"],
    )


def cmd_show(args):
    tracker = load_tracker()
    app = find_app(tracker, args.id)
    for key in ("id", "company", "role", "status", "url", "folder", "created", "updated"):
        if app.get(key):
            print(f"{key:8} {app[key]}")
    print("history:")
    for h in app["history"]:
        note = f" — {h['note']}" if h.get("note") else ""
        print(f"  {h['date']} [{h['status']}]{note}")


def _days_since(iso):
    return (date.today() - date.fromisoformat(iso)).days


def cmd_next(args):
    tracker = load_tracker()
    actions = []
    for app in tracker["applications"]:
        label = f"#{app['id']} {app['company']} — {app['role']}"
        stale = _days_since(app["updated"])
        if app["status"] in ("found", "tailored"):
            verb = "Tailor materials and apply" if app["status"] == "found" else "Submit the application"
            actions.append((0 if stale >= 3 else 1, f"{label}: {verb} (sitting for {stale}d)"))
        elif app["status"] == "applied" and stale >= FOLLOWUP_AFTER_DAYS:
            actions.append((0, f"{label}: Follow up — applied {stale}d ago with no movement (/job-followup {app['id']})"))
        elif app["status"] == "interview":
            actions.append((0, f"{label}: Prep for interview — review notes.md and STAR stories"))
        elif app["status"] == "offer":
            actions.append((0, f"{label}: Offer on the table — evaluate / negotiate"))
    if not actions:
        print("Nothing urgent. Find new postings with /job-find.")
        return
    for _, text in sorted(actions):
        print(f"- {text}")


# ----------------------------------------------------------------- loaders ---

def load_yaml(path):
    if not path.exists():
        sys.exit(f"Missing file: {path}")
    data = yaml.safe_load(path.read_text()) or {}
    return data


def is_template(path):
    return path.exists() and TEMPLATE_MARKER in path.read_text()


# ------------------------------------------------------------------- sheet ---

def _kv(label, value):
    if value not in (None, "", []):
        print(f"- **{label}:** {value}")


def cmd_sheet(args):
    """Copy-paste cheat sheet for the repetitive fields on application forms."""
    profile = load_yaml(PROFILE_PATH)
    answers = load_yaml(ANSWERS_PATH) if ANSWERS_PATH.exists() else {}
    if is_template(PROFILE_PATH):
        print("(profile.yaml is still the unfilled template — run /job-setup first)\n", file=sys.stderr)

    basics = profile.get("basics", {})
    print("# Application form cheat sheet\n")
    print("## Identity & contact")
    _kv("Full name", basics.get("name"))
    _kv("Email", basics.get("email"))
    _kv("Phone", basics.get("phone"))
    _kv("Location", basics.get("location"))
    for link in basics.get("links", []) or []:
        _kv(link.get("label", "Link"), link.get("url"))

    logistics = answers.get("logistics") or {}
    if any(v not in (None, "", []) for v in logistics.values()):
        print("\n## Logistics")
        _kv("Work authorization", logistics.get("work_authorization"))
        _kv("Needs visa sponsorship", logistics.get("visa_sponsorship_needed"))
        _kv("Willing to relocate", logistics.get("willing_to_relocate"))
        _kv("Remote preference", logistics.get("remote_preference"))
        _kv("Earliest start date", logistics.get("earliest_start"))
        _kv("Notice period", logistics.get("notice_period"))
        _kv("Salary expectation", logistics.get("salary_expectation"))
        _kv("How did you hear about us", logistics.get("how_heard"))

    if profile.get("education"):
        print("\n## Education")
        for edu in profile["education"]:
            dates = date_range(edu.get("start"), edu.get("end"))
            print(f"- {edu.get('school', '')} — {edu.get('degree', '')} ({dates})")
            for d in edu.get("details", []) or []:
                print(f"  - {d}")

    if profile.get("experience"):
        print("\n## Employment history (most recent first)")
        for job in profile["experience"]:
            dates = date_range(job.get("start"), job.get("end"))
            loc = f", {job['location']}" if job.get("location") else ""
            print(f"- {job.get('title', '')} at {job.get('company', '')}{loc} ({dates})")

    answered = [qa for qa in answers.get("questions") or [] if qa.get("a")]
    if answered:
        print("\n## Saved answers")
        for qa in answered:
            print(f"\n**Q: {qa.get('q', '')}**\n\n{qa['a']}")

    refs = answers.get("references") or []
    if refs:
        print("\n## References (confirm with them before sharing)")
        for r in refs:
            _kv(r.get("name", ""), f"{r.get('relationship', '')} — {r.get('contact', '')}")


# ------------------------------------------------------------------ render ---

def fmt_date(value):
    if value in (None, ""):
        return ""
    if isinstance(value, datetime):
        return value.strftime("%b %Y")
    if isinstance(value, date):
        return value.strftime("%b %Y")
    s = str(value).strip()
    if s.lower() in ("present", "current", "now"):
        return "Present"
    m = re.fullmatch(r"(\d{4})-(\d{1,2})(?:-\d{1,2})?", s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), 1).strftime("%b %Y")
    return s


def date_range(start, end):
    start_s, end_s = fmt_date(start), fmt_date(end)
    if start_s and end_s:
        return f"{start_s} – {end_s}"
    return start_s or end_s


def esc(value):
    return htmllib.escape(str(value), quote=True)


RESUME_CSS = """
  @page { size: letter; margin: 0.55in 0.6in; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
         color: #1a1a1a; font-size: 10.5pt; line-height: 1.4;
         max-width: 7.4in; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 20pt; margin: 0; letter-spacing: 0.5px; }
  .headline { font-size: 11pt; color: #333; margin-top: 2pt; }
  .contact { color: #444; font-size: 9.5pt; margin-top: 4pt; }
  .contact a { color: #444; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 1.4px;
       border-bottom: 1px solid #aaa; padding-bottom: 2pt; margin: 13pt 0 6pt; }
  .entry { margin-bottom: 8pt; page-break-inside: avoid; }
  .row { display: flex; justify-content: space-between; align-items: baseline; }
  .title { font-weight: 600; }
  .dates { color: #444; font-size: 9.5pt; white-space: nowrap; padding-left: 14pt; }
  .sub { color: #444; font-size: 9.5pt; font-style: italic; }
  ul { margin: 3pt 0 0; padding-left: 16pt; }
  li { margin-bottom: 2.5pt; }
  p { margin: 0; }
  .skill { margin-bottom: 2pt; }
  @media print { body { padding: 0; } a { text-decoration: none; } }
"""


def _entry_html(title, dates, sub_left="", sub_right="", bullets=None):
    out = ['<div class="entry">']
    out.append(f'<div class="row"><span class="title">{title}</span>'
               f'<span class="dates">{esc(dates)}</span></div>')
    if sub_left or sub_right:
        out.append(f'<div class="row sub"><span>{sub_left}</span><span>{esc(sub_right)}</span></div>')
    if bullets:
        out.append("<ul>" + "".join(f"<li>{esc(b)}</li>" for b in bullets) + "</ul>")
    out.append("</div>")
    return "".join(out)


def render_html(profile):
    basics = profile.get("basics", {})
    parts = []

    contact_bits = [esc(x) for x in (basics.get("location"), basics.get("email"), basics.get("phone")) if x]
    for link in basics.get("links", []) or []:
        if link.get("url"):
            label = esc(link.get("label") or link["url"])
            contact_bits.append(f'<a href="{esc(link["url"])}">{label}</a>')

    parts.append(f"<h1>{esc(basics.get('name', ''))}</h1>")
    if basics.get("headline"):
        parts.append(f'<div class="headline">{esc(basics["headline"])}</div>')
    if contact_bits:
        parts.append(f'<div class="contact">{" &nbsp;·&nbsp; ".join(contact_bits)}</div>')

    if profile.get("summary"):
        parts.append("<h2>Summary</h2>")
        parts.append(f"<p>{esc(str(profile['summary']).strip())}</p>")

    if profile.get("skills"):
        parts.append("<h2>Skills</h2>")
        for group in profile["skills"]:
            items = ", ".join(str(i) for i in group.get("items", []) or [])
            parts.append(f'<div class="skill"><strong>{esc(group.get("group", ""))}:</strong> {esc(items)}</div>')

    if profile.get("experience"):
        parts.append("<h2>Experience</h2>")
        for job in profile["experience"]:
            title = f"{esc(job.get('title', ''))} &mdash; {esc(job.get('company', ''))}"
            parts.append(_entry_html(title, date_range(job.get("start"), job.get("end")),
                                     sub_left=esc(job.get("location", "")),
                                     bullets=job.get("bullets")))

    if profile.get("projects"):
        parts.append("<h2>Projects</h2>")
        for proj in profile["projects"]:
            title = esc(proj.get("name", ""))
            if proj.get("url"):
                title = f'<a href="{esc(proj["url"])}">{title}</a>'
            parts.append(_entry_html(title, proj.get("dates", ""), bullets=proj.get("bullets")))

    if profile.get("education"):
        parts.append("<h2>Education</h2>")
        for edu in profile["education"]:
            parts.append(_entry_html(esc(edu.get("school", "")),
                                     date_range(edu.get("start"), edu.get("end")),
                                     sub_left=esc(edu.get("degree", "")),
                                     bullets=edu.get("details")))

    if profile.get("certifications"):
        parts.append("<h2>Certifications</h2>")
        lines = []
        for cert in profile["certifications"]:
            bits = [cert.get("name", "")]
            if cert.get("issuer"):
                bits.append(cert["issuer"])
            if cert.get("year"):
                bits.append(str(cert["year"]))
            lines.append(" — ".join(str(b) for b in bits))
        parts.append("<ul>" + "".join(f"<li>{esc(l)}</li>" for l in lines) + "</ul>")

    if profile.get("extras"):
        parts.append("<h2>Additional</h2>")
        parts.append("<ul>" + "".join(f"<li>{esc(x)}</li>" for x in profile["extras"]) + "</ul>")

    name = esc(basics.get("name", "Resume"))
    return (f"<!DOCTYPE html><html><head><meta charset='utf-8'>"
            f"<title>{name} — Resume</title><style>{RESUME_CSS}</style></head>"
            f"<body>{''.join(parts)}</body></html>\n")


def render_txt(profile):
    """Plain-text version for ATS copy-paste fields."""
    basics = profile.get("basics", {})
    lines = [basics.get("name", ""), basics.get("headline", "")]
    contact = " | ".join(str(x) for x in (basics.get("location"), basics.get("email"), basics.get("phone")) if x)
    links = " | ".join(l.get("url", "") for l in basics.get("links", []) or [] if l.get("url"))
    lines += [contact, links, ""]

    def section(title):
        lines.extend([title.upper(), ""])

    if profile.get("summary"):
        section("Summary")
        lines.extend([str(profile["summary"]).strip(), ""])

    if profile.get("skills"):
        section("Skills")
        for group in profile["skills"]:
            items = ", ".join(str(i) for i in group.get("items", []) or [])
            lines.append(f"{group.get('group', '')}: {items}")
        lines.append("")

    if profile.get("experience"):
        section("Experience")
        for job in profile["experience"]:
            head = f"{job.get('title', '')} | {job.get('company', '')} | {date_range(job.get('start'), job.get('end'))}"
            if job.get("location"):
                head += f" | {job['location']}"
            lines.append(head)
            lines.extend(f"- {b}" for b in job.get("bullets", []) or [])
            lines.append("")

    if profile.get("projects"):
        section("Projects")
        for proj in profile["projects"]:
            head = proj.get("name", "")
            if proj.get("url"):
                head += f" ({proj['url']})"
            lines.append(head)
            lines.extend(f"- {b}" for b in proj.get("bullets", []) or [])
            lines.append("")

    if profile.get("education"):
        section("Education")
        for edu in profile["education"]:
            lines.append(f"{edu.get('degree', '')} | {edu.get('school', '')} | {date_range(edu.get('start'), edu.get('end'))}")
            lines.extend(f"- {d}" for d in edu.get("details", []) or [])
        lines.append("")

    if profile.get("certifications"):
        section("Certifications")
        for cert in profile["certifications"]:
            bits = [str(cert.get(k, "")) for k in ("name", "issuer", "year") if cert.get(k)]
            lines.append("- " + " — ".join(bits))
        lines.append("")

    if profile.get("extras"):
        section("Additional")
        lines.extend(f"- {x}" for x in profile["extras"])
        lines.append("")

    return "\n".join(lines).strip() + "\n"


def cmd_render(args):
    if args.job:
        job_dir = Path(args.job)
        if not job_dir.is_absolute():
            job_dir = (JOBS_DIR / args.job) if (JOBS_DIR / args.job).exists() else Path.cwd() / args.job
        src = job_dir / "resume.yaml"
        out_dir = job_dir
    else:
        src = Path(args.profile) if args.profile else PROFILE_PATH
        out_dir = Path(args.out) if args.out else OUT_DIR
    profile = load_yaml(src)
    out_dir.mkdir(parents=True, exist_ok=True)

    html_path = out_dir / "resume.html"
    txt_path = out_dir / "resume.txt"
    html_path.write_text(render_html(profile))
    txt_path.write_text(render_txt(profile))
    print(f"Wrote {html_path}")
    print(f"Wrote {txt_path}")
    if is_template(src):
        print("Note: source still looks like the unfilled template — run /job-setup.", file=sys.stderr)
    print("PDF: open resume.html in a browser and print → 'Save as PDF'.")


# ------------------------------------------------------------------ export ---

def cmd_export(args):
    """Bundle profile + answers + per-job materials into autofill.json for the
    Chrome extension (jobsearch/extension/)."""
    profile = load_yaml(PROFILE_PATH)
    answers = load_yaml(ANSWERS_PATH) if ANSWERS_PATH.exists() else {}
    tracker = load_tracker()
    basics = profile.get("basics", {}) or {}
    logistics = dict(answers.get("logistics") or {})

    tokens = str(basics.get("name", "")).split()
    name_parts = {
        "first": tokens[0] if tokens else "",
        "last": tokens[-1] if len(tokens) > 1 else "",
        "middle": " ".join(tokens[1:-1]) if len(tokens) > 2 else "",
    }

    links = {}
    for link in basics.get("links", []) or []:
        if link.get("url"):
            links[link.get("label", "Link")] = link["url"]

    auth = str(logistics.get("work_authorization", "")).lower()
    logistics["authorized_us"] = bool(auth) and not any(k in auth for k in ("visa", "sponsor", "not auth"))
    sponsor = str(logistics.get("visa_sponsorship_needed", "")).strip().lower()
    logistics["sponsorship_needed"] = sponsor.startswith("y") if sponsor else None

    education = []
    for edu in profile.get("education", []) or []:
        gpa = ""
        for det in edu.get("details", []) or []:
            m = re.search(r"gpa[:\s]*([0-9.]+(?:\s*/\s*[0-9.]+)?)", str(det), re.I)
            if m:
                gpa = m.group(1)
        education.append({
            "school": edu.get("school", ""),
            "degree": edu.get("degree", ""),
            "start": str(edu.get("start", "") or ""),
            "end": str(edu.get("end", "") or ""),
            "gpa": gpa,
        })

    experience = [{
        "company": j.get("company", ""),
        "title": j.get("title", ""),
        "location": j.get("location", ""),
        "start": str(j.get("start", "") or ""),
        "end": str(j.get("end", "") or ""),
    } for j in profile.get("experience", []) or []]

    repo_root = ROOT.parent
    jobs = []
    for app in tracker["applications"]:
        if app["status"] in ("rejected", "archived") or not app.get("folder"):
            continue
        folder = repo_root / app["folder"]
        cover = (folder / "cover.txt")
        resume_txt = (folder / "resume.txt")
        jobs.append({
            "id": app["id"],
            "company": app["company"],
            "role": app["role"],
            "url": app.get("url", ""),
            "cover": cover.read_text() if cover.exists() else "",
            "resume_txt": resume_txt.read_text() if resume_txt.exists() else "",
        })

    data = {
        "generated": today(),
        "basics": {k: basics.get(k, "") for k in ("name", "headline", "email", "phone", "location")},
        "name_parts": name_parts,
        "links": links,
        "logistics": logistics,
        "education": education,
        "experience": experience,
        "questions": answers.get("questions") or [],
        "jobs": jobs,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "autofill.json"
    out.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {out} ({len(jobs)} application(s) included)")
    if is_template(PROFILE_PATH):
        print("Note: profile still looks like the unfilled template — run /job-setup.", file=sys.stderr)


# -------------------------------------------------------------------- main ---

def main():
    parser = argparse.ArgumentParser(prog="jobsearch.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("add", help="add an application")
    p.add_argument("company")
    p.add_argument("role")
    p.add_argument("--url", default="")
    p.add_argument("--folder", default="", help="path to the jobs/<...> folder for this application")
    p.add_argument("--status", default="found", choices=STATUSES)
    p.add_argument("--note", default="")
    p.set_defaults(func=cmd_add)

    p = sub.add_parser("set", help="update an application")
    p.add_argument("id", type=int)
    p.add_argument("--status", choices=STATUSES)
    p.add_argument("--url")
    p.add_argument("--folder")
    p.add_argument("--note", default="")
    p.set_defaults(func=cmd_set)

    p = sub.add_parser("note", help="append a note to an application")
    p.add_argument("id", type=int)
    p.add_argument("text")
    p.set_defaults(func=cmd_note)

    p = sub.add_parser("list", help="list applications (active by default)")
    p.add_argument("--status", choices=STATUSES)
    p.add_argument("--all", action="store_true")
    p.set_defaults(func=cmd_list)

    p = sub.add_parser("show", help="show one application with history")
    p.add_argument("id", type=int)
    p.set_defaults(func=cmd_show)

    p = sub.add_parser("next", help="what needs action now")
    p.set_defaults(func=cmd_next)

    p = sub.add_parser("sheet", help="print the application-form cheat sheet")
    p.set_defaults(func=cmd_sheet)

    p = sub.add_parser("export", help="write jobsearch/out/autofill.json for the Chrome extension")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("render", help="render resume YAML to HTML + plain text")
    p.add_argument("--job", help="job folder (name under jobsearch/jobs/ or a path) containing resume.yaml")
    p.add_argument("--profile", help="path to a profile/resume YAML (default: master profile)")
    p.add_argument("--out", help="output directory (default: jobsearch/out/)")
    p.set_defaults(func=cmd_render)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
