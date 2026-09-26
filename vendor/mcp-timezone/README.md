# mcp-timezone

Work with clients in other countries without doing time zone arithmetic in your head. Ask "what time is it for
Maria in Lisbon", "convert 3pm Warsaw to New York and Bangalore", or "find an hour next week that works for me,
my client in New York and my designer in London" and get an answer you can act on: ranked meeting slots where
everyone is inside their own working hours, the exact daily overlap, when the clocks change, how many business
days a delivery date is, and a calendar file you can send. Saved contacts, working hours and nothing else live
as plain JSON on your own machine.

Built by [theluckystrike](https://github.com/theluckystrike).

**In the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.theluckystrike%2Ftimezone-world-clock-meeting-slots-overlap-ics/versions/latest)** (`io.github.theluckystrike/timezone-world-clock-meeting-slots-overlap-ics`).

![timezone demo](../../assets/demo-timezone.gif)

Find a meeting time that works for everyone abroad, convert any time between cities, and write the invite, zero setup, all local.

## 60-second install

npm publish for `@theluckystrike/mcp-timezone` is pending. Until then, the `.mcpb` one-click bundle or a
clone+build is the working path, both are verified below.

One-click (.mcpb): download `timezone.mcpb` from the latest release and double-click it in Claude Desktop:
https://github.com/theluckystrike/mcp-servers/releases/latest

(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "timezone": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-timezone"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add timezone -- npx -y @theluckystrike/mcp-timezone
```

(`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "timezone": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-timezone"]
    }
  }
}
```

The `npx` form above starts working the moment the package is published. Until then, use the .mcpb bundle above,
or build from source with exactly these three commands:

```sh
git clone https://github.com/theluckystrike/mcp-servers.git && cd mcp-servers
npm install
npm run build -w packages/mcp-license -w servers/timezone
```

Then point your client's `command` at `node` with one arg: the absolute path to `servers/timezone/dist/index.js`.

To run in Pro mode set `MCP_LICENSE_KEY` in the same config block, or call `license_activate` once with your key.

## Tools

| Tool | What it does |
| --- | --- |
| `now` | The current time in any list of places, with the zone abbreviation and UTC offset. With no arguments: this machine's zone and UTC. |
| `convert_time` | Convert a time from one place to any number of others. Reads `"2026-09-10 15:00"`, an ISO timestamp, or `"3pm tomorrow"` as wall-clock time in `from_zone`; a trailing `Z` or an explicit offset wins over `from_zone`. Flags a next-day or previous-day result, and states which occurrence it used on a DST fold (`gap`, `fold`). |
| `find_meeting_slots` | Ranked times where every participant is inside their own working hours, on a 30-minute grid, weekends skipped. Ranked by fairness (see below). |
| `overlap` | The daily window when every listed place is at work, in UTC and in each local clock, computed on a real date so DST weeks are honest. |
| `dst_changes` | Every clock change in a place for a year: the exact UTC instant, the offset before and after, and the local time either side. |
| `business_days` | Business days between two dates in a place, excluding weekends and any holidays you pass. Dates are strict: `2026-02-30` is refused, never rolled forward. |
| `ics_create` | Write a `.ics` calendar file for one meeting and return the path. Attendees with an email are invited; a name with no email is listed in the description. `organizer_email` writes the `ORGANIZER` line. |
| `contacts_set` | Remember a client or teammate's zone and working hours. |
| `contacts_list` | Everyone you have saved, their local time now, and whether they are inside working hours. |
| `license_status` | Free or Pro, and where to upgrade. |
| `license_activate` | Activate a Pro key (verified offline). |

Also exposed: the resource `tz://contacts` (saved contacts and their current local time) and the prompt
`schedule_with` (proposes times with saved contacts, then offers to write the invite).

## What you can say

No tool names required.

| You say | Tool |
| --- | --- |
| "What time is it in Warsaw, New York and Bangalore right now?" | `now` |
| "Convert 3pm Warsaw on 10 September to New York and India." | `convert_time` |
| "Find an hour next week for me in Warsaw, my client in New York and my designer in London." | `find_meeting_slots` |
| "When are Warsaw and New York both at work?" | `overlap` |
| "Do the clocks change in Warsaw before our March call?" | `dst_changes` |
| "How many business days from 1 to 30 September, excluding the 15th?" | `business_days` |
| "Write me the .ics for Thursday 3pm Warsaw, 45 minutes, invite maria@acme.com." | `ics_create` |
| "Remember that Maria is in Lisbon and works 10 to 6." | `contacts_set` |
| "Who's awake right now?" | `contacts_list` |

## Worked example

```
You: Find an hour next week for me in Warsaw, my client in New York and my designer in London.

  find_meeting_slots { participants: [{name:"Me",zone:"Warsaw"},{name:"Client",zone:"New York"},
                                     {name:"Designer",zone:"London"}], duration_minutes: 60, days: 5 }

Assistant: 15 slots fit all 3 participants. Best first:
  1. 2026-09-07T13:30:00.000Z  fairness 3.00h
     Me 15:30-16:30 | Client 09:30-10:30 | Designer 14:30-15:30
```

Three hours of fairness is not a flaw in the ranking, it is the truth about Warsaw and New York: with 09:00-17:00
days on both sides the shared window is only 15:00-17:00 Warsaw, so somebody's meeting is always far from the
middle of their day. The score says so instead of hiding it. Widen one person's hours and the score improves.

```
You: Write the invite for that one, 45 minutes, and send it to maria@acme.com.

  ics_create { title:"Kickoff with Acme", start:"2026-09-10 15:00", zone:"Warsaw",
               duration_minutes:45, attendees:[{name:"Maria Nowak", email:"maria@acme.com"}],
               organizer_email:"you@yourdomain.com" }

Assistant: Wrote /Users/you/.local/share/mcp-servers/timezone/meeting.ics
Kickoff with Acme: 2026-09-10 15:00 Thu (CEST, UTC+02:00) for 45 min
DTSTART 2026-09-10T13:00:00.000Z (UTC)
```

## How the ranking works

`find_meeting_slots` scores every candidate by **the worst participant's** distance from 13:00 local, in hours,
and sorts ascending. The worst, not the average, on purpose: a slot that is pleasant for two people and 07:00
for the third must never outrank one that is 10:00 for everybody. A fairness of 0 would mean the meeting sits
at midday for all of them; anything under about 2 is comfortable.

A slot is only offered when the whole meeting, start to end, is inside every participant's working window,
on their own local calendar day. Weekends in the first participant's zone are skipped. No slot ever starts
before `earliest_date`, if you pass a time with it, slots earlier that day are not proposed.

When nothing fits, the server says so, shows the windows, and then lists the closest times that are
somebody's hours, ranked by the total minutes outside, with each person's local time and the
working hours that would make each one fit. On the free tier a search longer than 5 days is shortened to
5 days and the answer says so; it is never refused outright.

## How places are resolved

City and country names resolve through a built-in table of 490 entries (300+ cities, every commonly used
country and US state shorthands). Every entry is verified against
`Intl.supportedValuesOf("timeZone")` at startup; an entry this Node build cannot resolve is dropped with a
line on stderr rather than silently answering with the wrong zone.

- A country that spans several zones maps to its main business zone: United States -> America/New_York,
  Australia -> Australia/Sydney, Canada -> America/Toronto, Brazil -> America/Sao_Paulo, Russia -> Europe/Moscow,
  Mexico -> America/Mexico_City, Indonesia -> Asia/Jakarta. Name a city when you need a different one.
- IANA ids always work and always win: pass `America/Denver` and you get exactly that.
- `UTC+2` style offsets resolve to the matching fixed zone (`Etc/GMT-2`, the Etc signs are inverted by the
  IANA database, not by this server).
- **A fixed abbreviation is an offset, not a place.** `EST` is `Etc/GMT+5` (UTC-05:00) all year, `PST` is
  `Etc/GMT+8`, `CET` is `Etc/GMT-1`, `JST` is `Etc/GMT-9`. Mapping them to a DST-observing zone made `EST`
  mean EDT (UTC-04:00) every summer, an hour wrong for half the year. Each answer carries a note naming the
  place to pass instead (`"New York"`, `"Los Angeles"`, `"Paris"`). The region shorthands `ET`, `CT`, `MT`,
  `PT` still name places and keep their clock changes. `IST` is read as India (UTC+05:30, `Asia/Kolkata`,
  no daylight saving) and the note says so, because IST also names Irish and Israel time.
- An unknown name is **never** guessed. It comes back as an error with suggestions:
  `unknown time zone or place: "Warsawa". Did you mean: warsaw (Europe/Warsaw)?`

DST is not stored here at all. Every offset comes from the ICU data inside your Node build via
`Intl.DateTimeFormat`, so the rules stay current as Node updates instead of going stale in a bundled table.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| `now`, `convert_time`, `overlap`, `dst_changes`, `business_days` | Unlimited | Unlimited |
| `find_meeting_slots` participants | Up to 3 | Unlimited |
| `find_meeting_slots` search window | Up to 5 days (a longer request is shortened, not refused) | Unlimited |
| Recurring-slot search (`recurring: true`) | -- | Yes |
| Saved contacts | 5 | Unlimited |
| `.ics` files | 3 per month | Unlimited |

Pro is $19 one-time, or $39 for every server in the bundle: **[Get Pro](https://mcp.zovo.one/buy/timezone)**.
Activation is offline: keys are Ed25519 signatures verified against a public key compiled into the package.

## How it stores data

Contacts and the monthly `.ics` counter live in one JSON file:
`${XDG_DATA_HOME:-~/.local/share}/mcp-servers/timezone/data.json`.

Every write happens under an advisory lock at `.../timezone/.lock`, held across the whole load-mutate-save
cycle, so two clients sharing one data dir cannot discard each other's contacts. The save writes a temporary
file and renames it into place, so a crash mid-write leaves either the old file or the new one.

If `data.json` is ever unreadable or not valid JSON, the server does **not** treat that as "no contacts yet".
It moves the file aside byte-for-byte as `data.json.corrupt-<timestamp>`, writes a `data.json.corrupt` marker,
and every later call fails with `data file is corrupt; moved to ...; nothing was written` until you restore a
good copy and delete the marker.

## Dates, times and honest caveats

- **A time with no offset is wall-clock time in `from_zone`**, not UTC. `2026-09-10 15:00` with
  `from_zone: "Warsaw"` is 15:00 in Warsaw. A trailing `Z` or an explicit `+05:30` is honoured exactly and
  `from_zone` is then only used for display.
- **A calendar date is validated, not normalised.** `2026-02-30` is refused with the reason (February 2026
  has 28 days) everywhere a date is read: `convert_time`, `overlap`, `business_days`, `ics_create` and the
  holiday list. Nothing is ever rolled forward into March.
- **A wall time inside a spring-forward gap does not exist, and is refused.** `02:30` on 2026-03-29 in
  Warsaw comes back as an error naming both valid neighbours (`2026-03-29 01:30` and `2026-03-29 03:30`).
  Pass `gap:"forward"` to take the time after the jump or `gap:"backward"` for the one before it; the answer
  then says which it used. Guessing silently is how a meeting moves an hour once a year.
- **Ambiguous times in the autumn fold return the FIRST occurrence** and say so: `02:30` on 2026-10-25 in
  Warsaw is `00:30Z`, the CEST reading. Pass `fold:"second"` for `01:30Z`, the CET one. Both answers name
  the abbreviation and offset they used.
- **`.ics` attendees are calendar addresses.** An attendee with an email becomes
  `ATTENDEE;CN="Name";RSVP=TRUE:mailto:addr`, with `CN` written as a quoted RFC 5545 parameter value. A name
  with no email is listed in `DESCRIPTION` instead of being written as an unroutable address. Any CR, LF or
  control character in any field is refused, not escaped away: it is what a content-line injection looks
  like. `organizer_email` writes the `ORGANIZER` line; without it no `ORGANIZER` is written and the answer
  says so, because replies then have nowhere to go.
- **`.ics` files carry UTC times** (`DTSTART:20260910T130000Z`) and no `VTIMEZONE` block. That is deliberate:
  a hand-written `VTIMEZONE` with stale DST rules is the classic way an invite lands an hour off.
- **Working hours are the only calendar this server has.** It does not know about your existing meetings,
  public holidays (pass them to `business_days` yourself) or anyone's lunch. `business_days` says so in
  its own answer when no holiday list is passed, so a "22 business days" figure is never mistaken for a
  public-holiday-adjusted one.
- **Argument sizes are capped**, so a runaway caller cannot turn one call into a hang or a huge reply:
  place and date strings 100 characters, event titles 200, descriptions 5000, up to 50 zones,
  100 participants, 100 attendees, 400 holidays, `days` <= 366, `duration_minutes` <= 1440, and a
  `business_days` range of at most 3700 days (longer ranges are refused, never silently truncated).
- **`out_path` is written where you name it.** `ics_create` resolves a relative path against the
  process working directory and does not confine it to the data directory; an unwritable path returns
  a clean `EACCES` and consumes none of the free monthly quota.
- **Weekend skipping uses the first participant's zone** and the Saturday/Sunday convention. A Friday-Saturday
  weekend is not modelled; set `work_start`/`work_end` or read the dates.

## Troubleshooting

- **`npx` hangs or fails to find the package**: npm publish is pending. Use the `.mcpb` bundle or the
  clone-and-build path above.
- **A city is not recognised**: the error lists suggestions. Any IANA id always works, so
  `America/Argentina/Cordoba` is available even when the city name is not in the table.
- **Node version**: requires Node >= 18. Check with `node -v`. Older builds ship older DST rules.
- **Nothing shows up / silent failures**: this server writes to stderr only, never stdout. In Claude Desktop
  check Settings -> Developer -> the server's log; in Claude Code run with `--mcp-debug`.
- **A Pro key isn't recognized**: run `license_status`, and confirm `MCP_LICENSE_KEY` is set in the process the
  client launches, not just your shell.

## Privacy

All data stays local: contacts live in `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/timezone/data.json`.
The server makes no network requests, has no telemetry and needs no account. Time zone data comes from the
ICU database already inside Node.

## Pairs with

- [mcp-time-tracker](../time-tracker/README.md), track the hours you spend on those clients and report them.
- [mcp-invoice](../invoice/README.md), turn the tracked hours into a numbered PDF invoice for the client abroad.
- [office-suite](../office-suite/README.md), several servers behind one install, one config entry.

## FAQ

Yes, and it does not store any DST rules of its own. Every offset is read from the ICU data in your Node
build, so Warsaw and New York being 5 hours apart (not 6) between 8 and 29 March 2026 falls out correctly.

Because a real overlap can be two hours wide. The fairness score reports the worst person's distance from
their midday so you can see the cost and decide who absorbs it.

Yes. India (+05:30), Nepal (+05:45), Adelaide (+09:30) and Chatham are handled like any other zone; the slot
grid is 30 minutes, so a half-hour zone produces :00 and :30 local starts.

No. It knows only the working hours you give it. It writes `.ics` files; it never reads or connects to a
calendar service.

No. There are no network calls anywhere, including license activation.

## License

MIT

## One business profile for the whole suite

Your identity is stored once, at `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/profile/business.json`,
and every server in the suite reads it: the invoice issuer, the docx letterhead, the recurring
issuer, expense-tracker's default VAT rate, time-tracker's and timezone's home zone, and the
resume and contract letterheads. Set it once with `business_set` (invoice or docx) - you never
repeat it anywhere else. An email address is only ever taken from that profile or from an explicit
argument; when none is stored, documents show `[add: email]` and the tool says so rather than
letting anyone improvise an address.

## Use these docs as an MCP server

Any MCP client (Claude, Cursor, Windsurf, VS Code) can read this repository's documentation directly via GitMCP — no install:

- Docs MCP URL: https://gitmcp.io/theluckystrike/mcp-timezone
